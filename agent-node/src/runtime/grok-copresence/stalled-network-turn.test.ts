import { describe, expect, test } from "bun:test";
import { describeStalledNetworkTurn } from "./stalled-network-turn";
const base = { phase: "network_turn", activeTaskId: "t1", timedOutTaskId: "t1", timedOutAt: 1_000_000, now: 1_000_000 + 300_000, taskTimeoutMs: 300_000, lastPtyOutputAt: 1_000_000 };
describe("#870 stalled network turn", () => {
  test("超时后又满一个 timeout 且 PTY 安静 ≥60s → 放弃,并说清两个数字", () => {
    const m = describeStalledNetworkTurn(base);
    expect(m).toMatch(/timed out 300s ago/); expect(m).toMatch(/silent for 300s/);
  });
  test("超时后还没满一个 timeout → 不放弃(有上限的等待)", () => {
    expect(describeStalledNetworkTurn({ ...base, now: base.timedOutAt + 299_000 })).toBeNull();
  });
  test("PTY 最近还在输出 → 不放弃(那一轮可能真在跑)", () => {
    expect(describeStalledNetworkTurn({ ...base, lastPtyOutputAt: base.now - 10_000 })).toBeNull();
  });
  test("phase 不是 network_turn → 不管", () => {
    expect(describeStalledNetworkTurn({ ...base, phase: "idle" })).toBeNull();
    expect(describeStalledNetworkTurn({ ...base, phase: "human_turn" })).toBeNull();
  });
  test("超时的不是当前活动任务(已经换了一轮)→ 不放弃", () => {
    expect(describeStalledNetworkTurn({ ...base, activeTaskId: "t2" })).toBeNull();
    expect(describeStalledNetworkTurn({ ...base, timedOutTaskId: null, timedOutAt: null })).toBeNull();
  });
});
