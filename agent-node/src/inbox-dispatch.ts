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
