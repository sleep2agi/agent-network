export interface TerminalPeerReply {
  id: string;
  from: string;
  content: string;
  taskId?: string;
}

export interface InboxTurnDeps<T = unknown> {
  deliverToRuntime: (message: TerminalPeerReply) => Promise<T>;
  acknowledge: (inboxId: string) => Promise<unknown>;
}

/**
 * Run every actionable inbox turn through the same policy seam. There is
 * deliberately no reply/send dependency in this API: a terminal peer result
 * is actionable context, not a new request. Keeping egress out of the helper
 * makes reply-to-reply recursion structurally impossible on that path while
 * ordinary tasks return their outcome to the caller for normal reply handling.
 */
export async function runInboxTurnByReplyPolicy<T>(
  message: TerminalPeerReply,
  replyExpected: boolean,
  deps: InboxTurnDeps<T>,
): Promise<{ kind: "request"; result: T } | { kind: "terminal_peer_reply"; result: T }> {
  const result = await deps.deliverToRuntime(message);
  if (replyExpected) return { kind: "request", result };
  await deps.acknowledge(message.id);
  return { kind: "terminal_peer_reply", result };
}

/** Production SSE routing seam: new_reply must wake the actionable inbox. */
export function routePeerReplySse(
  event: { type?: unknown },
  scheduleInboxDrain: () => void,
): boolean {
  if (event.type !== "new_reply") return false;
  scheduleInboxDrain();
  return true;
}
