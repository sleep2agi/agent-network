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

// Rate-limit knobs (Vincent 2026-06-26 — paired with wildcard allowlist so
// open-bot deployments still have abuse protection).
const DM_RATE_LIMIT_COUNT = 3;
const DM_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const GROUP_RATE_LIMIT_COUNT = 2;
const GROUP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FLOOD_AUDIT_THRESHOLD = 3;
const FLOOD_AUDIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_NOTICE_TEXT = "处理频率超出限制，请稍后重试";

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
  // Middleware order: dedup → rate-limit → think.
  // Dedup runs first so socket-replay events don't burn rate-limit quota.
  // Rate-limit runs before `onEvent` (IPC handoff to think) so over-limit
  // events never hit the LLM at all.
  await adapter.start(withDedup(withRateLimit(onEvent, adapter)));
  return adapter;
}

/**
 * Dedup wrapper — drops repeat events that arrive within DEDUP_WINDOW_MS
 * (RFC-020 §4.4 / 通信牛 review). Protects against socket-reconnect replay.
 * Sits in front of any other handler so the dropped event never reaches
 * IPC / think / send.
 */
/** @internal exported for test harness. */
export function withDedup(
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

/**
 * Rate-limit wrapper — caps event arrival per-sender (DM) and per-chat
 * (group). Over-limit events get a user-visible "处理频率超出限制，请稍后重试"
 * message back via adapter.send (Vincent 2026-06-26 "never silent-drop").
 * Persistent abusers (≥ FLOOD_AUDIT_THRESHOLD denials in
 * FLOOD_AUDIT_WINDOW_MS) trigger an `[feishu:audit] flood ...` stderr line
 * so ops can grep for incidents.
 *
 * Sits AFTER withDedup so socket-replay events don't consume rate-limit
 * quota, and BEFORE the IPC handoff to think — over-limit events never
 * reach the LLM.
 *
 * @internal exported for test harness.
 */
export function withRateLimit(
  inner: (event: NormalizedIMEvent) => Promise<void>,
  adapter: FeishuAdapter,
): WithRateLimitHandle {
  // Sliding-window timestamp lists per identity. Trimmed lazily on each
  // call so a burst-then-quiet pattern doesn't leak memory.
  const dmTimes = new Map<string, number[]>();
  const groupTimes = new Map<string, number[]>();
  // Flood counter resets when its 60s window rolls over.
  const floodCounts = new Map<string, { count: number; windowStart: number }>();

  function trimWindow(times: number[], now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    return times.filter((t) => t >= cutoff);
  }

  // 通信牛 review 2026-06-26 preview.3 blocker — without this sweep, each
  // unique open_id / chat_id leaves a permanent entry in the Map. After
  // wildcard allowlist opens the bot to the org, unique-sender count is
  // unbounded → memory leak. Lazy GC fires whenever the Map grows past
  // RATE_LIMIT_GC_THRESHOLD entries; stale entries (no timestamp inside
  // the active window) get evicted. Mirrors withDedup's lazy-sweep
  // pattern.
  function sweepStale(
    map: Map<string, number[]>,
    now: number,
    windowMs: number,
  ): void {
    if (map.size <= RATE_LIMIT_GC_THRESHOLD) return;
    for (const [k, times] of map) {
      // entry is stale if every timestamp is outside the window
      const latest = times[times.length - 1] ?? 0;
      if (now - latest > windowMs) map.delete(k);
    }
  }
  function sweepStaleFlood(
    map: Map<string, { count: number; windowStart: number }>,
    now: number,
  ): void {
    if (map.size <= RATE_LIMIT_GC_THRESHOLD) return;
    for (const [k, entry] of map) {
      if (now - entry.windowStart > FLOOD_AUDIT_WINDOW_MS) map.delete(k);
    }
  }

  // Defense-in-depth (通信牛 review 2026-06-26 — preview.3 ship gate): if the
  // lazy GC didn't fire (or ran but the burst was so wide that every entry is
  // still in-window), evict the OLDEST entries until size <= cap. Caps the
  // worst-case Map footprint regardless of traffic shape.
  function enforceHardCapTimes(map: Map<string, number[]>, cap: number): void {
    if (map.size <= cap) return;
    const sorted: Array<[string, number]> = [];
    for (const [k, times] of map) sorted.push([k, times[times.length - 1] ?? 0]);
    sorted.sort((a, b) => a[1] - b[1]); // oldest first
    const drop = map.size - cap;
    for (let i = 0; i < drop; i++) map.delete(sorted[i][0]);
  }
  function enforceHardCapFlood(
    map: Map<string, { count: number; windowStart: number }>,
    cap: number,
  ): void {
    if (map.size <= cap) return;
    const sorted: Array<[string, number]> = [];
    for (const [k, entry] of map) sorted.push([k, entry.windowStart]);
    sorted.sort((a, b) => a[1] - b[1]);
    const drop = map.size - cap;
    for (let i = 0; i < drop; i++) map.delete(sorted[i][0]);
  }

  const wrapped = async (event: NormalizedIMEvent) => {
    const now = Date.now();
    // Lazy GC — runs at start so the current event's writes don't undercount.
    sweepStale(dmTimes, now, DM_RATE_LIMIT_WINDOW_MS);
    sweepStale(groupTimes, now, GROUP_RATE_LIMIT_WINDOW_MS);
    sweepStaleFlood(floodCounts, now);
    // Defense-in-depth — if lazy GC found nothing to evict but the Map is
    // huge anyway (e.g., a synchronous flood of unique senders inside one
    // window), force eviction of the oldest keys.
    enforceHardCapTimes(dmTimes, RATE_LIMIT_HARD_CAP);
    enforceHardCapTimes(groupTimes, RATE_LIMIT_HARD_CAP);
    enforceHardCapFlood(floodCounts, RATE_LIMIT_HARD_CAP);

    let overLimit = false;

    if (event.conversation.conversationType === "dm") {
      const senderId = event.sender.id;
      const trimmed = trimWindow(dmTimes.get(senderId) ?? [], now, DM_RATE_LIMIT_WINDOW_MS);
      if (trimmed.length >= DM_RATE_LIMIT_COUNT) {
        overLimit = true;
        dmTimes.set(senderId, trimmed);
      } else {
        trimmed.push(now);
        dmTimes.set(senderId, trimmed);
      }
    } else {
      // group / channel / thread — gate by chat id (after access check and
      // groupPolicy=mention have already qualified the message).
      const chatId = event.conversation.conversationId;
      const trimmed = trimWindow(groupTimes.get(chatId) ?? [], now, GROUP_RATE_LIMIT_WINDOW_MS);
      if (trimmed.length >= GROUP_RATE_LIMIT_COUNT) {
        overLimit = true;
        groupTimes.set(chatId, trimmed);
      } else {
        trimmed.push(now);
        groupTimes.set(chatId, trimmed);
      }
    }

    // Inline cleanup — if the current sender / chat's list went empty after
    // trim and we're NOT pushing a new timestamp (over-limit case), drop the
    // key. The under-limit branch always pushes, so it stays.
    if (overLimit) {
      const senderId = event.sender.id;
      const chatId = event.conversation.conversationId;
      if (event.conversation.conversationType === "dm") {
        const t = dmTimes.get(senderId);
        if (t && t.length === 0) dmTimes.delete(senderId);
      } else {
        const t = groupTimes.get(chatId);
        if (t && t.length === 0) groupTimes.delete(chatId);
      }
    }

    if (!overLimit) {
      await inner(event);
      return;
    }

    // Flood audit — count how many times this sender has been rate-limited.
    const senderId = event.sender.id;
    const existing = floodCounts.get(senderId);
    let flood: { count: number; windowStart: number };
    if (!existing || now - existing.windowStart > FLOOD_AUDIT_WINDOW_MS) {
      flood = { count: 1, windowStart: now };
    } else {
      flood = { count: existing.count + 1, windowStart: existing.windowStart };
    }
    floodCounts.set(senderId, flood);
    if (flood.count >= FLOOD_AUDIT_THRESHOLD) {
      process.stderr.write(
        `[feishu:audit] flood from=${senderId} conv=${event.conversation.conversationType}:${event.conversation.conversationId} — ${flood.count} rate-limit denies in ${Math.round((now - flood.windowStart) / 1000)}s window\n`,
      );
    }

    // Surface a user-visible notice (not silent — Vincent 2026-06-26 lock).
    try {
      await adapter.send({
        target: event.conversation,
        text: RATE_LIMIT_NOTICE_TEXT,
        replyToMessageId: event.messageId,
        correlation: { taskId: event.idempotencyKey },
      });
      process.stderr.write(
        `[feishu:bridge] rate-limited (${event.conversation.conversationType}) from=${senderId} for ${event.idempotencyKey}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[feishu:bridge] rate-limit notice send failed: ${msg}\n`,
      );
    }
  };

  // @internal — exposes Map sizes for the leak-regression test. Production
  // callers should not depend on this; the production type is just the
  // handler function.
  (wrapped as WithRateLimitHandle).__getState = () => ({
    dmKeyCount: dmTimes.size,
    groupKeyCount: groupTimes.size,
    floodKeyCount: floodCounts.size,
  });
  return wrapped as WithRateLimitHandle;
}

/** @internal — wrapped handler with state-inspection escape hatch for tests. */
export type WithRateLimitHandle = {
  (event: NormalizedIMEvent): Promise<void>;
  __getState(): {
    dmKeyCount: number;
    groupKeyCount: number;
    floodKeyCount: number;
  };
};

/** Trigger threshold for the rate-limit Map lazy GC sweep
 *  (mirrors withDedup's pattern — sweep when size grows). */
const RATE_LIMIT_GC_THRESHOLD = 50;

/** Hard cap on rate-limit Map size — defense in depth (通信牛 review
 *  preview.3 gate). When the lazy GC sweep doesn't dent the Map because the
 *  burst is wide enough that every entry is still in-window, evict the
 *  oldest entries until size <= cap. Bounds worst-case memory at ~10k
 *  open_ids / chat_ids each holding a short timestamp list. */
const RATE_LIMIT_HARD_CAP = 10_000;

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
   * Per Vincent 2026-06-26 design lock, the reply / timeout handlers do
   * NOT mutate this message — they always send a fresh in-thread message.
   * The field is kept for traceability (success logs cite it as
   * "(after placeholder=<id>)").
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
 *     is sent so the user gets an immediate push notification ("the bot saw
 *     my message"). The placeholder send is awaited so logs stay in order.
 *   - On reply IPC, bridge ALWAYS calls adapter.send for the final reply —
 *     a new message in the same thread, NOT an in-place edit of the
 *     placeholder. Vincent rejected the edit-in-place pattern 2026-06-26:
 *     pushing a fresh message gives him a second notification ("the bot
 *     replied") that an edit silently misses on most IM clients.
 *   - On TTL expiry without reply, bridge similarly send a NEW
 *     "[处理超时…]" message in-thread, never edits the placeholder.
 *   - adapter.edit remains in the IMAdapter interface for future use but is
 *     not called from this path. Tests in tests/feishu-bridge-* assert
 *     editCalls.length === 0 to lock that behavior in.
 *   - All success paths log to stderr so the round-trip is observable from
 *     the agent-node.log (closes the prior silent-success blindspot).
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
      // Vincent 2026-06-26 design lock — always send a NEW message for the
      // reply (no adapter.edit). The placeholderMessageId is logged for
      // traceability but is not used to mutate the placeholder. Users get
      // a second push notification when the reply lands.
      try {
        const { messageId } = await adapter.send({
          target: event.conversation,
          text: replyText,
          replyToMessageId: event.messageId,
          correlation: { taskId: eventKey },
        });
        const note = placeholderMessageId
          ? ` (after placeholder=${placeholderMessageId})`
          : "";
        process.stderr.write(
          `[feishu:bridge] reply sent (messageId=${messageId})${note} for ${eventKey}\n`,
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

    // TTL — sends a NEW timeout notice (no edit, per Vincent 2026-06-26).
    setTimeout(() => {
      const entry = pending.get(event.idempotencyKey);
      if (!entry) return; // reply already arrived
      pending.delete(event.idempotencyKey);
      const { placeholderMessageId } = entry;
      void (async () => {
        try {
          await adapter.send({
            target: event.conversation,
            text: TIMEOUT_NOTICE_TEXT,
            replyToMessageId: event.messageId,
            correlation: { taskId: event.idempotencyKey },
          });
          const note = placeholderMessageId
            ? ` (after placeholder=${placeholderMessageId})`
            : "";
          process.stderr.write(
            `[feishu:bridge] timeout-notify sent${note} for ${event.idempotencyKey} after ${ttlMs}ms\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[feishu:bridge] timeout-notify send failed: ${msg}\n`,
          );
        }
      })();
    }, ttlMs);

    // Optional placeholder — gives the user an immediate push notification
    // ("bot saw my message"). Awaited so logs stay chronological. Failure
    // is non-fatal; pending stays without a placeholderMessageId and the
    // reply / timeout handlers proceed as new-message sends regardless.
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
          `[feishu:bridge] placeholder send failed: ${msg} — reply will still send as a new message\n`,
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
