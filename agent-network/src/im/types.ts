/**
 * RFC-020 §2.2–2.4 — IM Adapter abstraction + normalized event/message model.
 *
 * Contract layer for the IM platform compatibility layer. Each platform
 * (Feishu / Slack / WhatsApp / WeCom) implements `IMAdapter` against this
 * file; the IM Bridge (commhub-gateway, RFC-020 §2.5) consumes only these
 * normalized shapes and never touches platform SDKs directly.
 *
 * This file is contract only — no runtime behavior. See:
 *   docs/rfcs/RFC-020-im-platform-integration.md
 *   issue #182 (P0 abstraction tracker)
 */

// ── Ingress modes ───────────────────────────────────────────────────────────

/**
 * How an adapter receives inbound events from its platform.
 *
 * - `socket`  — long connection / WebSocket (Feishu WSClient, Slack Socket Mode).
 *               Runs agent-local without a public IP. Production preferred for
 *               P1 (Feishu) / P2 (Slack).
 * - `webhook` — HTTP callback (WhatsApp Cloud API, WeCom callback). Requires a
 *               public HTTPS endpoint; see RFC-020 §5.3.
 * - `polling` — adapter-driven polling. Dev / fallback only, not for production.
 */
export type IMIngressMode = "socket" | "webhook" | "polling";

// ── Per-channel config (opaque to the bridge) ──────────────────────────────

/**
 * Per-channel binding configuration loaded from
 * `.anet/nodes/<node>/channels/<platform>/config.json`. The Bridge passes this
 * object verbatim to `IMAdapter.init`. Adapter-specific fields live under
 * `platformConfig`; common fields (`allow`, `groupPolicy`, etc.) are read by
 * the Bridge itself.
 */
export interface IMChannelConfig {
  platform: string;
  connectionName: string;
  ingressMode: IMIngressMode;
  /** Default group trigger policy (RFC-020 §4.3). Adapter-agnostic. */
  groupPolicy?: "mention" | "command" | "all" | "observe";
  /** "Processing..." placeholder before agent reply (RFC-020 §4.2). */
  ackPlaceholder?: boolean;
  /** Retain raw payload on disk after redaction (RFC-020 §2.3 / §12.10). */
  auditRaw?: boolean;
  /** Per-task timeout in ms; default 5min (RFC-020 §4.5). */
  taskTimeoutMs?: number;
  /** Adapter-specific fields (App ID, signing secret, etc.). */
  platformConfig: Record<string, unknown>;
}

// ── Conversation reference ─────────────────────────────────────────────────

export interface IMConversationRef {
  platform: string;
  conversationId: string;
  conversationType: "dm" | "group" | "channel" | "thread";
  /** Slack `thread_ts` / Feishu `root_id` — set when replying in-thread. */
  threadRootId?: string;
}

// ── Inbound: normalized event from any platform ────────────────────────────

/**
 * Inbound IM event after adapter normalization. The Bridge maps this to a
 * commhub task (RFC-020 §4.1) and stores `meta.im` in `tasks.meta_json`
 * (RFC-020 §2.9).
 */
export interface NormalizedIMEvent {
  platform: string;
  /** `<node>#<platform>:<connectionName>` — uniquely identifies the binding. */
  connectionId: string;
  /** Feishu tenant / Slack team / WeCom corp / WhatsApp WABA id. */
  tenantId?: string;

  conversation: IMConversationRef;

  sender: { id: string; name?: string };
  /** Platform message id — core component of `idempotencyKey`. */
  messageId: string;
  /** Was this bot @-mentioned? Drives `triggerPolicy.group`. */
  mentioned: boolean;

  content: {
    text?: string;
    /** Local filesystem paths to already-downloaded images. */
    images?: string[];
    files?: { name: string; path?: string; url?: string }[];
  };

  /**
   * Original platform payload. Default: held in memory only and dropped after
   * normalization (RFC-020 §2.3 / §12.10) — payloads carry PII (phone numbers,
   * file URLs, user ids). Persisted only when `config.auditRaw === true`, and
   * even then only to a local redacted audit log. Never uploaded to the hub.
   */
  raw?: unknown;
  receivedAt: number;
  /** `${platform}:${connectionId}:${messageId}` (or platform `event_id`). */
  idempotencyKey: string;
}

// ── Outbound: normalized message back to a platform ────────────────────────

