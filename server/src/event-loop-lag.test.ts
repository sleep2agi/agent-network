// #2614 —— 事件循环停顿监测 + 慢 SQL 日志的单元测试。
//
// 这两个东西的价值不在“能测出停顿”，而在**停顿发生时留下可对齐的证据**：
// 2026-10-26 生产两次 RSS 3.6/4.5 GB 的尖峰，事后只能靠“日志静默几十秒”
// 手工推断，`/api/stats/routes` 只给出受害者请求（含排队时间）。
// 所以测试要钉住的是语义：怎么算一次停顿、留什么档、日志阈值怎么生效、关闭后还计数。

import { describe, expect, test } from "bun:test";
import {
  eventLoopStats,
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
    });
    const until = performance.now() + 120;
    while (performance.now() < until) { /* spin 阻塞事件循环 */ }
    await Bun.sleep(60);
    clearInterval(timer);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toStartWith("[commhub stall] loop blocked ~");
    expect(logs[0]).toContain("rss 4502 MB");
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
