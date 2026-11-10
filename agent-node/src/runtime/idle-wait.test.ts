import { describe, expect, test } from "bun:test";
import { waitUntilIdle } from "./idle-wait";

// 这个 helper 存在的唯一理由，是把「档位写入等到这一轮结束」从「立刻拒绝」变成
// 「有上界地等」。所以要钉住的正是这两件：**等到了就返回 true**、**预算用完必须返回 false**
// （不能让调用方无限挂住 —— 那会让整个 config-apply 路卡死）。
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    get t() { return t; },
  };
}

describe("waitUntilIdle", () => {
  test("already idle costs no polling", async () => {
    const clock = fakeClock();
    let calls = 0;
    const idle = await waitUntilIdle({ isBusy: () => { calls += 1; return false; }, budgetMs: 1000, now: clock.now, sleep: clock.sleep });
    expect(idle).toBe(true);
    expect(calls).toBe(1);
    expect(clock.t).toBe(0);
  });

  test("returns true as soon as the turn ends", async () => {
    const clock = fakeClock();
    const endsAt = 3;           // 第 3 次探测时空闲
    let probes = 0;
    const idle = await waitUntilIdle({
      isBusy: () => { probes += 1; return probes < endsAt; },
      budgetMs: 5000, intervalMs: 250, now: clock.now, sleep: clock.sleep,
    });
    expect(idle).toBe(true);
    expect(clock.t).toBeGreaterThan(0);
    expect(clock.t).toBeLessThan(5000);
  });

  test("gives up at the budget instead of waiting forever", async () => {
    const clock = fakeClock();
    const idle = await waitUntilIdle({ isBusy: () => true, budgetMs: 1000, intervalMs: 250, now: clock.now, sleep: clock.sleep });
    expect(idle).toBe(false);
    expect(clock.t).toBeGreaterThanOrEqual(1000);
    expect(clock.t).toBeLessThan(2000);   // 没有多等出一整轮
  });

  test("a zero or invalid budget never sleeps", async () => {
    const clock = fakeClock();
    expect(await waitUntilIdle({ isBusy: () => true, budgetMs: 0, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(await waitUntilIdle({ isBusy: () => true, budgetMs: Number.NaN, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(clock.t).toBe(0);
  });
});
