#!/usr/bin/env bun
/**
 * #1548 —— 把 `describeGrokCopresenceLiveness` 的六个分量在节点机器上打出来。
 *
 * 背景:名册上那个 `blocked` 不是「没人清」,是 agent-node 每 3 分钟主动重新断言的:
 *   cli.ts `resolveReportedStatus()` → liveness.ts `resolveGrokCopresenceHubStatus()`
 *   `!usable && (idle|working) ⇒ blocked`
 * 而 `usable` 是六个合取。**要修它,先得知道假的是哪一个。**
 *
 * 🔴 判据不在本文件里 —— 直接 import 生产那两个谓词
 *    (`grokSocketIsPresent` / `isNamedGrokCopresenceSocket`)。
 *    抄一份到这里,就会有两个作者,而「探针说 present、节点说不 present」
 *    比没有探针更难查。
 *
 * 用法(只读,不碰节点、不发消息、不改任何文件):
 *   bun run scripts/grok-copresence-liveness-probe.ts <leader.sock 的绝对路径> [child-pid]
 *
 * leader.sock 路径从那个节点的进程命令行里拿:
 *   ps -eo args | grep -- --leader-socket
 */
import {
  describeGrokCopresenceLiveness,
  isNamedGrokCopresenceSocket,
  grokSocketIsPresent,
} from "../agent-node/src/runtime/grok-copresence/liveness.js";
import { dirname, join, basename } from "path";

const leader = process.argv[2];
const pidArg = process.argv[3];
if (!leader) {
  console.error("用法: bun run scripts/grok-copresence-liveness-probe.ts <leader.sock 绝对路径> [child-pid]");
  process.exit(2);
}

// attach.sock 与 leader.sock 同目录。短路径回退用 a.sock/l.sock,一并试。
const dir = dirname(leader);
const attachCandidates = [join(dir, "attach.sock"), join(dir, "a.sock")];
const attach = attachCandidates.find((p) => grokSocketIsPresent(p)) ?? attachCandidates[0];

// 🔴 childAlive 在节点进程里是 `session.isRunning`,**外部只能近似**:
//    给了 pid 就用 kill(pid, 0),没给就标成"未知",**不猜**。
let childAlive: boolean | null = null;
if (pidArg) {
  try { process.kill(Number(pidArg), 0); childAlive = true; }
  catch { childAlive = false; }
}

// 🔴 tuiReady **完全不可从外部观测**:它只存在于节点进程的内存里
//    (`session.tuiReady`,由 TUI 就绪标记的解析结果置位)。
//    所以下面用 true 占位跑一遍谓词,只是为了拿到其余五个分量的真值;
//    `usable` 的最终判断见文末的「排除法」。
const view = describeGrokCopresenceLiveness({
  isRunning: childAlive ?? true,
  tuiReady: true,
  attachSocket: attach,
  leaderSocket: leader,
});

const rows: Array<[string, string, string]> = [
  ["attachNamed",   String(isNamedGrokCopresenceSocket(attach, "attach")), `basename=${basename(attach)}(需 attach.sock 或 a.sock)`],
  ["leaderNamed",   String(isNamedGrokCopresenceSocket(leader, "leader")), `basename=${basename(leader)}(需 leader.sock 或 l.sock)`],
  ["attachPresent", String(view.attach.present), attach],
  ["leaderPresent", String(view.leader.present), leader],
  ["childAlive",    childAlive === null ? "未知(没给 pid)" : String(childAlive), pidArg ? `kill(${pidArg},0)` : "传第二个参数可测"],
  ["tuiReady",      "不可外部观测", "只存在于节点进程内存(session.tuiReady)"],
];

console.log("describeGrokCopresenceLiveness 的六个合取:");
for (const [k, v, note] of rows) console.log(`  ${k.padEnd(14)} ${String(v).padEnd(16)} ${note}`);

const external = [
  isNamedGrokCopresenceSocket(attach, "attach"),
  isNamedGrokCopresenceSocket(leader, "leader"),
  view.attach.present,
  view.leader.present,
  ...(childAlive === null ? [] : [childAlive]),
];
const allExternalTrue = external.every(Boolean);

console.log("");
if (!allExternalTrue) {
  console.log("结论:**已经找到假的分量**(见上表里 false 的那几行)。");
  console.log("      tuiReady 是真是假不影响结论 —— 合取里有一个假就够了。");
} else if (childAlive === null) {
  console.log("结论:可外部观测的四个分量**全为真**,但 childAlive 未测。");
  console.log("      带上 child pid 再跑一次;若它也为真,则按排除法 tuiReady=false 是唯一可能。");
} else {
  console.log("🔴 结论(排除法):其余五个分量**全为真**,而节点仍上报 blocked");
  console.log("      ⇒ 假的只能是 **tuiReady** —— 那个唯一无法从外部看见的分量。");
  console.log("      也就是说 TUI 就绪标记从未被认定过(或被认定后又被清掉)。");
}
console.log("");
console.log("⚠️ 本探针只读文件系统 + kill(pid,0),不连接 socket、不碰节点、不发任何消息。");
