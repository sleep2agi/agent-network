/**
 * RFC-020 §2.5 / RFC-002 §2.2 — Feishu bridge worker.
 *
 * Entry point spawned by agent-node when a node profile has `channels.feishu`
 * enabled. Per Vincent 2026-06-24 decision, the first-cut is the simplified
 * "agent-node direct bridge" model, not the full commhub-gateway:
 *
 *   - This worker owns the FeishuAdapter and its WSClient connection.
 *   - Inbound IM event → access whitelist gate → forward to agent-node's main
 *     `think()` via parent IPC.
 *   - think() result → adapter.send() back to the originating conversation.
 *
 * Differences vs RFC-020 §2.5 full commhub-gateway path:
 *   - No separate gateway ntok_ / dedicated commhub alias.
 *   - IM messages do NOT pass through commhub task dispatch.
 *   - Feishu messages do NOT appear in Dashboard topology / Chat.
 *
 * The full §2.9 path (meta_json columns, SSE passthrough, persisted
 * IMCorrelationStore) lands as the follow-up PR after this demo ships
 * — tracked in #182.
 *
 * Milestones:
 *   M1: worker entry scaffold.
 *   M2: adapter + WSClient wiring with a noop event handler.
 *   M3 (this file): IPC contract for the think() round-trip — when running
 *                   as a forked child the bridge auto-uses `process.send` /
 *                   `process.on("message")`; standalone, it falls back to a
 *                   stderr logger so the inbound path stays observable.
 *   M4: agent-node spawn integration (fork(this) wired by agent-node).
 *   M5: group @bot trigger refinement, image up/down, Docker smoke.
 */
import type { NormalizedIMEvent } from "../types.js";
import { FeishuAdapter } from "./adapter.js";
import { loadFeishuChannelConfig } from "./config.js";

export interface FeishuBridgeOptions {
  /** Absolute path to `.anet/nodes/<node>/channels/feishu/`. */
  channelDir: string;
  /** Node alias — used for audit log + IPC framing. */
  nodeAlias: string;
  /**
   * Optional inbound event sink for tests or custom integrations. When omitted
   * the bridge picks an automatic strategy:
   *   - IPC handler when `process.send` exists (i.e. running as a forked
   *     child of agent-node).
   *   - stderr logger otherwise (standalone smoke debugging).
   */
  onEvent?: (event: NormalizedIMEvent) => Promise<void>;
}

// ── IPC contract with the agent-node parent (M3) ─────────────────────────

/** Bridge → parent: inbound IM event ready for think(). */
export interface BridgeIncomingEnvelope {
  type: "event";
  event: NormalizedIMEvent;
}

/** Parent → bridge: agent reply text for a previously-forwarded event. */
export interface BridgeReplyEnvelope {
  type: "reply";
  /** Echoes the originating event's idempotencyKey. */
  eventKey: string;
  text: string;
}

/** Default outbound-correlation TTL when channelConfig.taskTimeoutMs is unset.
 *  Bumped to 15min per 通信牛 review 必改3 — covers 95% of real think durations.
 *  Override via .anet/nodes/<n>/channels/feishu/config.json `taskTimeoutMs`. */
const DEFAULT_REPLY_PENDING_TTL_MS = 15 * 60 * 1000;

/** Idempotency dedup window — drop repeat events that arrive within this
 *  span (socket-reconnect replay). Independent of the outbound TTL above. */
const DEDUP_WINDOW_MS = 2 * 60 * 1000;

/**
 * Wire and start the Feishu bridge. Resolves once the underlying WSClient is
 * connected and the EventDispatcher is registered.
 */
export async function startFeishuBridge(
  opts: FeishuBridgeOptions,
): Promise<FeishuAdapter> {
  const channelConfig = loadFeishuChannelConfig(opts.channelDir);

  const adapter = new FeishuAdapter();
  await adapter.init({
    platform: "feishu",
    connectionName: opts.nodeAlias,
    ingressMode: "socket",
    groupPolicy: channelConfig.groupPolicy,
    ackPlaceholder: channelConfig.ackPlaceholder,
    auditRaw: channelConfig.auditRaw,
    taskTimeoutMs: channelConfig.taskTimeoutMs,
    platformConfig: channelConfig as unknown as Record<string, unknown>,
  });

  const ttlMs = channelConfig.taskTimeoutMs || DEFAULT_REPLY_PENDING_TTL_MS;
  const onEvent =
    opts.onEvent ??
    selectDefaultEventHandler(adapter, ttlMs, channelConfig.ackPlaceholder);
  await adapter.start(withDedup(onEvent));
  return adapter;
}

