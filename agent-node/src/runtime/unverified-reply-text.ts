/**
 * #1910 — when a runtime refuses a reply it could not prove it owns, the
 * answer text still exists. Surface it inside the failed CommHub reply under
 * an explicit marker instead of discarding it, so the dispatcher can see what
 * the model produced (the turn may have had external side effects).
 */
export const UNVERIFIED_OWNER_MARKER = "[unverified-owner]";

export function runtimeErrorReplyText(runtime: string, err: unknown): string {
  const e = err as { message?: unknown; unverifiedReplyText?: unknown; ownershipReason?: unknown; userReplyText?: unknown } | null;
  // A runtime that knows the precise, truthful user-facing wording for its
  // failure (e.g. opencode copresence: "the task is still running in the TUI,
  // the bridge only stopped waiting") supplies it verbatim; prefixing it with
  // "<runtime> 错误:" would misstate what happened.
  if (typeof e?.userReplyText === "string" && e.userReplyText.trim()) return e.userReplyText;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const base = `${runtime} 错误: ${message}`;
  const unverified = typeof e?.unverifiedReplyText === "string" ? e.unverifiedReplyText.trim() : "";
  if (!unverified) return base;
  const reason = typeof e?.ownershipReason === "string" && e.ownershipReason ? `（${e.ownershipReason}）` : "";
  return `${base}\n\n${UNVERIFIED_OWNER_MARKER} 以下是该轮实际产出的回答原文，所有权未能验证${reason}，请人工核对：\n${unverified}`;
}
