/**
 * #1910 — when a runtime refuses a reply it could not prove it owns, the
 * answer text still exists. Surface it inside the failed CommHub reply under
 * an explicit marker instead of discarding it, so the dispatcher can see what
 * the model produced (the turn may have had external side effects).
 */
export const UNVERIFIED_OWNER_MARKER = "[unverified-owner]";

/**
 * #2824 —— 「实际产出的原文」其实是**空产出的占位符**时，不要说「以下是原文」。
 *
 * 现场（2026-10-28，TMA客户端欧）：
 *
 *     opencode 错误: OpenCode reply was not owned by the submitted network message
 *     [unverified-owner] 以下是该轮实际产出的回答原文，所有权未能验证（…），请人工核对：
 *     [opencode: assistant returned no reply]
 *
 * 前一句承诺「以下是原文」，后一句却是一个「没有回复」的占位符 —— **自相矛盾**，
 * 读起来像节点拒绝干活。真实情况是：这一轮在产出最终答案前被人类插话打断，
 * 本来就没有可归属的正文。
 */
const NO_REPLY_PLACEHOLDER_RE = /^\[[\w-]+: assistant returned no reply\]$/;

export function runtimeErrorReplyText(runtime: string, err: unknown): string {
  const e = err as { message?: unknown; unverifiedReplyText?: unknown; ownershipReason?: unknown; userReplyText?: unknown } | null;
  // A runtime that knows the precise, truthful user-facing wording for its
  // failure (e.g. opencode copresence: the session was aborted, the abort
  // itself failed, or the turn was left running) supplies it verbatim; prefixing it with "<runtime> 错误:"
  // would misstate what happened.
  if (typeof e?.userReplyText === "string" && e.userReplyText.trim()) return e.userReplyText;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const base = `${runtime} 错误: ${message}`;
  const unverified = typeof e?.unverifiedReplyText === "string" ? e.unverifiedReplyText.trim() : "";
  if (!unverified) return base;
  const reason = typeof e?.ownershipReason === "string" && e.ownershipReason ? `（${e.ownershipReason}）` : "";
  // 没有真正的正文（只有占位符）时，别承诺「以下是原文」——改成一句能照着做的事。
  if (NO_REPLY_PLACEHOLDER_RE.test(unverified)) {
    return `${base}\n\n${UNVERIFIED_OWNER_MARKER} 这一轮在产出最终答案前被人类插话打断${reason}，`
      + "没有可归属的正文。请重派这条任务；节点日志里有该轮的现场。";
  }
  return `${base}\n\n${UNVERIFIED_OWNER_MARKER} 以下是该轮实际产出的回答原文，所有权未能验证${reason}，请人工核对：\n${unverified}`;
}
