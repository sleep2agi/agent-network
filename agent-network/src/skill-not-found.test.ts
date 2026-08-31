import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet skill show <slug>` 找不到时原先只说 `Skill not found: <slug>`,
// 而**全部 slug 就在上一行的 catalog.skills 里**。同 #1667(节点名找不到)、
// anet import(会话名找不到)：用户敲错一个字,而代码攥着全部真名。
//
// 三种现实分开说,因为下一步不同:
//   有相近的   → 直接把真名给他
//   有但没相近 → 列出来
//   catalog 空 → 说 catalog 是空的(而不是让他以为自己敲错了)

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const BLOCK = CODE.slice(CODE.indexOf("Skill not found:") - 600, CODE.indexOf("Skill not found:") + 900);

describe("anet skill show 找不到时", () => {
  it("三种现实各有一句", () => {
    expect(BLOCK).toContain('Did you mean');
    expect(BLOCK).toContain('available:');
    expect(BLOCK).toContain('The catalog is empty');
  });

  it("🔴 名字必须真的从 catalog.skills 取,不是写死一句话", () => {
    expect(BLOCK).toMatch(/catalog\.skills \|\| \[\]\)\.map\(/);
  });

  it("🔴 相似度复用既有的 suggestSimilar,不另立阈值", () => {
    expect(BLOCK).toContain("suggestSimilar(");
    // 且没有在这一块里自己写第二个 Levenshtein
    expect(/function levenshtein/.test(BLOCK)).toBe(false);
  });
});
