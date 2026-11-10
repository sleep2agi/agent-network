// #2614 —— 事件循环停顿监测 + 慢 SQL 日志的单元测试。
//
// 这两个东西的价值不在“能测出停顿”，而在**停顿发生时留下可对齐的证据**：
// 2026-10-26 生产两次 RSS 3.6/4.5 GB 的尖峰，事后只能靠“日志静默几十秒”
// 手工推断，`/api/stats/routes` 只给出受害者请求（含排队时间）。
// 所以测试要钉住的是语义：怎么算一次停顿、留什么档、日志阈值怎么生效、关闭后还计数。

import { describe, expect, test } from "bun:test";
import {
  eventLoopStats,
  noteRequestServed,
  recordGap,
  resetEventLoopLagForTests,
  startEventLoopLagMonitor,
} from "./event-loop-lag.js";
import { formatSlowSql, slowSqlThresholdMs } from "./db-adapter.js";

describe("event-loop-lag: recordGap", () => {
  test("正常 tick（≈interval）不算停顿", () => {
    resetEventLoopLagForTests();
    expect(recordGap(260, { intervalMs: 250, thresholdMs: 2000 })).toBe(10);
    const s = eventLoopStats();
    expect(s.stall_count).toBe(0);
    expect(s.max_gap_ms).toBe(260);
    expect(s.recent_stalls).toEqual([]);
  });

  test("超过阈值的 tick 记一条停顿，带 stall_ms / rss_mb / at", () => {
    resetEventLoopLagForTests();
    const now = Date.parse("2026-10-26T22:10:41Z");
    const stall = recordGap(28_000, { intervalMs: 250, thresholdMs: 2000, rssMb: 4502, now });
    expect(stall).toBe(27_750);
    const s = eventLoopStats();
    expect(s.stall_count).toBe(1);
    expect(s.last_stall_ms).toBe(27_750);
    expect(s.last_stall_at).toBe("2026-10-26T22:10:41.000Z");
    expect(s.max_gap_ms).toBe(28_000);
    expect(s.recent_stalls[0]).toMatchObject({ gap_ms: 28_000, stall_ms: 27_750, rss_mb: 4502 });
  });

  test("recent_stalls 最新在前，且只保留 20 条", () => {
    resetEventLoopLagForTests();
    for (let i = 0; i < 25; i++) {
      recordGap(5_000 + i, { intervalMs: 250, thresholdMs: 2_000, rssMb: 300, now: 1_700_000_000_000 + i * 1_000 });
    }
    const s = eventLoopStats();
    expect(s.stall_count).toBe(25);
    expect(s.recent_stalls.length).toBe(20);
    // 最新一条是 i=24
    expect(s.recent_stalls[0].gap_ms).toBe(5_024);
    expect(s.recent_stalls[19].gap_ms).toBe(5_005);
  });

  test("记录这段间隔里服务了多少请求（区分“阻塞”与“timer 饥饿”）", () => {
    resetEventLoopLagForTests();
    recordGap(85_000, { intervalMs: 250, thresholdMs: 2_000, rssMb: 2076, served: 137 });
    const s = eventLoopStats();
    expect(s.recent_stalls[0].requests_since_last_tick).toBe(137);
    // 0 服务数 = 这段时间真的什么都没推进
    recordGap(30_000, { intervalMs: 250, thresholdMs: 2_000, rssMb: 500, served: 0 });
    expect(eventLoopStats().recent_stalls[0].requests_since_last_tick).toBe(0);
  });

  test("max_gap_ms 保留历史最大值（回落后不被覆盖）", () => {
    resetEventLoopLagForTests();
    recordGap(47_000, { intervalMs: 250, thresholdMs: 2_000 });
    recordGap(260, { intervalMs: 250, thresholdMs: 2_000 });
    const s = eventLoopStats();
    expect(s.max_gap_ms).toBe(47_000);
    expect(s.last_gap_ms).toBe(260);
  });
});

