// RFC-030 Wave 1A — Codex Policy Gateway: Agent-facing typed contract.
//
// This module is the ONLY surface the Agent Network runtime side may reach
// through when talking to the gateway. It exists so:
//
//   (a) The Agent's typed channel never sees raw JSON-RPC methods,
//       `threadId`, `turnId`, request-ids, policy strings, paths, or
//       codex `-c key=value` config. Those all live upstream of the
//       gateway; the gateway is the last hop that speaks Codex's wire
//       format. The Agent runtime speaks THIS module's types.
//
//   (b) Reverse requests (server → client — approval prompts, tool-input
//       requests, per RFC-030 §7.6) travel to the human owner's TUI only.
//       The Agent typed channel exposes NO request-id, NO response
//       constructor, NO way to reach into an outstanding reverse request.
//       Type-level: there is no member on any exported interface that
//       carries a reverse-request handle.
//
//   (c) The gateway sits between two Unix domain sockets (one Agent-side,
//       one TUI-side, per Wave 1A deliverable #1) and is the sole upstream
//       to `codex app-server`. This file declares the typed contract for
//       the Agent-side socket only.
//
// Everything in this file is pure TypeScript — types, discriminants, and
// error enums. No implementation. Protocol/UDS/lifecycle wiring lives in
// protocol.ts / uds-server.ts / human-owner.ts / lifecycle.ts.

// ────────────────────────────────────────────────────────────────────────
// Opaque IDs
// ────────────────────────────────────────────────────────────────────────

/**
 * Application-side handle for a task. Assigned by the Agent (must match
 * the CommHub inbox `task_id` for the gateway to correlate with lifecycle
 * events). NEVER a JSON-RPC request id. Different name on purpose so the
 * type system won't let the two mix.
 */
export type TaskId = string & { readonly __brand: "TaskId" };

/**
 * Dedup key. Assigned by the Agent to make `enqueueTask` idempotent per
 * inbox message. Same messageId re-submitted → the gateway returns the
 * existing task's status instead of enqueuing a duplicate.
 */
export type MessageId = string & { readonly __brand: "MessageId" };

/**
 * Opaque owner identity for the human running the TUI. Minted by the
 * gateway when the TUI attaches; used by lifecycle.ts to enforce a
 * single-owner lease. Agents cannot forge or read this value from the
 * typed contract — it's declared here so protocol.ts / human-owner.ts
 * can pass it through internal APIs, not so Agents can hold it.
 */
export type OwnerLeaseId = string & { readonly __brand: "OwnerLeaseId" };

// ────────────────────────────────────────────────────────────────────────
// enqueueTask
// ────────────────────────────────────────────────────────────────────────

/**
 * Sender principal proven upstream by CommHub (`authenticatedSender`).
 *
 * ─────────────────────────────────────────────────────────────────────
 * 🔒 SECURITY CONTRACT — do not weaken.
 *
 * The gateway MUST treat all three of `tokenId`, `role`, and `networkId`
 * as REQUIRED. `alias` is a human-visible label only — it may be
 * user-controlled, may be renamed at any moment, and MUST NEVER be used
 * for authorization. Any check that decides "should we accept this?"
 * keys on `tokenId` (`api_tokens.token_id`) and `role`, never `alias`.
 *
 * If any of `tokenId` / `role` / `networkId` is missing from the wire
 * payload, `parseEnqueueTaskParams` (protocol.ts) MUST fail closed and
 * refuse the request with `GatewayErrorCode.InvalidArg`. A gateway that
 * silently forge-fills `role: "member"` for a missing principal would
 * fail the reverse-request lockout invariant — the human owner would
 * approve a "member" that no upstream CommHub ever authenticated.
 *
 * The `unknown` role slot on the enum exists ONLY for parsing legacy
 * inbox rows that pre-date the principal stamp (see 通信龙 task
 * 404d7e19 on the server side). It is not a fallback the client is
 * allowed to send; parsers should treat inbound `role: "unknown"` as
 * fail-closed unless there's a specific policy tier that admits it.
 * ─────────────────────────────────────────────────────────────────────
 */
