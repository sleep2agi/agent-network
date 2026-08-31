import { describe, expect, it } from "bun:test";
import { displayWidth, padDisplayEnd } from "./display-width";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1663 把 `anet node ls` 的中文对齐修好了,但 `padEnd`(按码元数)在 cli.ts 里
// 还留着 10 处接的是**用户数据**:alias / from_name / network_name / display_name /
// label / p.display / 节点 id —— 本机这些几乎全是中文。
//
// 🔴 混合宽度时才现身:三行都叫「通信龙」时两种写法各自都齐,
// 一旦同一张表里既有 `admin` 又有「通信龙」,padEnd 那版就歪 3 列。

describe("padEnd 与 padDisplayEnd 在混合宽度下的差别", () => {
  // 都装得下 12 显示列的一组（TM开发机Codex 本身就有 13 列,放它会混进
  // 「值比列还宽」这另一件事,所以单独一条测）
  const rows = ["admin", "通信龙", "TMAI"];

  it("🔴 padEnd:同一列的实际显示宽度彼此不同(这就是歪的来源)", () => {
    const widths = rows.map(r => displayWidth(r.padEnd(12)));
    expect(new Set(widths).size).toBeGreaterThan(1);
    expect(widths).toEqual([12, 15, 12]);   // 「通信龙」3 码元补到 12 → 实际占 15 列
  });

  it("padDisplayEnd:同一列的显示宽度全部相等", () => {
    const widths = rows.map(r => displayWidth(padDisplayEnd(r, 12)));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(12);
  });

  it("值本身就比列宽时保持原样,不截断 —— 它撑宽那一行,但不丢字", () => {
    // 第一版我把 TM开发机Codex(13 显示列) 混进「全部相等」那条,红的是**我的期望值**:
    // padDisplayEnd 补不了负数,它本来就该返回 13。
    expect(displayWidth("TM开发机Codex")).toBe(13);
    expect(padDisplayEnd("TM开发机Codex", 12)).toBe("TM开发机Codex");
  });

  it("纯 ASCII 时两者逐字相同 —— 所以这次替换对英文场景零影响", () => {
    for (const s of ["admin", "tok_913d", "x", ""]) {
      expect(padDisplayEnd(s, 12)).toBe(s.padEnd(12));
    }
  });
});

describe("接线:用户数据不再用 padEnd", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("alias / from_name / network_name / display_name 都走 padDisplayEnd", () => {
    for (const pat of [
      /\$\{alias\.padEnd\(/,
      /\(t\.from_name \|\| "\?"\)\.padEnd\(/,
      /\$\{n\.network_name\.padEnd\(/,
      /\(m\.display_name \|\| m\.username\)\.padEnd\(/,
    ]) {
      expect(pat.test(cli)).toBe(false);
    }
  });

  it("正控:padDisplayEnd 确实被用上了(0 处说明我没接)", () => {
    expect((cli.match(/padDisplayEnd\(/g) || []).length).toBeGreaterThanOrEqual(12);
  });
});
