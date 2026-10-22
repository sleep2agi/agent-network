/**
 * #1910 — when a runtime refuses a reply it could not prove it owns, the
 * answer text still exists. Surface it inside the failed CommHub reply under
 * an explicit marker instead of discarding it, so the dispatcher can see what
 * the model produced (the turn may have had external side effects).
 */
export const UNVERIFIED_OWNER_MARKER = "[unverified-owner]";

/** #1566: preserve semantic failure evidence before flattening it into text.
 * An unknown/foreign turn is not a vendor envelope authorizing resubmission.
 * OpenCodeProviderError has already passed the runtime's own capacity/side-effect
 * decision; the outer text heuristic must not override that decision either.
 */
export function runtimeFailureBlocksAutomaticRetry(error: unknown): boolean {
  const e = error as { code?: unknown; submittedMessageId?: unknown; ownershipReason?: unknown } | null;
  return e?.code === "opencode_copresence_timeout" || e?.code === "opencode_provider_error"
    || (typeof e?.submittedMessageId === "string" && typeof e?.ownershipReason === "string");
}

/** Process-local diagnostics only, never a claim that the underlying turn ended. */
export function opencodeTurnFailureDiagnostic(error: unknown, context: {
  taskId?: string | null; sessionId: string; generation: "v1" | "v2";
}) {
  if (!runtimeFailureBlocksAutomaticRetry(error)) return null;
  const e = error as { code?: unknown; phase?: unknown; submittedMessageId?: unknown; unverifiedParentId?: unknown };
  const id = (v: unknown, shape: RegExp) => typeof v === "string" && v.length <= 200 && shape.test(v) ? v : null;
  const messageId = (v: unknown) => id(v, /^msg_[A-Za-z0-9]+$/);
  return {
    event: "opencode_turn_wait_ended", source: "network", generation: context.generation,
    task_id: id(context.taskId, /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|task_[A-Za-z0-9_-]+)$/i),
    session_id: id(context.sessionId, /^ses_[A-Za-z0-9]+$/),
    submitted_message_id: messageId(e.submittedMessageId), reply_parent_id: messageId(e.unverifiedParentId),
    reason: e.code === "opencode_copresence_timeout" ? "wait_expired"
      : e.code === "opencode_provider_error" ? "provider_failed" : "ownership_refused",
    phase: e.phase === "admission" ? "admission" : "reply",
    runtime_outcome: "not_established", automatic_retry: false,
  } as const;
}

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
  return `${base}\n\n${UNVERIFIED_OWNER_MARKER} 以下是该轮实际产出的回答原文，所有权未能验证${reason}，请人工核对：\n${unverified}`;
}