export interface AuthenticatedSender {
  /** Human-facing alias — for display / logs only. NEVER authoritative. */
  readonly alias: string;
  /** CommHub token identifier (from `api_tokens.token_id`). Authoritative. */
  readonly tokenId: string;
  /** Bearer role at the time the CommHub inbox row landed. */
  readonly role: "admin" | "owner" | "member" | "viewer" | "child" | "unknown";
  /**
   * The network this task was sent within. Cross-network dispatch is
   * refused upstream in CommHub; this is here only so the gateway can
   * assert the invariant when the payload is deserialised.
   */
  readonly networkId: string;
}

/** Arguments Agent runtime hands to the gateway to enqueue a task turn.
 *
 *  Deliberately narrow: `text` is a single UTF-8 string. Multi-part
 *  Codex input (image blocks etc.) is deferred to a later wave.
 *  There is NO `method`, NO `threadId`, NO `turnId`, NO `policy`, NO
 *  `path`, NO `config` on this interface — and no way to add one and
 *  have it survive the gateway's zod-strict parse (`protocol.ts`). */
export interface EnqueueTaskArgs {
  readonly taskId: TaskId;
  readonly messageId: MessageId;
  readonly authenticatedSender: AuthenticatedSender;
  /** UTF-8 task body. The gateway sanitises + injects the RFC-030 §6.4
   *  visible prefix (`[Agent Network]\nfrom: <alias>\ntype: task\n…`)
   *  before it goes upstream; the Agent supplies the raw semantic
   *  content only. */
  readonly text: string;
}

/** Success outcome for `enqueueTask`. `duplicate` is the idempotency
 *  path: same messageId re-submitted, gateway returns the prior task's
 *  handle with `queuePosition: null` so the Agent knows it was already
 *  accepted. */
export interface EnqueueTaskAccepted {
  readonly outcome: "accepted";
  readonly taskId: TaskId;
  /**
   * Zero-based position when the task was enqueued. `null` when the task
   * went straight to `starting` because the thread was idle, or when the
   * result is `duplicate` (position no longer meaningful).
   */
  readonly queuePosition: number | null;
  readonly duplicate: boolean;
}

/**
 * Refusal outcomes. All typed here so the Agent's `switch` on
 * `outcome` is exhaustive and no future refusal reason falls through
 * to `unknown`. See `GatewayErrorCode` below for the numeric mapping
 * the wire layer uses.
 */
export type EnqueueTaskRefused =
  | { readonly outcome: "refused_queue_full"; readonly queueDepth: number; readonly limit: number }
  | { readonly outcome: "refused_no_owner"; /** TUI not attached; see 通信龙 lease policy. */ }
  | { readonly outcome: "refused_shutting_down" }
  | { readonly outcome: "refused_invalid_arg"; readonly field: string; readonly reason: string };

export type EnqueueTaskResult = EnqueueTaskAccepted | EnqueueTaskRefused;

// ────────────────────────────────────────────────────────────────────────
// getTaskState + terminal outcomes
// ────────────────────────────────────────────────────────────────────────

/**
 * Task lifecycle discriminant. Terminal states are `completed`, `failed`,
 * `cancelled`, `approval_timeout`. All non-terminal states are safe to
 * re-poll.
 */
export type TaskState =
  | { readonly state: "unknown"; /** TaskId not known to the gateway (never enqueued or already GC'd). */ }
  | { readonly state: "queued"; readonly queuePosition: number }
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly startedAtMs: number }
  | { readonly state: "waiting_human"; readonly startedAtMs: number; readonly waitingSinceMs: number }
  | { readonly state: "completed"; readonly startedAtMs: number; readonly completedAtMs: number; readonly replyText: string }
  | { readonly state: "failed"; readonly startedAtMs: number; readonly failedAtMs: number; readonly errorSummary: string }
  | { readonly state: "cancelled"; readonly cancelledAtMs: number; readonly cancelledBy: "agent" | "owner" | "gateway" }
  | { readonly state: "approval_timeout"; readonly startedAtMs: number; readonly timeoutAtMs: number };

// ────────────────────────────────────────────────────────────────────────
// cancelQueuedTask
// ────────────────────────────────────────────────────────────────────────

export type CancelQueuedTaskResult =
  | { readonly outcome: "cancelled"; readonly cancelledAtMs: number }
  /** Task was already running / already terminal / never enqueued. */
  | { readonly outcome: "refused_not_queued"; readonly currentState: TaskState["state"] };

// ────────────────────────────────────────────────────────────────────────
// Read-only runtime state stream
// ────────────────────────────────────────────────────────────────────────

