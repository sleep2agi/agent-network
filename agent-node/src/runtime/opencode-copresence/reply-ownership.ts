/**
 * #1910 — reply ownership for a network turn injected into the shared
 * OpenCode copresence session.
 *
 * `POST /session/:id/message` answers with the assistant message that ended
 * the runner. The fast path accepts it when `info.parentID` is exactly the
 * user message we submitted. A long turn can legitimately break that
 * equality: OpenCode may compact the context mid-turn and continue from a
 * synthetic summary message, so the final assistant message is parented to
 * the summary, which in turn descends from our submission. That reply is
 * still ours. What must stay refused is a reply whose ancestry passes through
 * a *human* user message (the TUI won the idle-check → POST race), because
 * routing a human answer to CommHub would be a misdelivery.
 *
 * Heuristic for "human message" (OpenCode 1.18.1 exposes no authoritative
 * source flag on this REST lane): a `role:"user"` message other than our
 * submission that is not marked as a summary (`info.summary === true`, or a
 * part of type `compaction`/`summary`) and that carries at least one real
 * `text` part. Summary/compaction continuations are transparent links.
 */
export interface OwnershipMessage {
  info?: { id?: string; role?: string; parentID?: string; summary?: boolean };
  parts?: Array<{ type?: string; text?: string }>;
}

export type OwnershipVerdict =
  | { accepted: true; hops: number }
  | { accepted: false; reason: string };

const MAX_HOPS = 64;

export function isHumanUserMessage(message: OwnershipMessage, submittedId: string): boolean {
  const info = message?.info;
  if (!info || info.role !== "user") return false;
  if (info.id === submittedId) return false;
  if (info.summary === true) return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.some((p) => p?.type === "compaction" || p?.type === "summary")) return false;
  return parts.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim() !== "");
}

/**
 * Walk `info.parentID` links from the assistant reply's parent back towards
 * the submitted user message.
 */
export function ownershipChainVerdict(
  history: OwnershipMessage[] | null | undefined,
  submittedId: string,
  replyParentId: string | undefined,
): OwnershipVerdict {
  if (!submittedId) return { accepted: false, reason: "no submitted message id" };
  if (replyParentId === submittedId) return { accepted: true, hops: 0 };
  if (!replyParentId) return { accepted: false, reason: "reply has no parentID" };
  const byId = new Map<string, OwnershipMessage>();
  for (const m of Array.isArray(history) ? history : []) {
    const id = m?.info?.id;
    if (typeof id === "string" && id) byId.set(id, m);
  }
  const seen = new Set<string>();
  let cursor: string | undefined = replyParentId;
  let hops = 0;
  while (cursor && hops < MAX_HOPS) {
    if (cursor === submittedId) return { accepted: true, hops };
    if (seen.has(cursor)) return { accepted: false, reason: `parent chain loops at ${cursor}` };
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) return { accepted: false, reason: `parent ${cursor} not found in session history` };
    if (isHumanUserMessage(node, submittedId)) {
      return { accepted: false, reason: `parent chain passes through human message ${cursor}` };
    }
    cursor = node.info?.parentID;
    hops += 1;
  }
  return { accepted: false, reason: cursor ? `parent chain exceeded ${MAX_HOPS} hops` : "parent chain ended before the submitted message" };
}

export interface UnverifiedReplyError extends Error {
  unverifiedReplyText: string;
  unverifiedParentId: string | undefined;
  submittedMessageId: string;
  ownershipReason: string;
}

export function unverifiedOwnerError(
  replyText: string,
  parentId: string | undefined,
  submittedId: string,
  reason: string,
): UnverifiedReplyError {
  return Object.assign(new Error("OpenCode reply was not owned by the submitted network message"), {
    unverifiedReplyText: replyText,
    unverifiedParentId: parentId,
    submittedMessageId: submittedId,
    ownershipReason: reason,
  });
}
