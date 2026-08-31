import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { oneLineCell } from "./one-line-cell";

describe("oneLineCell", () => {
  test("🔴 实测那条:换行被折成空格,不再打断表格", () => {
    const real = "【把你自己的名册状态修正过来 —— 两步，别做别的】\n\n你今天两次在 22 秒内答了我的探测";
    const out = oneLineCell(real, 48);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(48);
  });

  test("所有空白种类都折叠", () => {
    expect(oneLineCell("a\nb\tc\r\nd  e f", 100)).toBe("a b c d e f");
  });

  test("首尾空白裁掉 —— 否则表格左边会多出空格", () => {
    expect(oneLineCell("   \n  hello  \n ", 20)).toBe("hello");
  });

  test("长度边界用边界值校准", () => {
    expect(oneLineCell("x".repeat(48), 48).length).toBe(48);
    expect(oneLineCell("x".repeat(49), 48).length).toBe(48);
  });

  test("🔴 有意不加省略号 —— 加了会改列宽", () => {
    expect(oneLineCell("y".repeat(60), 10)).toBe("y".repeat(10));
    expect(oneLineCell("y".repeat(60), 10)).not.toContain("…");
  });

  test("非字符串/坏 max 不抛", () => {
    for (const bad of [undefined, null, 42, {}, []]) expect(oneLineCell(bad as unknown, 10)).toBe("");
    expect(oneLineCell("abc", 0)).toBe("");
    expect(oneLineCell("abc", NaN)).toBe("");
  });
});

describe("接线守卫", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("🔴 五处裸 slice 全部换掉了 —— 只改一处等于没修", () => {
    expect(cli).not.toContain('(s.task || "").slice(');
    expect(cli).not.toContain('(t.content || "").slice(');
  });

  test("而且确实调用了 oneLineCell —— 「没有旧写法」也可能是整段被删了", () => {
    // 5 处调用 + 1 处 import
    expect((cli.match(/oneLineCell\(/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});