/**
 * Read-only summary of the gateway's runtime state. Emitted on any
 * material change (state transition, queue depth delta, owner lease
 * grant/revoke). The Agent runtime SUBSCRIBES to this — it cannot
 * publish or mutate it.
 *
 * Deliberately does NOT expose: thread id, turn id, active reverse
 * request id, socket path, codex binary path, config keys, or any raw
 * JSON-RPC payload. All those are internal to the gateway.
 */
export interface RuntimeStateEvent {
  readonly at: number;
  /** Gateway's own view of connectivity to codex app-server. */
  readonly connection: "disconnected" | "syncing" | "idle" | "starting" | "running" | "waiting_human" | "recovering";
  /** Whether a human owner is attached via the TUI socket right now. */
  readonly ownerAttached: boolean;
  /** Current queue depth (task turns waiting to start). */
  readonly queueDepth: number;
  /** Total tasks the gateway has seen since boot. Useful for dashboards. */
  readonly tasksSeen: number;
  /**
   * Machine-consumable version pins. The Agent uses these to abort
   * early if the gateway is talking to a wrong-major Codex binary
   * (Wave-0 decision: schema digest mismatch fails closed). Both are
   * strings so a hex digest is representable.
   */
  readonly codexBinaryVersion: string;
  readonly codexSchemaDigest: string;
  /**
   * Who currently holds the active turn reservation, per the scheduler
   * / ledger (B side).
   *   - `"none"` — no active reservation; queue is idle.
   *   - `"human"` — human TUI holds the current turn.
   *   - `"agent"` — an Agent Network task holds the current turn.
   *
   * Consumed by the Dashboard runtime panel; the Agent runtime uses it
   * as a hint for backoff / status display, NEVER for authorization
   * decisions. B scheduler is the authority; this field just surfaces
   * it read-only.
   */
  readonly activeReservationOwner: "none" | "human" | "agent";
  /**
   * Count of ambiguous-outcome events since gateway boot (turns whose
   * completion signal was inconclusive — e.g. reply text vs. tool call
   * disagreement, or a schema digest change mid-turn). Maintained by
   * the B scheduler / ledger side. Read-only surface; no mutation.
   */
  readonly ambiguousCount: number;
  /**
   * Count of failed turns since gateway boot (terminal `failed` state
   * on the ledger). Maintained by B; read-only surface.
   */
  readonly failedCount: number;
}

/**
 * Subscription handle. The Agent runtime attaches a listener and gets
 * a handle back; calling `.close()` unsubscribes. Read-only by
 * construction — there's no `.emit()` on this interface.
 */
export interface RuntimeStateSubscription {
  close(): void;
}

// ────────────────────────────────────────────────────────────────────────
// Public typed contract — the ONLY surface the Agent runtime touches
// ────────────────────────────────────────────────────────────────────────

/**
 * The gateway's typed API surface. protocol.ts wires this over the
 * Agent-side UDS with a zod-strict body schema, so any Agent-side attempt
 * to smuggle a `method` / `threadId` / `turnId` / `policy` / `path` /
 * `config` / `requestId` field through fails at parse time.
 *
 * Reverse requests (server → client) do NOT appear on this interface at
 * all. They're routed exclusively to the human owner via human-owner.ts
 * over the TUI socket. Agents can't observe reverse-request state, can't
 * hold a reverse-request id, and cannot construct a response.
 */
export interface AgentTypedContract {
  enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult>;
  getTaskState(taskId: TaskId): Promise<TaskState>;
  cancelQueuedTask(taskId: TaskId): Promise<CancelQueuedTaskResult>;

  /**
   * Subscribe to the read-only runtime state stream. `initial` fires
   * immediately with the current snapshot so the Agent doesn't need a
   * separate "poll once" call.
   */
  subscribeRuntimeState(listener: (event: RuntimeStateEvent) => void): RuntimeStateSubscription;
}

// ────────────────────────────────────────────────────────────────────────
// Error codes (numeric, for the wire layer)
// ────────────────────────────────────────────────────────────────────────

