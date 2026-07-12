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
 * Δ12 (副指挥 efde3938): `role: "unknown"` is NOT permitted on the
 * Agent-facing surface. The Agent MUST arrive with a concretely
 * classified role from CommHub's principal stamp. Legacy inbox rows
 * that pre-date the principal stamp (see 通信龙 task 404d7e19) are an
 * INTERNAL concern of the server / DB layer — they must be reclassified
 * or refused BEFORE reaching this contract. The parser rejects `role:
 * "unknown"` with `GatewayErrorCode.InvalidArg` and never advances the
 * request to the backend.
 *
 * Δ14 (副指挥 2860aebf; 通信龙 principal union): the role union closes
 * on the exact set `owner | admin | member | viewer | node | child`.
 *   - `node` is the minimum-privilege identity of a plain ntok node.
 *     It NEVER inherits the token owner's `owner` / `admin`; the
 *     server MUST classify node-identity requests as `node` even
 *     when they authenticate with a token whose account role would
 *     otherwise be higher.
 *   - `child` is the RFC-026 child-token identity.
 * Role classification MUST come from the server's authCtx resolution.
 * The authoritative sources depend on the caller kind (通信龙 rule
 * confirmed by 副指挥 task 2872f7a3):
 *   - utok network role  → `network_members`
 *   - REST global admin  → `users` / global auth
 *   - RFC-026 child kind → `api_tokens.role`
 *   - ntok `node` kind   → server-resolved token scope / kind
 * Role MUST NOT be inferred from a raw token prefix, an alias, or
 * any other client-supplied value.
 * ─────────────────────────────────────────────────────────────────────
 */
export interface AuthenticatedSender {
  /** Human-facing alias — for display / logs only. NEVER authoritative. */
  readonly alias: string;
  /** CommHub token identifier (from `api_tokens.token_id`). Authoritative. */
  readonly tokenId: string;
  /**
   * Bearer role at the time the CommHub inbox row landed. Concretely
   * classified — `"unknown"` is REFUSED at the Agent surface (Δ12
   * 副指挥 efde3938); legacy fallback lives internal to the server.
   * Δ14 closes the union on the 通信龙-decided principal set; see
   * the block comment above for the authCtx-resolution requirement.
   */
  readonly role: "admin" | "owner" | "member" | "viewer" | "node" | "child";
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
 *  have it survive the gateway's zod-strict parse (`protocol.ts`).
 *
 *  Δ14 (副指挥 2860aebf): id semantics pinned so the ledger + inbox
 *  layers can be built against a stable contract without a lifecycle
 *  break on retry / reassign. See per-field docs below.
 */
export interface EnqueueTaskArgs {
  /**
   * Canonical task identity. Stable across the ENTIRE reply lifecycle
   * of one logical task, including retries and cross-node reassigns.
   * The same taskId maps to the same ledger row, the same reply
   * channel, and the same upstream turn stream. If a task gets
   * retried on a different node or re-delivered after a crash, the
   * downstream layers keep threading state against this identity —
   * they see the retry as "the same task, another attempt", not as
   * a new task.
   *
   * Server / DB layer implication (通信龙 upcoming; final column
   * names land with B's migration): the `inbox` table carries a
   * canonical_task_id column (this value) that is IMMUTABLE for the
   * row's lifetime; `tasks` carries an IMMUTABLE `origin_principal`
   * stamped at first-seen. Retry / reassign never mints a fresh
   * taskId.
   */
  readonly taskId: TaskId;
  /**
   * Idempotency key for THIS specific inbox delivery attempt. Fresh
   * on every retry / reassign, so the gateway can dedup a re-delivery
   * of the same physical message without conflating it with a
   * DIFFERENT retry attempt on the same taskId.
   *
   * Invariant: `(taskId, messageId)` uniquely identifies a delivery
   * attempt. Two `enqueueTask` calls with the same `(taskId,
   * messageId)` MUST return `duplicate` — the second is a re-send,
   * not a new attempt. Two calls with same taskId but different
   * messageId are two attempts of the same logical task (retry
   * lineage), NOT two independent tasks — the gateway threads them
   * against the same ledger row.
   *
   * Initial delivery MAY use a messageId equal to the taskId as a
   * degenerate special case; every subsequent retry / reassign MUST
   * mint a fresh messageId so the delivery-attempt boundary is
   * observable.
   */
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
  /**
   * Reservation conflict — the requested TUI action is refused because
   * a bound owner IS present but currently holds the reservation for
   * a different party (e.g. reservation=agent, human asked for
   * turn/start). Distinct from `NoOwner`, which means NO owner has
   * been bound. Callers use this to render a friendly "Codex is busy"
   * hint instead of an authentication-shaped error.
   * Stable string code: `codex_gateway_busy`.
   * Per 副指挥 checkpoint 3 required delta #8 (task 4d8bd951).
   */
  Busy = -32057,
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
  [GatewayErrorCode.Busy]: "codex_gateway_busy",
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

/**
 * Typed exception surface for gateway backends (`lifecycle.ts` /
 * `human-owner.ts` implementations of `ProtocolBackend`). The dispatch
 * layer re-emits these as JSON-RPC errors with the exact `code` +
 * `data` the throw carries — no mapping to `InvalidArg`, no leakage of
 * the raw `Error.message` into the wire response.
 *
 * Any exception the backend can raise MUST be a `GatewayError`. Any
 * other exception (unexpected IO / DB / P0 bug) is sanitised by the
 * dispatch layer into `GatewayErrorCode.Unavailable` (JSON-RPC's
 * "internal error" -32001 slot). The Agent surface therefore never
 * sees a raw internal error message.
 *
 * Per 副指挥 Wave 1A checkpoint 2 required delta #3 (task f84942e8).
 */
export class GatewayError extends Error {
  public readonly gatewayCode: GatewayErrorCode;
  public readonly gatewayData: Readonly<Record<string, unknown>>;

  constructor(
    gatewayCode: GatewayErrorCode,
    message: string,
    gatewayData: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.gatewayCode = gatewayCode;
    this.gatewayData = gatewayData;
  }
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
