// 决定 send_reply 的 `alias` 参数 —— 见 #1185 与任务 f015d9d6。
//
// 背景：node-server 用一个纯内存 Map（taskOriginators）记住 task_id → 发起方 alias，
// 只在 SSE 把任务推进本会话时写入。原来的取值是：
//
//     const originator = task_id ? (taskOriginators.get(task_id) || "hub") : "hub";
//
// 🔴 那个 `|| "hub"` 是一个**编出来的收件人**。映射未命中时它并不是"不知道"，
//    而是断言发起方是 hub。于是 hub 侧拿 "hub" 去比任务真正的 from_name：
//      · from_name 不是 hub ⇒ reply_target_mismatch，任务永远终结不了
//      · from_name 恰好是 hub ⇒ 更糟：回执静默投进错误的频道
//
// 映射未命中有**两个**触发条件，不止一个：
//   1. MCP/节点进程重启，Map 清空（#1185 记录的那个）
//   2. 会话在 SSE 推送到达**之前**就得知了任务（例如任务投递滞后、而 agent 从别处
//      发现它）。任务 f015d9d6 就是这一种：等推送迟到约 15 分钟落地之后，
//      同一个 task_id 重试立刻成功 —— 因为那时 Map 才被写上。
//
// 修法不是给 fallback 换一个更好的猜测，而是**不猜**：省略 alias，让 hub 从
// in_reply_to 反查 tasks.from_name（服务端 #1085 已经支持这条推导路径，
// server/src/tools.ts 的 "derive the reply target when the caller omitted alias"）。
// hub 掌握权威事实，节点内存不掌握。

export type ReplyAliasDecision =
  /** 把 alias 显式发出去 */
  | { readonly kind: "known"; readonly alias: string }
  /** 省略 alias，交给 hub 从 in_reply_to 推导 */
  | { readonly kind: "derive" }
  /** 没有 task_id 可推导：保持历史行为，发给 hub */
  | { readonly kind: "hub"; readonly alias: "hub" };

export function decideReplyAlias(
  taskId: string | null | undefined,
  lookup: (taskId: string) => string | undefined,
): ReplyAliasDecision {
  if (!taskId) return { kind: "hub", alias: "hub" };
  const known = lookup(taskId);
  // 空串/空白同样算未命中：一个空 alias 发出去会被 hub 当成「省略」以外的东西。
  if (typeof known === "string" && known.trim() !== "") {
    return { kind: "known", alias: known };
  }
  return { kind: "derive" };
}

/** 把决策摊成 send_reply 的参数片段。`derive` 时**不含** alias 键。 */
export function replyAliasArgs(d: ReplyAliasDecision): { alias?: string } {
  return d.kind === "derive" ? {} : { alias: d.alias };
}