/**
 * Gateway-defined error codes. These land as `code` on the JSON-RPC
 * error payload the UDS layer emits to the Agent socket. -32001 is
 * reserved by JSON-RPC spec for "server error" — we route reconnect /
 * shutdown here so a well-behaved Agent client backs off correctly.
 * Everything else is in the -32050… application range to avoid
 * colliding with SDK error ranges the codex layer might reuse.
 *
 * On every error, the JSON-RPC `error.data` object carries a stable
 * string `code` field (from `GATEWAY_ERROR_DATA_CODE`) so callers that
 * don't want to key on the numeric can key on the string. The stable
 * string names are frozen once shipped; the numeric ids may only shift
 * within their reserved range if we ever need to renumber. Agent side
 * NEVER sees a raw upstream JSON-RPC error code — those are logged
 * internally and remapped to one of these, per Wave-0 lockout.
 */
export enum GatewayErrorCode {
  /** Standard JSON-RPC: gateway is going through reconnect / shutting down. */
  Unavailable = -32001,
  /** Payload didn't match the zod-strict schema for the requested method. */
  InvalidArg = -32050,
  /** Bounded queue is full. */
  QueueFull = -32051,
  /** No human owner attached; refusing on fail-closed lease policy. */
  NoOwner = -32052,
  /** Task id not known / already GC'd. */
  UnknownTask = -32053,
  /** Method the Agent asked for isn't in the typed contract. */
  UnknownMethod = -32054,
  /** Codex binary or schema digest doesn't match the pinned Wave-0 baseline. */
  CodexBaselineMismatch = -32055,
  /**
   * SQLite-backed sub-runtime declined the request (per B ledger A′
   * decision). Emitted when the ledger detects an unsupported ledger
   * migration state, an unsupported schema version, or an unsupported
   * operation against the current backing store. Stable string code:
   * `codex_gateway_sqlite_runtime_unsupported`.
   */
  SqliteRuntimeUnsupported = -32056,
}

/**
 * Stable string codes emitted on `error.data.code` alongside the
 * numeric `code`. Callers that prefer named keys over the numeric range
 * key on this. These strings are frozen once shipped and must not be
 * renamed without a Wave-2 revalidation with 副指挥 + consumers.
 *
 * Consumers should ALSO ignore any additional `data` fields they don't
 * know — the gateway may attach diagnostic context (e.g. `field`,
 * `queueDepth`, `limit`) that varies per code.
 */
export const GATEWAY_ERROR_DATA_CODE: Readonly<Record<GatewayErrorCode, string>> = {
  [GatewayErrorCode.Unavailable]: "codex_gateway_unavailable",
  [GatewayErrorCode.InvalidArg]: "codex_gateway_invalid_arg",
  [GatewayErrorCode.QueueFull]: "codex_gateway_queue_full",
  [GatewayErrorCode.NoOwner]: "codex_gateway_no_owner",
  [GatewayErrorCode.UnknownTask]: "codex_gateway_unknown_task",
  [GatewayErrorCode.UnknownMethod]: "codex_gateway_unknown_method",
  [GatewayErrorCode.CodexBaselineMismatch]: "codex_gateway_codex_baseline_mismatch",
  [GatewayErrorCode.SqliteRuntimeUnsupported]: "codex_gateway_sqlite_runtime_unsupported",
};

/**
 * Shape the gateway attaches on JSON-RPC `error.data` for every code.
 * The Agent surface reads this as a plain read-only record — no raw
 * upstream Codex error fields leak through, per Wave-0 lockout.
 *
 * Additional per-code fields (e.g. `field`, `queueDepth`, `limit`) may
 * appear here; readers must tolerate unknown keys.
 */
export interface GatewayErrorData {
  /** Stable string code — matches `GATEWAY_ERROR_DATA_CODE[numeric]`. */
  readonly code: string;
  /** Zero or more diagnostic keys. Read-only; caller must not mutate. */
  readonly [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────
// Branding helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Construct branded ids from raw strings. Runtime layer calls these
 * exactly once per received payload; nothing downstream ever unbrands.
 * Kept in this file so the branding invariants stay in one place.
 */
export function asTaskId(raw: string): TaskId {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new Error(`invalid TaskId: length ${raw?.length ?? "(non-string)"}`);
  }
  return raw as TaskId;
}

export function asMessageId(raw: string): MessageId {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new Error(`invalid MessageId: length ${raw?.length ?? "(non-string)"}`);
  }
  return raw as MessageId;
}

export function asOwnerLeaseId(raw: string): OwnerLeaseId {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new Error(`invalid OwnerLeaseId: length ${raw?.length ?? "(non-string)"}`);
  }
  return raw as OwnerLeaseId;
}