/**
 * Outbound message produced by the Bridge in response to a commhub reply,
 * or a P1.5+ active push (RFC-020 §12.9, gated behind a separate
 * `anet im send` tool). The adapter renders this into a platform-specific
 * payload.
 */
export interface NormalizedIMMessage {
  target: IMConversationRef;
  /** Plain text (default); split into chunks if it exceeds platform limits. */
  text?: string;
  /** Rich text (Feishu post / Slack mrkdwn). Optional, adapter may degrade. */
  markdown?: string;
  /** Interactive card (Feishu interactive / Slack Block Kit). Post-MVP. */
  card?: unknown;
  /** Local filesystem path to image to send. */
  imagePath?: string;
  files?: { name: string; path: string }[];
  /** Reply to a specific platform message id. */
  replyToMessageId?: string;
  /** Ephemeral / visible-to-sender-only. Slack only; others ignore. */
  ephemeral?: boolean;
  /** Tie back to the commhub task that produced this message. */
  correlation: {
    taskId: string;
    inReplyTo?: string;
  };
}

// ── Adapter health (for Dashboard, RFC-020 §6) ─────────────────────────────

export interface IMAdapterHealth {
  connected: boolean;
  lastEventAt: number | null;
  lastError: string | null;
  /** Optional, when the platform exposes it. */
  rateLimitRemaining?: number;
}

// ── Adapter contract ───────────────────────────────────────────────────────

/**
 * Platform adapter contract (RFC-020 §2.2). One implementation per platform.
 * The Bridge owns the lifecycle (init → start → … → stop) and never inspects
 * platform-specific fields beyond what comes back through this interface.
 */
export interface IMAdapter {
  readonly platform: string;
  readonly ingressMode: IMIngressMode;

  /** Initialize the platform SDK client. Does not open the connection. */
  init(config: IMChannelConfig): Promise<void>;

  /**
   * Begin receiving. `socket` adapters open a long connection; `webhook`
   * adapters register an HTTP route handler with the public ingress.
   * Inbound events flow through `onEvent`.
   */
  start(onEvent: (event: NormalizedIMEvent) => Promise<void>): Promise<void>;

  /** Stop receiving and release the connection. */
  stop(): Promise<void>;

  /** Send a normalized outbound message. Returns the platform message id. */
  send(message: NormalizedIMMessage): Promise<{ messageId: string }>;

  /**
   * Edit a previously-sent message (Feishu / Slack). Used to promote the
   * "processing..." placeholder into the final reply. Optional — adapters
   * without edit support omit this.
   */
  edit?(
    target: IMConversationRef,
    messageId: string,
    message: NormalizedIMMessage,
  ): Promise<void>;

  /**
   * Required for `webhook` adapters: verify the inbound request signature /
   * decrypt the payload. Failure must drop the request before it enters
   * commhub (RFC-020 §5.3). `socket` adapters may omit.
   */
  verifyWebhook?(headers: Record<string, string>, rawBody: Buffer): boolean;

  /** Health probe surfaced to the Dashboard via the Bridge. */
  health(): IMAdapterHealth;
}

// ── Bridge-side persistent state (RFC-020 §4.4 / §2.9④) ────────────────────

/**
 * Per-channel persistent state stored at
 * `.anet/nodes/<node>/channels/<platform>/state.db` (sqlite) or
 * `state.jsonl`. Both maps must survive Bridge restart — without them,
 * webhook dedup fails and outbound replies cannot find their IM conversation.
 */
export interface IMCorrelationStore {
  /** Dedup webhook retries / socket replays. */
  hasSeen(idempotencyKey: string): Promise<string | null>; // → taskId or null
  recordSeen(idempotencyKey: string, taskId: string): Promise<void>;

  /** Outbound routing: from commhub task id back to the IM conversation. */
  getCorrelation(taskId: string): Promise<IMTaskCorrelation | null>;
  putCorrelation(taskId: string, correlation: IMTaskCorrelation): Promise<void>;
  updateStatus(taskId: string, status: IMTaskCorrelation["status"]): Promise<void>;

  /** Periodic GC (default 24h TTL on terminal-state entries). */
  gc(now: number): Promise<{ removed: number }>;
}

export interface IMTaskCorrelation {
  conversationRef: IMConversationRef;
  sourceMessageId: string;
  /** Platform message id of the "processing..." placeholder, if any. */
  placeholderMessageId?: string;
  status: "pending" | "delivered" | "completed" | "failed" | "timeout";
  createdAt: number;
}
