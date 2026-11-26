// #5614 —— 后台定时任务计时：停顿归因 top_routes 与 /api/stats/routes 都要能看到 `JOB <name>`。
import { describe, expect, test, beforeEach } from "bun:test";
import { resetTickRouteCostsForTests, routeStats, takeTickRouteCosts, timedJob } from "./route-timing.js";

describe("timedJob", () => {
  beforeEach(() => resetTickRouteCostsForTests());

  test("记进 tick 窗口，停顿归因能看到后台任务", () => {
    const job = timedJob("unit-busy", () => { const end = performance.now() + 15; while (performance.now() < end) {} return 7; });
    expect(job()).toBe(7);
    const tick = takeTickRouteCosts().find(r => r.route === "JOB unit-busy");
    expect(tick?.count).toBe(1);
    expect(tick!.total_ms).toBeGreaterThanOrEqual(14);
  });

  test("参数原样透传", () => {
    const job = timedJob("unit-args", (a: number, b: string) => `${a}${b}`);
    expect(job(1, "x")).toBe("1x");
  });

  test("抛错照常抛出，并记成一次失败", () => {
    const job = timedJob("unit-throw", () => { throw new Error("boom"); });
    expect(() => job()).toThrow("boom");
    expect(takeTickRouteCosts().find(r => r.route === "JOB unit-throw")?.count).toBe(1);
    const stats = JSON.stringify(routeStats(5 * 60_000));
    expect(stats).toContain("JOB unit-throw");
  });
});
