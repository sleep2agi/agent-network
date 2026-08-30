/**
 * `anet status` 的会话状态分类。
 *
 * 🔴 为什么单独成文件:原先它是 statusCommand 里的一个闭包,没有任何测试碰得到它 ——
 *    而它决定了运维看到的那三个数字。一个把「卡住」算成「在干活」的分类器,
 *    和一个正确的分类器,在输出上长得一模一样(都是一个数)。
 *
 * 🔴 改了什么:`blocked` / `error` 原先被折进 `working`。
 *    它们的含义是**需要人看一眼**,不是**正在推进**。
 *    运维看到「5 working」会认为一切正常,而其中可能有几个卡了很久 ——
 *    #1548 已经证明 `blocked` 是一个**没有出口**的状态:
 *    只有 report_completion 能把它拉回 idle,所以一个 agent 可以永远停在那里。
 *
 * `waiting_input` 保留在 working 里:它是一个**进行中的回合**在等人,
 * 与 blocked/error 不同 —— 那是回合本身出了问题。
 */
export type SessionClass = "idle" | "working" | "attention" | "offline";

export function classifySessionStatus(raw: unknown): SessionClass {
  const s = String(raw ?? "").toLowerCase();
  if (s === "offline") return "offline";
  // 需要人看一眼的:卡住、出错。**不算 working。**
  if (s === "blocked" || s === "error") return "attention";
  if (["working", "waiting_input", "running", "busy"].includes(s)) return "working";
  return "idle";
}