describe("event-loop-lag: startEventLoopLagMonitor", () => {
  test("阈值 0 时不打日志，但仍然计数", async () => {
    resetEventLoopLagForTests();
    const logs: string[] = [];
    const timer = startEventLoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 0,
      log: (m) => logs.push(m),
      rssMb: () => 123,
    });
    // 同步阻塞 80ms，让下一次 tick 一定超阈值
    const until = performance.now() + 80;
    while (performance.now() < until) { /* spin */ }
    await Bun.sleep(60);
    clearInterval(timer);
    expect(logs).toEqual([]);
    expect(eventLoopStats().max_gap_ms).toBeGreaterThan(0);
  });

  test("真实停顿会打一行 [commhub stall] 且带 rss", async () => {
    resetEventLoopLagForTests();
    const logs: string[] = [];
    const timer = startEventLoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 40,
      log: (m) => logs.push(m),
      rssMb: () => 4502,
      // 这条测的是「停顿怎么打日志」，不是启动尖峰。测试进程刚起来几秒，
      // 不关掉启动宽限的话第一个 tick 会被当成启动尖峰跳过（见 #2721 那组用例）。
      bootGraceMs: 0,
    });
    const until = performance.now() + 120;
    while (performance.now() < until) { /* spin 阻塞事件循环 */ }
    await Bun.sleep(60);
    clearInterval(timer);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toStartWith("[commhub stall] loop idle ~");
    expect(logs[0]).toContain("rss 4502 MB");
    expect(logs[0]).toContain("served 0 req");
  });
});

describe("db-adapter: 慢 SQL 日志", () => {
  test("默认阈值 1000ms；环境变量可调，0 表示关闭", () => {
    const prev = process.env.COMMHUB_SLOW_SQL_MS;
    try {
      delete process.env.COMMHUB_SLOW_SQL_MS;
      expect(slowSqlThresholdMs()).toBe(1000);
      process.env.COMMHUB_SLOW_SQL_MS = "250";
      expect(slowSqlThresholdMs()).toBe(250);
      process.env.COMMHUB_SLOW_SQL_MS = "0";
      expect(slowSqlThresholdMs()).toBe(0);
      process.env.COMMHUB_SLOW_SQL_MS = "not-a-number";
      expect(slowSqlThresholdMs()).toBe(1000);
    } finally {
      if (prev === undefined) delete process.env.COMMHUB_SLOW_SQL_MS;
      else process.env.COMMHUB_SLOW_SQL_MS = prev;
    }
  });

  test("日志压平换行并截断，且不含绑定参数", () => {
    const sql = "DELETE FROM agent_telemetry\n   WHERE created_at < datetime('now', ?1)";
    const line = formatSlowSql(10_588.4, sql);
    expect(line).toStartWith("[commhub slow-sql] 10588ms DELETE FROM agent_telemetry WHERE created_at < datetime('now', ?1)");
    expect(line).not.toContain("\n");
    const long = formatSlowSql(1_200, "SELECT " + "x".repeat(500));
    expect(long.length).toBeLessThanOrEqual("[commhub slow-sql] 1200ms ".length + 160);
  });
});

// #2721 —— **只跳过第一个 tick**。
//
// 事故形状：进程启动后 3 秒记到 gap 2972ms —— 那是「监控开始 → 第一次 tick」被
// 模块加载/开库/迁移占满的时间，度量的是启动耗时，不是线上停顿。
//
// 第一版实现用的是 10 秒**时间窗**，等于监控在前 10 秒什么都不记，
// 把下面那条「阈值 40ms、spin 120ms 应打停顿日志」的既有测试整体吞掉了
// —— 修完 qa.yml 事故、QA 恢复后立刻红。窗口越宽越像「把监控关一会儿」。
describe("#2721 启动尖峰不算停顿（判据：进程 uptime）", () => {
  test("进程刚启动时的第一个 gap 被跳过", async () => {
    resetEventLoopLagForTests();
    const logs: string[] = [];
    const timer = startEventLoopLagMonitor({
      intervalMs: 20, thresholdMs: 40, log: (m) => logs.push(m), rssMb: () => 123,
      bootGraceMs: 15_000, uptimeMs: () => 3_000,   // 模拟「启动后 3 秒」
    });
    const until = performance.now() + 120;
    while (performance.now() < until) { /* spin 落在第一个 tick */ }
    await Bun.sleep(80);
    clearInterval(timer);
    expect(logs).toEqual([]);
  });

  test("进程已经跑了一会儿 ⇒ 第一个 gap 照常记录（不能把监控关掉）", async () => {
    resetEventLoopLagForTests();
    const logs: string[] = [];
    const timer = startEventLoopLagMonitor({
      intervalMs: 20, thresholdMs: 40, log: (m) => logs.push(m), rssMb: () => 123,
      bootGraceMs: 15_000, uptimeMs: () => 600_000,  // 进程跑了 10 分钟
    });
    const until = performance.now() + 120;
    while (performance.now() < until) { /* spin */ }
    await Bun.sleep(80);
    clearInterval(timer);
    expect(logs.length).toBeGreaterThan(0);
  });
});
