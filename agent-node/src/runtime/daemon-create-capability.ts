// #1545 —— 「这台 daemon 现在能不能创建节点」的求值,以及它**是什么时候求的**。
//
// 从 cli.ts 抽出来的原因很实际:cli.ts 是一个 9000 行的可执行脚本,顶层就在跑,
// **全仓没有任何测试 import 它**。而本次改动的核心恰恰在那里 ——
// 把「开机算一次、永久缓存」改成「每次上报重算」。一个没有测试的缓存移除,
// 和「我以为我移除了」在代码里长得一模一样(#1545 本身就是这类问题的集合)。
//
// 抽出来之后,下面三件事都能被钉住:
//   ① 连续调用**必须**每次都重新探测(缓存真的没了);
//   ② `detail` **不进返回值**(它带机器路径,会一路走到 Dashboard);
//   ③ 日志只在状态变化时打(每 3 分钟一次的心跳,无条件打印等于每天 480 行同一句话)。

import type { CreateNodesBlockedReason } from "./config-apply.js";

/** create-node-daemon.ts 的 `probeAnetBinReadiness` 的返回形状。
 *  这里**只声明所需的那部分**,不 import 那个模块 —— cli.ts 对它一直是按需
 *  `require` 的(非 daemon 节点不该为这一个函数拉进整个模块),保持同一策略。 */
export type AnetBinProbeResult =
  | { readonly state: "ready"; readonly abs: string }
  | { readonly state: "blocked"; readonly code: CreateNodesBlockedReason; readonly detail: string };

export type DaemonCreateCapability = {
  readonly ok: boolean;
  readonly reason?: CreateNodesBlockedReason;
  /** 这次判断是**什么时候**做出来的(本机 `Date.now()`)。
   *
   *  🔴 传时间点而不是直接传 0:如果将来有人重新引入缓存,这个数会**自己变大**,
   *     上报出去的年龄仍然是真的。传 0 的话,缓存一回来它就开始说谎,
   *     而且没有任何东西会红。 */
  readonly probedAtMs: number;
};

/** 只用于**日志去重**的状态。
 *  🔴 它不参与任何判断 —— 返回的能力值每次都是现算的。
 *     一个"只用来决定打不打日志"的变量,绝不能悄悄变成判据来源。 */
export type CreateCapabilityLogState = { last?: "ready" | CreateNodesBlockedReason };

export function evaluateCreateCapability(deps: {
  /** 节点 config.json 里的 role。非 host_supervisor 一律返回 undefined。 */
  readonly role: unknown;
  /** 注入的探针(生产里是 create-node-daemon.ts 的 `probeAnetBinReadiness`)。 */
  readonly probe: () => AnetBinProbeResult;
  readonly now: () => number;
  readonly log: (msg: string) => void;
  readonly logState: CreateCapabilityLogState;
}): DaemonCreateCapability | undefined {
  // 只对 host_supervisor 算。普通节点返回 undefined ⇒ 快照里完全不出现这几个字段,
  // 行为与 #1353 逐字相同。
  if (deps.role !== "host_supervisor") return undefined;

  const probedAtMs = deps.now();
  const probe = deps.probe();

  if (probe.state === "ready") {
    if (deps.logState.last !== "ready") {
      deps.log("[anet-daemon] #1545 create capability: ready (anet bin pin verified)");
      deps.logState.last = "ready";
    }
    return { ok: true, probedAtMs };
  }

  // 🔴 只报代码,**不报 probe.detail**。unsafePathHelp() 的消息里带完整机器路径
  //    (实测形如 /home/<用户名>/.nvm/versions/node/vXX/lib/node_modules/…),
  //    而返回值会一路走到 hub 和 Dashboard —— 一条「哪台机器的哪个路径缺什么」
  //    本身就是一张地图。原文只进 daemon 自己的日志,那里是本地的。
  //    **脱敏后上报也不行**:脱掉家目录后既仍是地图(node 版本、目录布局),
  //    又不足以定位。取舍是显式做的 —— code 全网可见,detail 只在本机。
  if (deps.logState.last !== probe.code) {
    deps.log(`[anet-daemon] #1545 create capability blocked: ${probe.code} — ${probe.detail}`);
    deps.logState.last = probe.code;
  }
  // 分类由探针给出,这里**不再有第二份 known 白名单**
  // (它原先在 cli.ts 里,和 create-node-daemon.ts 的分类是两份会各自漂移的判据)。
  return { ok: false, reason: probe.code, probedAtMs };
}
