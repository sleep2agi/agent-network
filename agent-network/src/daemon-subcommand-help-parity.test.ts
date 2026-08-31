import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet daemon <sub>` 的子命令名单在 `daemonCommand()` 里存了**两份**,而它们会各自漂:
//
//   ① `Subcommands:` 帮助段  —— 用户打 `anet daemon` / `--help` 看到的
//   ② `switch (sub)` 的 case —— 真正会被执行的
//
// 🔴 为什么现在补:2026-09-01 核 `origin/main`,两份**目前是齐的**(init/start/up/restart/list)
// —— 但那是人写对了,不是有东西拦着。同一个文件的 `node` 侧就没这么幸运:
// #1705 实测三份名单两两不等(`edit` 只在 Usage 行里,`loop`/`restart` 不在主帮助),
// 成因是加子命令的人改的是**离 `case` 最近的那份**。daemon 的两份相隔约 25 行,
// 比 node 的近得多 —— 近只是让它**晚一点**发生,不是不发生。
//
// 🔴 顺带钉住一个真实踩过的坑:本机装的 `anet v2.2.21` 的 daemon 帮助**没有 restart**,
// 而 main 有。当晚我拿本地 CLI 输出当证据报了个不存在的缺陷。这道门读的是
// `bin/cli.ts` 源码,不是任何已安装的产物 —— 判的永远是这个 ref。
//
// 反推方向:从 `switch` 取全集,要求每一个都出现在帮助段里。
// 将来第 6 个 `case` 漏了帮助会红;反向(帮助列了实现没有的)也会红。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
// 🔴 必须去掉注释:源码里既有"东西"也有"关于它的描述",裸 grep 会命中后者。
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const ANCHOR = "async function daemonCommand()";

// `case "list": case "ls":` 是同一分支的两个标签。帮助段写的是 `list`,
// 所以在**取集处**一次性把 `ls` 归一到 `list`,不要在每条断言里各排除一次。
const ALIAS_OF = new Map([["ls", "list"]]);

/** `daemonCommand()` 内 `switch (sub)` 的全部 case 标签(别名已归一) = 真实全集。 */
function dispatcherSubcommands(src: string): string[] {
  const anchor = src.indexOf(ANCHOR);
  if (anchor < 0) throw new Error("找不到 `daemonCommand()` —— 函数被改名了");
  const swStart = src.indexOf("switch (sub)", anchor);
  if (swStart < 0) throw new Error("`daemonCommand()` 里找不到 `switch (sub)`");
  const end = src.indexOf("default:", swStart);
  if (end < 0) throw new Error("daemon 的 switch 里找不到 default 分支");
  const raw = [...src.slice(swStart, end).matchAll(/case "([^"]+)":/g)].map(m => m[1]!);
  return [...new Set(raw.map(s => ALIAS_OF.get(s) ?? s))].sort();
}

/** `daemonCommand()` 帮助里 `Subcommands:` 到 `Options:` 之间列出的子命令。 */
function helpSubcommands(src: string): string[] {
  const anchor = src.indexOf(ANCHOR);
  const start = src.indexOf("Subcommands:", anchor);
  if (start < 0) throw new Error("daemon 帮助里找不到 `Subcommands:` 段");
  const end = src.indexOf("Options:", start);
  if (end < 0) throw new Error("daemon 帮助里找不到 `Options:`(段落取不到边界)");
  const block = src.slice(start + "Subcommands:".length, end);
  // 形如 `  init <name>          Create a ...` —— 只取行首缩进后的第一个词
  const names = [...block.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map(m => m[1]!);
  return [...new Set(names.map(s => ALIAS_OF.get(s) ?? s))].sort();
}

describe("daemon 子命令:帮助段必须覆盖 dispatcher 的全集", () => {
  const disp = dispatcherSubcommands(CODE);
  const help = helpSubcommands(CODE);

  it("取集正控:两侧都真的解析出了东西(任一为空会让下面的差集恒绿)", () => {
    expect(disp.length).toBeGreaterThanOrEqual(5);
    expect(help.length).toBeGreaterThanOrEqual(5);
    // 第二层:解析到的必须是真子命令,不是别处的噪声
    for (const s of ["init", "start", "up", "restart", "list"]) {
      expect(disp).toContain(s);
      expect(help).toContain(s);
    }
  });

  it("dispatcher 的每个子命令都在帮助段里", () => {
    expect(disp.filter(s => !help.includes(s))).toEqual([]);
  });

  it("帮助段不得列出 dispatcher 不认识的子命令(反向:表比实现多也是错)", () => {
    expect(help.filter(s => !disp.includes(s))).toEqual([]);
  });

  it("ALIAS_OF 被钉住 —— 不许靠往里加别名来消红", () => {
    expect([...ALIAS_OF.keys()].sort()).toEqual(["ls"]);
  });

  it("🔴 restart 必须同时在两侧 —— 本机 v2.2.21 的帮助缺它,别让 main 退回去", () => {
    expect(disp).toContain("restart");
    expect(help).toContain("restart");
  });

  it("帮助段之外那块「没有 daemon 版的 stop/delete」说明必须还在", () => {
    const anchor = CODE.indexOf(ANCHOR);
    const seg = CODE.slice(anchor, anchor + 4000);
    // daemon 不是独立进程模型,停/删走 node 级命令 —— 这句话是用户唯一的指路牌
    expect(seg).toContain("anet node stop");
    expect(seg).toContain("anet node delete");
  });
});