/**
 * Dedup wrapper — drops repeat events that arrive within DEDUP_WINDOW_MS
 * (RFC-020 §4.4 / 通信牛 review). Protects against socket-reconnect replay.
 * Sits in front of any other handler so the dropped event never reaches
 * IPC / think / send.
 */
function withDedup(
  inner: (event: NormalizedIMEvent) => Promise<void>,
): (event: NormalizedIMEvent) => Promise<void> {
  const seen = new Map<string, number>();
  return async (event: NormalizedIMEvent) => {
    const now = Date.now();
    // Lightweight GC — only when the map grows, sweep stale entries.
    if (seen.size > 200) {
      for (const [k, ts] of seen) {
        if (now - ts > DEDUP_WINDOW_MS) seen.delete(k);
      }
    }
    if (seen.has(event.idempotencyKey)) {
      process.stderr.write(
        `[feishu:bridge] dedup drop ${event.idempotencyKey}\n`,
      );
      return;
    }
    seen.set(event.idempotencyKey, now);
    await inner(event);
  };
}

function selectDefaultEventHandler(
  adapter: FeishuAdapter,
  ttlMs: number,
  ackPlaceholder: boolean,
): (event: NormalizedIMEvent) => Promise<void> {
  if (typeof process.send === "function") {
    return createIPCEventHandler(adapter, ttlMs, ackPlaceholder);
  }
  return defaultEventLogger;
}

interface PendingEntry {
  event: NormalizedIMEvent;
  /**
   * Message id of the "⏳ 处理中…" placeholder sent at event-arrival time.
   * Populated only when ackPlaceholder is true AND adapter.send succeeded.
   * When set, the reply / timeout handlers prefer adapter.edit over send.
   */
  placeholderMessageId?: string;
}

const ACK_PLACEHOLDER_TEXT = "⏳ 处理中…";
const TIMEOUT_NOTICE_TEXT = "[处理超时，任务可能仍在后台运行]";

/**
 * IPC handler — forwards inbound events to the parent agent-node and routes
 * the parent's reply back to Feishu via the adapter. The parent contract is
 * a single round-trip per event keyed on `idempotencyKey`.
 *
 * ackPlaceholder behavior (RFC-020 §4.2, Vincent ask 2026-06-26):
 *   - On event arrival, bridge sends a "⏳ 处理中…" placeholder into the
 *     originating thread BEFORE forwarding the IPC envelope. The placeholder
 *     send is awaited so the reply handler can edit it rather than racing
 *     with a possible early reply.
 *   - On reply IPC, if a placeholder exists, bridge calls adapter.edit to
 *     replace it with the agent's reply. Otherwise (placeholder send failed,
 *     or ackPlaceholder=false), bridge falls back to the original
 *     adapter.send path.
 *   - On TTL expiry, bridge edits the placeholder to "[处理超时…]" instead
 *     of sending a separate timeout notice. Without a placeholder, it falls
 *     back to send-new-message (same as 必改3-b behavior).
 *   - All success paths log to stderr so the round-trip is observable from
 *     the agent-node.log (closes Vincent's silent-success blindspot).
 *
 * On TTL expiry without reply (per 通信牛 review 必改3-b — never silent-drop)
 * the bridge surfaces a user-visible "[处理超时]" notice into the originating
 * conversation before evicting the pending entry. If the agent's real reply
 * arrives later, bridge's reply-envelope lookup will miss (entry already
 * evicted) and the late reply is dropped — the user already knows.
 */
