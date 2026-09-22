// #1930 — decide whether a codex FIFO row that has reached the front of the
// queue should still start a turn, given one page of the node's unacked Hub
// inbox.
//
// Why a decision module: the row can be acked on the Hub while it waits
// (the model's own `ack_inbox` goes straight to the Hub; agent-node never
// sees it). Without this gate the row spends one turn producing an answer
// nobody can deliver. The gate must be fail-open: the only outcome that may
// drop work is "positively seen to be gone".
//
// `get_inbox` returns only `acked = 0` rows and carries no total, so a full
// page cannot prove absence — the row may sit beyond the page. That is the
// `page-full` verdict: start.

export const QUEUED_ROW_CHECK_LIMIT = 100;

export type QueuedRowVerdict =
  | { start: true; reason: "pending" | "unreadable" | "page-full" }
  | { start: false; reason: "gone" };

export function decideQueuedRowStart(input: {
  inboxId: string;
  page: unknown;
  limit: number;
}): QueuedRowVerdict {
  const messages = (input.page as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return { start: true, reason: "unreadable" };
  const present = messages.some(
    (m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === input.inboxId,
  );
  if (present) return { start: true, reason: "pending" };
  if (messages.length >= input.limit) return { start: true, reason: "page-full" };
  return { start: false, reason: "gone" };
}
