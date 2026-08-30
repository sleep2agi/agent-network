import { lstatSync } from "fs";
import { basename } from "path";

/**
 * Hub `report_status` enum (server/src/tools.ts). Copresence must never
 * present a dead or unready TUI as idle/working — that is the #811
 * false-idle shape.
 */
export const GROK_COPRESENCE_HUB_STATUSES = [
  "working",
  "idle",
  "blocked",
  "error",
  "waiting_input",
  "offline",
] as const;

export type GrokCopresenceHubStatus = (typeof GROK_COPRESENCE_HUB_STATUSES)[number];

export function isGrokCopresenceHubStatus(value: string): value is GrokCopresenceHubStatus {
  return (GROK_COPRESENCE_HUB_STATUSES as readonly string[]).includes(value);
}

export interface GrokCopresenceLivenessSource {
  readonly isRunning: boolean;
  readonly tuiReady: boolean;
  readonly attachSocket: string;
  readonly leaderSocket: string;
}

export interface GrokCopresenceSocketView {
  present: boolean;
  named: boolean;
}

export interface GrokCopresenceLiveness {
  tuiReady: boolean;
  childAlive: boolean;
  attach: GrokCopresenceSocketView;
  leader: GrokCopresenceSocketView;
  usable: boolean;
}

export type GrokSocketInspector = (path: string) => boolean;

/** True only for a real Unix socket at `path`. Leftover files / missing paths are not present. */
export function grokSocketIsPresent(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * Named sockets are `attach.sock` / `leader.sock`, or the documented
 * short-path fallback `a.sock` / `l.sock` when the Unix path-length
 * budget forces `grokCopresenceSocketPaths` under `/tmp`.
 */
export function isNamedGrokCopresenceSocket(path: string, role: "attach" | "leader"): boolean {
  const name = basename(path);
  if (role === "attach") return name === "attach.sock" || name === "a.sock";
  return name === "leader.sock" || name === "l.sock";
}

/**
 * #1548 —— `autoLeader` 是**必填**的,故意不给默认值。
 *
 * 🔴 背景:有些 grok build **按设计就不建 leader.sock**
 *    (`runtime.ts` 的能力表里 `autoLeader: false`,例如 1.0.5)。
 *    `runtime.ts` 的 `settleLeader()` 对这类 build 把 **ENOENT 当成功路径**;
 *    而本函数此前**无条件**要求 `leaderPresent`,于是这类节点上
 *    `usable` **结构性恒为 false** ⇒ 心跳的 `idle` 每 3 分钟被改写成 `blocked`,永远。
 *    实测:名册上 3 个 blocked 全是这类节点,非 grok 节点 0/114(#1548)。
 *    **同一个仓里两处对"该不该有 leader.sock"判断相反,而 leaderless 这个事实只写在一处。**
 *
 * 🔴 为什么必填而不是 `autoLeader = true`:带默认值的话,**漏传会静默恢复成老行为**
 *    —— 也就是恢复成这个缺陷本身,而且不会有任何东西红。
 *    做成必填,漏传就是编译错误:把一个安静的运行时缺陷换成一个吵闹的构建失败。
 */
export function describeGrokCopresenceLiveness(
  session: GrokCopresenceLivenessSource | null | undefined,
  autoLeader: boolean,
  inspect: GrokSocketInspector = grokSocketIsPresent,
): GrokCopresenceLiveness {
  if (!session) {
    return {
      tuiReady: false,
      childAlive: false,
      attach: { present: false, named: false },
      leader: { present: false, named: false },
      usable: false,
    };
  }
  const attachNamed = isNamedGrokCopresenceSocket(session.attachSocket, "attach");
  const leaderNamed = isNamedGrokCopresenceSocket(session.leaderSocket, "leader");
  const attachPresent = inspect(session.attachSocket);
  const leaderPresent = inspect(session.leaderSocket);
  const tuiReady = session.tuiReady === true;
  const childAlive = session.isRunning === true;
  // 🔴 两个方向都 fail-closed,和 `settleLeader()` 逐条对齐:
  //    · autoLeader:true  —— socket 必须**在**且名字对(老行为,一格没放松);
  //    · autoLeader:false —— socket 必须**不在**。它若出现,说明"这个 build 不外派工具"
  //      这个前提不成立,`settleLeader()` 在启动时就是这么 fail-closed 的
  //      (「verified as leaderless yet created …」)。这里不比它松。
  const leaderOk = autoLeader ? (leaderPresent && leaderNamed) : !leaderPresent;
  return {
    tuiReady,
    childAlive,
    attach: { present: attachPresent, named: attachNamed },
    leader: { present: leaderPresent, named: leaderNamed },
    usable: childAlive && tuiReady && attachPresent && attachNamed && leaderOk,
  };
}

export function resolveGrokCopresenceHubStatus(
  liveness: Pick<GrokCopresenceLiveness, "usable">,
  requested: GrokCopresenceHubStatus,
): GrokCopresenceHubStatus {
  if (requested === "offline") return "offline";
  if (!liveness.usable && (requested === "idle" || requested === "working")) {
    return "blocked";
  }
  return requested;
}
