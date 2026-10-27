// #2614（第三轮）—— 首次 sweep 不是“等 N 秒”，而是“等循环安静”。
//
// 两次部署实测：60 秒后仍撞上风暴（max 1238ms）；180 秒后撞得更狠（max 3919ms，风暴持续 5 分钟）。
// 这里钉住判据本身（纯函数），不看时钟、不看真实 hub。
import { describe, expect, test } from "bun:test";
import { firstSweepShouldWait, FIRST_SWEEP_QUIET_INFLIGHT } from "./retention.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const iso = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("firstSweepShouldWait (#2614)", () => {
  test("waits while requests are queued", () => {
    expect(firstSweepShouldWait({ now: NOW, inflight: FIRST_SWEEP_QUIET_INFLIGHT + 1, lastStallAtIso: null })).toBe(true);
  });

  test("waits while the loop stalled within the last minute", () => {
    expect(firstSweepShouldWait({ now: NOW, inflight: 0, lastStallAtIso: iso(30) })).toBe(true);
  });

  test("runs once inflight is low and the last stall is old enough", () => {
    expect(firstSweepShouldWait({ now: NOW, inflight: 3, lastStallAtIso: iso(120) })).toBe(false);
  });

  test("runs when there has never been a stall", () => {
    expect(firstSweepShouldWait({ now: NOW, inflight: 0, lastStallAtIso: null })).toBe(false);
  });

  test("an unparseable stall timestamp does not block forever", () => {
    expect(firstSweepShouldWait({ now: NOW, inflight: 0, lastStallAtIso: "not-a-date" })).toBe(false);
  });
});
