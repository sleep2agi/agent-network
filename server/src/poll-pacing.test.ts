import { describe, expect, test } from "bun:test";
import { POLL_PACING_NOTE, POLL_NUDGE_THRESHOLD, POLL_RECOMMENDED_SECONDS, createPollPacer } from "./poll-pacing";

// #3001 —— Hub 侧的轮询节奏提示。
// 现场：一个节点在空闲等待里以约 13 次/分钟连续拉了 8 小时 get_task（约 6000 次），
// 每次都是一整轮 LLM。这里钉住三件事：什么时候提示、什么时候**不**提示、提示里说了什么。
describe("#3001 get_task 轮询节奏提示", () => {
  function pacerWithClock() {
    let t = 1_000_000;
    const pacer = createPollPacer({ now: () => t });
    return { pacer, advance: (ms: number) => { t += ms; } };
  }

  test("偶发查询不提示（正常等子任务不会被这句打扰）", () => {
    const { pacer, advance } = pacerWithClock();
    for (let i = 0; i < POLL_NUDGE_THRESHOLD; i++) {
      expect(pacer.record("tok:t1:task-a")).toBeNull();
      advance(3_000);
    }
  });

  test("60 秒内超过阈值才提示，且带次数与建议间隔", () => {
    const { pacer, advance } = pacerWithClock();
    let pacing = null as ReturnType<typeof pacer.record>;
    for (let i = 0; i <= POLL_NUDGE_THRESHOLD; i++) {
      pacing = pacer.record("tok:t1:task-a");
      advance(4_600); // 约 13 次/分钟：实测的失控频率
    }
    expect(pacing).not.toBeNull();
    expect(pacing!.calls_last_60s).toBeGreaterThan(POLL_NUDGE_THRESHOLD);
    expect(pacing!.recommended_interval_seconds).toBe(POLL_RECOMMENDED_SECONDS);
  });

  test("隔一分钟以上再看，计数清零、不再提示（纪律生效后自动安静）", () => {
    const { pacer, advance } = pacerWithClock();
    for (let i = 0; i <= POLL_NUDGE_THRESHOLD; i++) {
      pacer.record("tok:t1:task-a");
      advance(500);
    }
    advance(POLL_RECOMMENDED_SECONDS * 1000 + 1);
    expect(pacer.record("tok:t1:task-a")).toBeNull();
  });

  test("不同 task_id 互不累加（同时等多个子任务不算连环打）", () => {
    const { pacer, advance } = pacerWithClock();
    for (let i = 0; i <= POLL_NUDGE_THRESHOLD; i++) {
      expect(pacer.record(`tok:t1:task-${i}`)).toBeNull();
      advance(500);
    }
  });

  test("提示文案必须说明「结果会自动 chain」——否则 agent 仍会紧盯", () => {
    expect(POLL_PACING_NOTE).toContain("60 秒");
    expect(POLL_PACING_NOTE).toContain("chain 回上游");
    expect(POLL_PACING_NOTE).toContain("一整轮 LLM");
  });

  test("key 数量有上限（调用方是外部输入，不能当它只查自己的任务）", () => {
    const pacer = createPollPacer({ maxKeys: 10, windowMs: 1, now: () => 1_000_000 });
    for (let i = 0; i < 500; i++) pacer.record(`tok:t1:task-${i}`);
    // 窗口 1ms，每次 record 时旧条目都已过期，应被回收
    expect(pacer.size()).toBeLessThanOrEqual(11);
  });
});
