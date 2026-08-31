import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { displayWidth, padDisplayEnd } from "./display-width";

describe("displayWidth", () => {
  test("🔴 与 daemon-capability-display.test.ts 里那份给出同样的答案", () => {
    // 两处分头演化会让它们对同一个字符给出不同宽度。这两条来自那份的正控。
    expect(displayWidth("abcd")).toBe(4);
    expect(displayWidth("中文")).toBe(4);
  });

  test("真实军团别名的宽度", () => {
    expect(displayWidth("通信工程马")).toBe(10);   // 5 个 CJK
    expect(displayWidth("通信IM马")).toBe(8);      // 通信马=6 + IM=2
    expect(displayWidth("通信SDK牛")).toBe(9);     // 通信牛=6 + SDK=3
  });

  test("非字符串返回 0,不抛", () => {
    for (const bad of [undefined, null, 42, {}]) expect(displayWidth(bad as unknown)).toBe(0);
  });
});

describe("padDisplayEnd", () => {
  test("🔴 这就是 padEnd 会补错的那一组 —— 补到同样的显示列", () => {
    for (const name of ["通信工程马", "通信IM马", "通信SDK牛", "plain-ascii"]) {
      expect(displayWidth(padDisplayEnd(name, 20))).toBe(20);
    }
  });

  test("对照:原生 padEnd 在同一组上给出不同的显示宽度(这就是缺陷)", () => {
    const widths = new Set(["通信工程马", "通信IM马", "plain"].map(n => displayWidth(n.padEnd(20))));
    expect(widths.size).toBeGreaterThan(1);          // 原生 padEnd:不一致
    const fixed = new Set(["通信工程马", "通信IM马", "plain"].map(n => displayWidth(padDisplayEnd(n, 20))));
    expect(fixed.size).toBe(1);                       // padDisplayEnd:一致
  });

  test("🔴 已超宽时原样返回,不截断", () => {
    expect(padDisplayEnd("通信工程马通信工程马通信", 10)).toBe("通信工程马通信工程马通信");
  });

  test("坏宽度按 0 处理", () => {
    expect(padDisplayEnd("ab", 0)).toBe("ab");
    expect(padDisplayEnd("ab", NaN)).toBe("ab");
  });
});

describe("接线守卫", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("🔴 会出现 CJK 的那几列全部改用 padDisplayEnd", () => {
    expect(cli).not.toContain("displayName.padEnd(20)");
    expect(cli).not.toContain("String(s.alias).padEnd(16)");
    expect(cli).not.toContain("s.alias.padEnd(16)");
    expect(cli).not.toContain('(t.from_name || "?").padEnd(15)');
    expect(cli).not.toContain('(t.to_name || "?").padEnd(15)');
  });

  test("而且确实调用了 —— 「没有旧写法」也可能是整段被删了", () => {
    expect((cli.match(/padDisplayEnd\(/g) || []).length).toBeGreaterThanOrEqual(7);
  });
});
