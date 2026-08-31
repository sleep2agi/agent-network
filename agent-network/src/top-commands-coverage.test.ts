import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// F7-02 的 did-you-mean 名单 (`TOP_COMMANDS`) 是**手写**的,它旁边那句
// "keep in sync if new top-level commands are added" 是一条注释 ——
// 而注释只在有人读到它的时候生效。实测它已经漂了:`daemon` / `grok` /
// `opencode` / `quickstart` 四个真命令长期不在名单里,于是用户把这四个里
// 任何一个敲错,建议器**结构上不可能**猜中它。
//
// 这个测试把那句注释变成一道会红的门:名单必须覆盖 switch 上真实存在的
// 每一个顶层 case。
//
// 🔴 两边都从同一个文件解析 ⇒ 一个解析不到东西的 parser 会让断言**空过**。
// 所以下面先各自断一个下界(正控),再断包含关系。

const SRC = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

/** switch (command) 上缩进 2 空格的 case 标签 —— 即顶层命令。 */
function topLevelCaseLabels(src: string): string[] {
  const lines = src.split("\n");
  const anchor = lines.findIndex((l) => l.includes("const TOP_COMMANDS"));
  if (anchor < 0) throw new Error("找不到 TOP_COMMANDS —— 它被改名或移走了");
  let start = -1;
  for (let i = anchor; i >= 0; i--) {
    if (/switch\s*\(\s*command\s*\)/.test(lines[i]!)) { start = i; break; }
  }
  if (start < 0) throw new Error("找不到 switch (command) —— 顶层分发被重写了");
  const out = new Set<string>();
  for (const line of lines.slice(start + 1, anchor)) {
    if (!line.startsWith("  case ")) continue;      // 只认这一层,嵌套 switch 缩进更深
    for (const m of line.matchAll(/case "([^"]+)":/g)) {
      const label = m[1]!;
      if (label.startsWith("-")) continue;          // -v / -V / --version / --help / -h
      out.add(label);
    }
  }
  return [...out].sort();
}

function declaredTopCommands(src: string): string[] {
  const m = src.match(/const TOP_COMMANDS = \[([\s\S]*?)\];/);
  if (!m) throw new Error("TOP_COMMANDS 的字面量形状变了,解析不出来");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

describe("did-you-mean 的顶层命令名单", () => {
  const cases = topLevelCaseLabels(SRC);
  const declared = declaredTopCommands(SRC);

  it("解析器确实抓到了东西（正控：解析不到会让下面的包含断言空过）", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(declared.length).toBeGreaterThanOrEqual(40);
    expect(cases).toContain("node");     // 一个不可能消失的已知答案
    expect(declared).toContain("node");
  });

  it("每一个真实的顶层命令都在名单里 —— 否则把它敲错时建议器猜不到", () => {
    const missing = cases.filter((c) => !declared.includes(c));
    expect(missing).toEqual([]);
  });

  it("这四个是漂出去过的,单独钉住", () => {
    for (const c of ["daemon", "grok", "opencode", "quickstart"]) {
      expect(declared).toContain(c);
    }
  });
});
