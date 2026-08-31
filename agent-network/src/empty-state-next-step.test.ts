import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 空状态也要给下一步。同一个 CLI 里已经有三处这么做:
//   anet node ls    → "Get started: anet init"
//   anet project up → "Create some with: anet node create <name>"
//   anet doctor     → 0 个节点那一格(#1660)同时说出两种现实
// 只有 `anet goal list` 是光秃秃的 "No goals found."。**正确写法就在隔壁。**
//
// 🔴 而"下一步"里写的命令必须**真的存在**:`anet goal` 只有
// list/show/wake-log/edit/cancel,**没有创建子命令** —— 所以这里不能写
// `anet goal add`。创建路径是 `anet node loop <alias> "<task>" --every <interval>`,
// 已跑 `anet node loop --help` 确认("Schedule a recurring task on a running node")。
// 今天已经因为「文档教了一个装到的版本里没有的命令」踩过一次(#1666)。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("空状态给下一步", () => {
  it("goal list 为空时给出创建路径", () => {
    expect(CODE).toContain("No goals found.");
    expect(CODE).toContain("Schedule one: anet node loop");
  });

  it("🔴 那条建议里的命令必须真的存在 —— anet goal 没有创建子命令", () => {
    // goal 的 usage 里不能出现 add/create 这类子命令(否则说明我建议错了目标)
    const usage = CODE.slice(CODE.indexOf("anet goal <command>"), CODE.indexOf("Data: .anet/nodes/<node>/goals.json"));
    expect(/^\s{2}(add|create)\b/m.test(usage)).toBe(false);
    // 而 node 的分发里必须有 loop 这一支
    expect(CODE).toContain('case "loop"');
  });

  it("🔴 tasks 的 0 条要分清「一条都没有」和「这个 status 没有」", () => {
    // 🔴 只断言"字符串在源码里"是观察不到这个缺陷的:把 `if (status)` 改成 `if (false)`
    // 之后那两句仍然原样躺在死分支里,断言照样过。所以要连**守卫条件**一起钉。
    const branch = CODE.slice(CODE.indexOf("if (tasks.length === 0) {"));
    expect(branch.slice(0, 400)).toMatch(/if \(status\) \{/);
    expect(branch.slice(0, 400)).toContain('No tasks with status');
    expect(branch.slice(0, 400)).toContain("去掉过滤看全部: anet tasks");
    // 不带过滤时仍是原来那句 —— 两支都要在
    expect(branch.slice(0, 400)).toContain("No tasks found.");
  });

  it("🔴 没有真实下一步的地方**不编一个** —— anet skill 只有 list/ls/show", () => {
    const skillFn = CODE.slice(CODE.indexOf("async function skillCommand()"), CODE.indexOf("async function skillCommand()") + 4000);
    expect(/sub === "(install|add|pull)"/.test(skillFn)).toBe(false);
    // 所以 "No skills found." 后面**不该**出现一条 anet skill 的安装建议
    const idx = CODE.indexOf('"No skills found."');
    expect(/anet skill (install|add|pull)/.test(CODE.slice(idx, idx + 200))).toBe(false);
  });

  it("🔴 anet import 找不到 alias 时把可导入的真名列出来 —— 数据就在手边", () => {
    const i = CODE.indexOf('No session found for');
    const near = CODE.slice(Math.max(0, i - 400), i + 200);
    expect(near).toContain("importable");
    // 连守卫一起钉:名字必须真的从 claudeSessions 取,而不是写死一句话
    expect(near).toMatch(/claudeSessions\.map\(/);
  });

  it("正控:另外两处既有的空状态提示还在(它们是这条的样板)", () => {
    expect(CODE).toContain("Get started: anet init");
    expect(CODE).toContain("Create some with: anet node create");
  });
});
