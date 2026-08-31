// `anet doctor` 每个节点后面印 `● running` / `○ stopped`,而它量的其实只是
// **本机 `.anet/nodes/<id>/.pid` 里的那个进程还在不在**。`anet node ls` 的
// STATUS 列量的是**另一件事** —— CommHub 说这个 alias 是什么状态。
//
// 🔴 实测两者会给出相反的答案:2026-08-31 本机 `通信牛` 的 `.pid` 记着 308103,
// 那个进程**已经死了**(doctor 说 stopped),而 hub 仍然报它 idle(node ls 说 idle)。
// 两句话都是真的,只是说的不是同一件事 —— 而两边都写成了无限定的 running/stopped,
// 用户拿到两个同样权威的相反答案,无从判断信哪个。
//
// 所以这里不改判据(它量得没错),改的是**它说自己量了什么**。
// 同族:doctor 的 0 节点那一格(#1660)也是"同一个数字对应两种现实,就把两种都说出来"。

export type LocalProcessState =
  | { kind: "alive"; pid: number }
  | { kind: "stale"; pid: number }   // 有 .pid,但那个进程已经不在了
  | { kind: "none" };                // 压根没有 .pid 记录

export function describeLocalProcess(state: LocalProcessState): string {
  switch (state.kind) {
    case "alive":
      return `● 本机进程存活 (pid ${state.pid})`;
    case "stale":
      return `○ 本机无存活进程 (.pid 记的 ${state.pid} 已不在)`;
    case "none":
      return `○ 本机没有 .pid 记录`;
  }
}

/** doctor 印完节点清单后的那一句:说清这一列量的是本机,不是 hub。 */
export const LOCAL_VS_HUB_NOTE =
  "上面这一列量的是本机进程;hub 那边怎么看要用 anet node ls 的 STATUS 列 —— " +
  "两者可以不一致(共存节点、hub 会话尚未过期、进程在别的机器上,都会造成这种情况)。";
