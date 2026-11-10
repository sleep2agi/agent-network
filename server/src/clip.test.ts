import { describe, expect, test } from "bun:test";
import { clipSafe, hasLoneSurrogate } from "./clip.js";

// 2026-10-31 —— 外部复核：「slice 会切断代理对 ⇒ 孤立 surrogate ⇒ JSON 合法但 UTF-8 非法」。
// 这组用例的价值在于**边界那一个位置**：把 emoji 恰好摆在切点上。
describe("clipSafe: 不切断代理对", () => {
  test("短于上限原样返回（含 emoji）", () => {
    expect(clipSafe("ab😀", 10)).toBe("ab😀");
  });

  test("切点落在代理对中间 ⇒ 少取一个 code unit，不产生孤立代理", () => {
    // "😀" 在 index 0-1；max=2 会切在中间
    const cut = clipSafe("😀X", 2);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(2);
  });

  test("长串截断后仍是合法 UTF-16 且带省略号", () => {
    const s = "a".repeat(3) + "😀" + "b".repeat(10);
    const cut = clipSafe(s, 6);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(6);
  });

  test("对照：裸 slice 会制造孤立代理（证明这组用例不是空转）", () => {
    const raw = ("😀" + "x".repeat(10)).slice(0, 1);   // 只切到高代理
    expect(hasLoneSurrogate(raw)).toBe(true);
  });

  test("max<=0 与非法 max 返回空串（不抛）", () => {
    expect(clipSafe("abc", 0)).toBe("");
    expect(clipSafe("abc", -1)).toBe("");
    expect(clipSafe("abc", 1.5)).toBe("");
  });
});
