import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet node <sub>` 的子命令名单在这个文件里**存了三份**,而它们会各自漂:
//
//   ① 主帮助 `Node Management:` 段        —— 用户读 `anet --help` 看到的
//   ② did-you-mean 的 `suggestSimilar` 候选 —— 用户打错时的搜索空间
//   ③ `Usage: anet node <a|b|c>` 一行     —— 用户打错时同屏打出的
//
// 🔴 实测(2026-08-31): 三份两两不等。`edit` 只在 ③ 里 —— 它既不在主帮助,
// did-you-mean 也搜不到它,于是 `anet node edti` 得不到任何有用建议。
// `loop` / `restart` 不在 ①。
//
// 成因是同族的:加子命令的人改的是**离 `case` 最近的那份**(③,写在同一个 default 块里),
// 而 ① 在一万两千行外、② 在同一屏的另一个数组里。本文件的手写名单已经栽过多次
// (did-you-mean 的 TOP_COMMANDS 漏 4 个 / `--help` 拦截器漏 4 个,见 #1668)。
//
// 所以这道门和 `help-intercept-coverage.test.ts` 一样是**反推**的:
// 从 dispatcher 的 `switch` 取全集,要求每一个都出现在上面三处 ——
// 将来第 12 个 `case` 漏了任何一张表都会红。
//
// 故意不列进用户帮助的,写进 HIDDEN 并给出理由;HIDDEN 本身也被钉住,
// 免得有人靠往里加东西来消红。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
// 🔴 必须去掉注释:源码里既有"东西"也有"关于它的描述",裸 grep 会命中后者。
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** `anet migrate-token-to-envref` 是一次性迁移工具,不进面向用户的帮助表。 */
const HIDDEN_FROM_HELP = new Set(["migrate-token-to-envref"]);

// `case "ls": case "list":` 是同一分支的两个标签 —— `list` 是 `ls` 的别名,
// 不是独立子命令。🔴 在取集处一次性归一,不要在每条断言里各抄一遍 `s !== "list"`
// (第一版就是那么写的,结果三处只排除了一处)。
const ALIAS_OF = new Map([["list", "ls"]]);

/** `case "node":` 内层 switch 里的全部 case 标签(别名已归一) = 真实全集。 */
function dispatcherSubcommands(src: string): string[] {
  const anchor = src.indexOf('case "node":');
  if (anchor < 0) throw new Error("找不到 `case \"node\":` —— dispatcher 被改写了");
  const swStart = src.indexOf("switch (args[1])", anchor);
  if (swStart < 0) throw new Error("`case \"node\":` 里找不到内层 switch");
  const end = src.indexOf("default:", swStart);
  if (end < 0) throw new Error("node 的内层 switch 里找不到 default 分支");
  const raw = [...src.slice(swStart, end).matchAll(/case "([^"]+)":/g)].map(m => m[1]!);
  return [...new Set(raw.map(s => ALIAS_OF.get(s) ?? s))].sort();
}

/** 主帮助 `Node Management:` 段里 `anet node <x>` 的 x。 */
function mainHelpSubcommands(src: string): string[] {
  const start = src.indexOf("Node Management:");
  if (start < 0) throw new Error("主帮助里找不到 `Node Management:` 段");
  // 段落到第一个空行为止
  const end = src.indexOf("\n\n", start);
  const block = src.slice(start, end < 0 ? start + 2000 : end);
  return [...new Set([...block.matchAll(/anet node ([a-z][a-z-]*)/g)].map(m => m[1]!))].sort();
}

/** node 的 default 分支里 `suggestSimilar(sub, [...])` 的候选表。 */
function didYouMeanCandidates(src: string): string[] {
  const anchor = src.indexOf('case "node":');
  const m = /suggestSimilar\(sub, \[([^\]]*)\]/.exec(src.slice(anchor));
  if (!m) throw new Error("node 的 default 分支里找不到 suggestSimilar 候选表");
  return [...new Set([...m[1]!.matchAll(/"([^"]+)"/g)].map(x => x[1]!))].sort();
}

/** `Usage: anet node <a|b|c>` 那一行。 */
function usageLineSubcommands(src: string): string[] {
  const m = /Usage: anet node <([^>]+)>/.exec(src);
  if (!m) throw new Error("找不到 `Usage: anet node <...>` 行");
  return [...new Set(m[1]!.split("|").map(s => s.trim()))].sort();
}

describe("node 子命令的三处名单必须覆盖 dispatcher 的全集", () => {
  const disp = dispatcherSubcommands(CODE);
  const help = mainHelpSubcommands(CODE);
  const dym = didYouMeanCandidates(CODE);
  const usage = usageLineSubcommands(CODE);

  it("取集正控:四侧都真的解析出了东西(任一为空会让下面的差集恒绿)", () => {
    expect(disp.length).toBeGreaterThanOrEqual(10);
    expect(help.length).toBeGreaterThanOrEqual(7);
    expect(dym.length).toBeGreaterThanOrEqual(9);
    expect(usage.length).toBeGreaterThanOrEqual(10);
    // 取集正控的第二层:解析到的必须是真子命令,不是别处的噪声
    for (const s of ["create", "start", "delete"]) {
      expect(disp).toContain(s);
      expect(help).toContain(s);
    }
  });

  it("dispatcher 的每个子命令都在主帮助里(HIDDEN 除外)", () => {
    const missing = disp.filter(s => !HIDDEN_FROM_HELP.has(s) && !help.includes(s));
    expect(missing).toEqual([]);
  });

  it("dispatcher 的每个子命令都在 did-you-mean 候选里(HIDDEN 除外)", () => {
    const missing = disp.filter(s => !HIDDEN_FROM_HELP.has(s) && !dym.includes(s));
    expect(missing).toEqual([]);
  });

  it("dispatcher 的每个子命令都在 Usage 行里(HIDDEN 也要,它是完整语法)", () => {
    const missing = disp.filter(s => !usage.includes(s));
    expect(missing).toEqual([]);
  });

  it("三处不得列出 dispatcher 不认识的子命令(反向:表比实现多也是错)", () => {
    const known = new Set([...disp, "list"]);
    expect(help.filter(s => !known.has(s))).toEqual([]);
    expect(dym.filter(s => !known.has(s))).toEqual([]);
    expect(usage.filter(s => !known.has(s))).toEqual([]);
  });

  it("ALIAS_OF 被钉住 —— 不许靠往里加别名来消红", () => {
    expect([...ALIAS_OF.keys()].sort()).toEqual(["list"]);
  });

  it("HIDDEN 被钉住 —— 不许靠往里加东西来消红", () => {
    expect([...HIDDEN_FROM_HELP].sort()).toEqual(["migrate-token-to-envref"]);
  });

  it("2026-08-31 实测漏掉的这三个,单独钉住", () => {
    for (const s of ["edit", "loop", "restart"]) expect(help).toContain(s);
    expect(dym).toContain("edit");
  });
});
