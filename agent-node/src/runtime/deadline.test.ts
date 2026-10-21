// #1976 —— 切模型要有硬上限(节点卡在那儿 ⇒ 客户端干等 90 s、hub 上永远 pending)。
import { describe, expect, test } from "bun:test";
import { MODEL_SWITCH_DEADLINE_MS, withDeadlineMs } from "./deadline.js";

describe("withDeadlineMs", () => {
  test("a promise that settles in time passes its value through", async () => {
    expect(await withDeadlineMs(Promise.resolve("ok"), 1_000, "too slow")).toBe("ok");
  });

  test("a promise that never settles is rejected with the message", async () => {
    const never = new Promise<never>(() => { /* never settles */ });
    await expect(withDeadlineMs(never, 20, "model switch timed out")).rejects.toThrow("model switch timed out");
  });

  test("a promise that rejects keeps its own reason", async () => {
    await expect(withDeadlineMs(Promise.reject(new Error("no such model")), 1_000, "timed out")).rejects.toThrow("no such model");
  });

  test("the deadline is under the client's own 90 s budget, so the client hears the reason first", () => {
    expect(MODEL_SWITCH_DEADLINE_MS).toBeLessThan(90_000);
    expect(MODEL_SWITCH_DEADLINE_MS).toBeGreaterThan(5_000);
  });
});