/** @internal exported for test harness; not intended for production callers. */
export function createIPCEventHandler(
  adapter: FeishuAdapter,
  ttlMs: number,
  ackPlaceholder: boolean,
): (event: NormalizedIMEvent) => Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error(
      "createIPCEventHandler: parent process.send unavailable (not forked)",
    );
  }

  const pending = new Map<string, PendingEntry>();

  process.on("message", (raw: unknown) => {
    if (!isReplyEnvelope(raw)) return;
    const entry = pending.get(raw.eventKey);
    if (!entry) return;
    pending.delete(raw.eventKey);

    const replyText = raw.text;
    const eventKey = raw.eventKey;
    const { event, placeholderMessageId } = entry;
    void (async () => {
      // 必改1 (通信牛 review 2026-06-26): if the edit-by-placeholder path
      // fails, do NOT silently drop — fall back to a fresh adapter.send so
      // the user never sees an orphaned "⏳ 处理中…". The previous logic
      // already evicted pending above, so without this fallback the reply
      // would be lost forever.
      if (placeholderMessageId && adapter.edit) {
        try {
          await adapter.edit(event.conversation, placeholderMessageId, {
            target: event.conversation,
            text: replyText,
            correlation: { taskId: eventKey },
          });
          process.stderr.write(
            `[feishu:bridge] reply edited (placeholder=${placeholderMessageId}) for ${eventKey}\n`,
          );
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[feishu:bridge] reply edit failed (placeholder=${placeholderMessageId}): ${msg} — falling back to adapter.send\n`,
          );
          // fall through to send below
        }
      }
      try {
        const { messageId } = await adapter.send({
          target: event.conversation,
          text: replyText,
          replyToMessageId: event.messageId,
          correlation: { taskId: eventKey },
        });
        process.stderr.write(
          `[feishu:bridge] reply sent (messageId=${messageId}) for ${eventKey}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[feishu:bridge] reply delivery failed: ${msg}\n`);
      }
    })();
  });

  return async (event: NormalizedIMEvent) => {
    // Register pending FIRST so a fast reply path can find the entry even if
    // the placeholder send hasn't completed yet.
    pending.set(event.idempotencyKey, { event });

    // TTL — edits the placeholder when one exists, else sends a new notice.
    setTimeout(() => {
      const entry = pending.get(event.idempotencyKey);
      if (!entry) return; // reply already arrived
      pending.delete(event.idempotencyKey);
      const { placeholderMessageId } = entry;
      void (async () => {
        // 必改2 (通信牛 review 2026-06-26): symmetric with 必改1 — if the
        // timeout-edit fails, fall back to a fresh adapter.send so the user
        // is never left with a "⏳ 处理中…" placeholder that never resolves.
        if (placeholderMessageId && adapter.edit) {
          try {
            await adapter.edit(event.conversation, placeholderMessageId, {
              target: event.conversation,
              text: TIMEOUT_NOTICE_TEXT,
              correlation: { taskId: event.idempotencyKey },
            });
            process.stderr.write(
              `[feishu:bridge] timeout-edit (placeholder=${placeholderMessageId}) for ${event.idempotencyKey} after ${ttlMs}ms\n`,
            );
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[feishu:bridge] timeout edit failed (placeholder=${placeholderMessageId}): ${msg} — falling back to adapter.send\n`,
            );
            // fall through to send below
          }
        }
        try {
          await adapter.send({
            target: event.conversation,
            text: TIMEOUT_NOTICE_TEXT,
            replyToMessageId: event.messageId,
            correlation: { taskId: event.idempotencyKey },
          });
          process.stderr.write(
            `[feishu:bridge] timeout-notify sent for ${event.idempotencyKey} after ${ttlMs}ms\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[feishu:bridge] timeout-notify send failed: ${msg}\n`,
          );
        }
      })();
    }, ttlMs);

    // Optional placeholder — await so reply handler can prefer edit over send.
    // Failure is non-fatal; pending stays without a placeholderMessageId and
    // the reply / timeout handlers fall back to adapter.send.
    if (ackPlaceholder) {
      try {
        const { messageId } = await adapter.send({
          target: event.conversation,
          text: ACK_PLACEHOLDER_TEXT,
          replyToMessageId: event.messageId,
          correlation: { taskId: event.idempotencyKey },
        });
        const entry = pending.get(event.idempotencyKey);
        if (entry) {
          entry.placeholderMessageId = messageId;
          process.stderr.write(
            `[feishu:bridge] placeholder sent (messageId=${messageId}) for ${event.idempotencyKey}\n`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[feishu:bridge] placeholder send failed: ${msg} — fallback to new-message on reply\n`,
        );
      }
    }

    // Forward to parent for think().
    const envelope: BridgeIncomingEnvelope = { type: "event", event };
    process.send!(envelope);
  };
}

function isReplyEnvelope(raw: unknown): raw is BridgeReplyEnvelope {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    r["type"] === "reply" &&
    typeof r["eventKey"] === "string" &&
    typeof r["text"] === "string"
  );
}

async function defaultEventLogger(event: NormalizedIMEvent): Promise<void> {
  process.stderr.write(
    `[feishu:bridge] event from=${event.sender.id} ` +
      `conv=${event.conversation.conversationType}:${event.conversation.conversationId} ` +
      `mentioned=${event.mentioned} text=${(event.content.text ?? "").slice(0, 80)}\n`,
  );
}

export { FeishuAdapter } from "./adapter.js";
export { loadFeishuChannelConfig } from "./config.js";
export type {
  FeishuAccessList,
  FeishuChannelConfig,
  FeishuChannelEnv,
} from "./config.js";
