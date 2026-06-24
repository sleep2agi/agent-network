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

const REPLY_PENDING_TTL_MS = 5 * 60 * 1000;

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

  const onEvent = opts.onEvent ?? selectDefaultEventHandler(adapter);
  await adapter.start(onEvent);
  return adapter;
}

function selectDefaultEventHandler(
  adapter: FeishuAdapter,
): (event: NormalizedIMEvent) => Promise<void> {
  if (typeof process.send === "function") {
    return createIPCEventHandler(adapter);
  }
  return defaultEventLogger;
}

/**
 * IPC handler — forwards inbound events to the parent agent-node and routes
 * the parent's reply back to Feishu via the adapter. The parent contract is
 * a single round-trip per event keyed on `idempotencyKey`.
 */
function createIPCEventHandler(
  adapter: FeishuAdapter,
): (event: NormalizedIMEvent) => Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error(
      "createIPCEventHandler: parent process.send unavailable (not forked)",
    );
  }

  const pending = new Map<string, NormalizedIMEvent>();

  process.on("message", (raw: unknown) => {
    if (!isReplyEnvelope(raw)) return;
    const event = pending.get(raw.eventKey);
    if (!event) return;
    pending.delete(raw.eventKey);

    const replyText = raw.text;
    const eventKey = raw.eventKey;
    void (async () => {
      try {
        await adapter.send({
          target: event.conversation,
          text: replyText,
          replyToMessageId: event.messageId,
          correlation: { taskId: eventKey },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[feishu:bridge] reply send failed: ${msg}\n`);
      }
    })();
  });

  return async (event: NormalizedIMEvent) => {
    pending.set(event.idempotencyKey, event);
    setTimeout(() => pending.delete(event.idempotencyKey), REPLY_PENDING_TTL_MS);
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
