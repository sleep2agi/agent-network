import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet <group> --help` 先被顶层的 universal 拦截器接住(#215)。拦截器里有一张
// **手写的 case 名单**;没在名单上的一律落 `default: printHelp()`,打出 126 行全局帮助。
//
// 🔴 后果不是"少了点提示",是**别人写的 help 一次都跑不到**:实测 opencode /
// goal / token / batch 四个命令**各自都在自己的函数里写了 `sub === "--help"` 分支**,
// 四段代码全是死的。#240 已经为 hub 修过一次同样的事,#717 为 daemon 修过第二次。
//
// 所以这道门的判据不是"名单里有没有 X",而是**从源码反推**:
// 凡是自己写了 `sub === "--help"` 守卫的命令,都必须在拦截器名单里 ——
// 否则那段守卫永远执行不到。这样将来第五个人写 help 时,漏了会红。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** 自己处理了 `sub === "--help"` 的命令函数 → 命令名。 */
function commandsWithOwnHelp(src: string): string[] {
  const out = new Set<string>();
  let fn: string | null = null;
  for (const line of src.split("\n")) {
    const m = /^(?:async\s+)?function (\w+)\(/.exec(line);
    if (m) fn = m[1]!;
    if (fn && /sub === "--help"/.test(line)) {
      const cmd = fn.replace(/Command$/, "");
      if (cmd !== fn) out.add(cmd.toLowerCase());
    }
  }
  return [...out].sort();
}

/** 拦截器 `if (args.slice(1).some(... "--help" ...))` 块里的 case 标签。 */
function interceptCases(src: string): string[] {
  const start = src.indexOf('if (args.slice(1).some((a) => a === "--help"');
  if (start < 0) throw new Error("找不到 universal --help 拦截器 —— 它被改写了");
  const end = src.indexOf("default:", start);
  if (end < 0) throw new Error("拦截器里找不到 default 分支");
  return [...src.slice(start, end).matchAll(/case "([^"]+)":/g)].map(m => m[1]!).sort();
}

describe("--help 拦截器的覆盖", () => {
  const own = commandsWithOwnHelp(CODE);
  const cases = interceptCases(CODE);

  it("取集正控：两侧都真的解析出了东西（空集会让下面那条空过）", () => {
    expect(own.length).toBeGreaterThanOrEqual(4);
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases).toContain("daemon");   // #717 修过的那个,不该消失
    expect(cases).toContain("hub");      // #240 修过的那个
  });

  it("凡是自己写了 --help 守卫的命令,都在拦截器名单里 —— 否则那段守卫是死代码", () => {
    const dead = own.filter(c => !cases.includes(c));
    expect(dead).toEqual([]);
  });

  it("这四个是漏过的,单独钉住", () => {
    for (const c of ["opencode", "goal", "token", "batch"]) expect(cases).toContain(c);
  });
});
