export interface InboxDispatchMessage {
  type?: string;
  from_session?: string;
  meta?: unknown;
  meta_json?: string | null;
}

export function parseInboxDispatchMeta(message: InboxDispatchMessage): Record<string, unknown> | null {
  if (message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)) {
    return message.meta as Record<string, unknown>;
  }
  if (typeof message.meta_json !== "string" || message.meta_json.length === 0) return null;
  try {
    const parsed = JSON.parse(message.meta_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Only authenticated Dashboard chat tasks may steer a human-owned Codex turn.
 * `auth_origin` is stamped by the Hub from token facts, not trusted client
 * input. Pre-stamp rows deliberately remain ordinary FIFO tasks: an alias in
 * old Hub data is not an authentication fact and must not unlock steering.
 */
export function isInteractiveDashboardTask(message: InboxDispatchMessage): boolean {
  const type = message.type ?? "task";
  if (type !== "task" && type !== "broadcast") return false;
  const meta = parseInboxDispatchMeta(message);
  if (!meta || meta.source !== "dashboard-chat") return false;
  if (typeof meta.client_request_id !== "string" || !/^dreq_[a-f0-9]{32}$/.test(meta.client_request_id)) {
    return false;
  }
  return meta.auth_origin === "user";
}

/**
 * Codex app-server owns its own FIFO/steer arbitration, so inbox entries must
 * be submitted concurrently. Sequentially awaiting entry 1 recreates the
 * production head-of-line bug: entries 2..N cannot steer the same human turn.
 */
export async function dispatchInboxBatch<T>(
  messages: readonly T[],
  handler: (message: T) => Promise<void>,
  concurrent: boolean,
): Promise<void> {
  if (concurrent) {
    await Promise.all(messages.map((message) => handler(message)));
    return;
  }
  for (const message of messages) await handler(message);
}

/**
 * Submit one Codex app-server inbox snapshot without waiting for the model
 * turns to finish. The serialized SSE drain must become free again as soon
 * as every row has entered bridge arbitration; otherwise a later SSE wake is
 * only marked dirty and sits behind the first row's (up to ten-minute) turn.
 *
 * Calling the async handler directly is intentional: it runs synchronously
 * through its per-row inflight claim before yielding, so a following inbox
 * snapshot cannot double-submit the same row. Completion errors remain
 * observable through `onError` and can schedule a fresh inbox read.
 */
export function dispatchInboxBatchDetached<T>(
  messages: readonly T[],
  handler: (message: T) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  for (const message of messages) {
    try {
      void handler(message).catch(onError);
    } catch (error) {
      onError(error);
    }
  }
}

/**
 * A detached Codex row may be between "persist pending reply" and
 * "send/clear". Draining the durable reply queue concurrently in that
 * window can send the same reply twice, so only drain it when no Codex inbox
 * row is active. Other runtimes retain their historical behaviour.
 */
export function shouldDrainPendingReplies(runtime: string, inflightRows: number): boolean {
  return runtime !== "codex-app-server" || inflightRows === 0;
}
