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

export async function dispatchInboxBatch<T>(
  messages: readonly T[],
  handler: (message: T) => Promise<void>,
): Promise<void> {
  for (const message of messages) await handler(message);
}

/**
 * Submit one Codex app-server inbox snapshot without waiting for the model
 * turns to finish. The serialized SSE drain must become free again as soon
 * as every row has entered bridge arbitration; otherwise a later SSE wake is
 * only marked dirty and sits behind the first row's (up to ten-minute) turn.
 *
 * The bounded dispatcher claims each Hub row key synchronously before calling
 * its async handler, deduplicates later snapshots, and queues N+1 work. Its
 * completion hook keeps reading beyond Hub's first unacked page. Completion
 * errors remain observable through `onError`.
 */
export interface DetachedInboxDispatcherStats {
  active: number;
  queued: number;
  accepted: number;
  deduplicated: number;
}

export interface DetachedInboxDispatcher<T> {
  submit(messages: readonly T[], handler: (message: T) => Promise<void>): DetachedInboxDispatcherStats;
  stats(): Pick<DetachedInboxDispatcherStats, "active" | "queued">;
}

/**
 * Keep detached inbox work bounded and deduplicated across later SSE snapshots.
 * The key is claimed before invoking the async handler, so two kicks in the
 * same tick cannot double-submit one Hub row. N+1 work waits in the local FIFO
 * and is started automatically when any active handler settles.
 */
export function createDetachedInboxDispatcher<T>(opts: {
  maxConcurrent: number;
  key: (message: T) => string;
  onError: (error: unknown) => void;
  onSettled?: () => void;
}): DetachedInboxDispatcher<T> {
  if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  const activeKeys = new Set<string>();
  const queuedKeys = new Set<string>();
  const queue: Array<{ message: T; handler: (message: T) => Promise<void> }> = [];

  const pump = () => {
    while (activeKeys.size < opts.maxConcurrent && queue.length > 0) {
      const item = queue.shift()!;
      const key = opts.key(item.message);
      queuedKeys.delete(key);
      // Claim before invoking handler: an async function runs synchronously
      // until its first await, but the dispatcher does not depend on that
      // language detail for cross-snapshot deduplication.
      activeKeys.add(key);
      let running: Promise<void>;
      try {
        running = item.handler(item.message);
      } catch (error) {
        running = Promise.reject(error);
      }
      void running
        .catch(opts.onError)
        .finally(() => {
          activeKeys.delete(key);
          try {
            opts.onSettled?.();
          } catch (error) {
            opts.onError(error);
          } finally {
            // Queue progress must not depend on a notification callback.
            // A thrown onSettled used to strand N+1 until another SSE arrived.
            pump();
          }
        });
    }
  };

  return {
    submit(messages, handler) {
      let accepted = 0;
      let deduplicated = 0;
      for (const message of messages) {
        const key = opts.key(message);
        if (activeKeys.has(key) || queuedKeys.has(key)) {
          deduplicated++;
          continue;
        }
        queuedKeys.add(key);
        queue.push({ message, handler });
        accepted++;
      }
      pump();
      return {
        active: activeKeys.size,
        queued: queue.length,
        accepted,
        deduplicated,
      };
    },
    stats() {
      return { active: activeKeys.size, queued: queue.length };
    },
  };
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
