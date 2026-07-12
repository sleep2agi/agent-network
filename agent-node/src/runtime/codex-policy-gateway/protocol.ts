// RFC-030 Wave 1A — Policy Gateway: protocol layer.
//
// Pure state + pure functions. No I/O, no timers, no sockets. UDS wiring
// lives in `uds-server.ts`; this module only decides what the gateway
// should do with a message once bytes have been parsed into JSON. That
// makes every hazard the deliverable list points at (ID collision, out
// of order, reverse-request forgery, unknown method) directly testable
// without spinning up a Codex.
//
// Responsibilities:
//
//   1. Classify: given a parsed object, tell the caller whether it is a
//      request / response / notification / reverse-request / malformed
//      message. Mirrors `codex-app-server-client.ts`'s dispatch order
//      (see that file's header comment) — the only trustworthy way to
//      distinguish reverse-request from response is `method present +
//      id present` vs `id present + no method`.
//
//   2. Namespace-rewrite request ids across four independent scopes:
//
//         Agent   ←→   Gateway   ←→   Upstream (codex app-server)
//         TUI     ←→   Gateway   ←→   Upstream (codex app-server, reverse)
//
//      Agent-side ids and upstream-side ids share only a wire notion of
//      "id". They must not collide, they must survive out-of-order
//      response arrival, and the Agent must never see a raw upstream
//      id — otherwise the Wave-0 reverse-request lockout can be bypassed
//      by an Agent guessing that Codex will pick id=N and racing a
//      spoof response.
//
//   3. Enforce a method whitelist per direction. `enqueueTask` /
//      `getTaskState` / `cancelQueuedTask` / `runtimeState.subscribe`
//      are the only inbound methods the Agent socket accepts. Anything
//      else is rejected with `UnknownMethod` (`-32054`).
//
//   4. Virtualize `initialize` / `initialized` for the Agent socket.
//      The gateway holds its own real initialize handshake with the
//      upstream Codex; from the Agent's perspective the gateway is a
//      little JSON-RPC server that answers `initialize` immediately
//      with a canned server-info blob (no upstream round-trip). This
//      matches deliverable #2 in the 派工 spec.
//
// The state class here is deliberately synchronous — the caller (`uds-
// server.ts`) will hold one instance per Agent connection + one shared
// upstream instance and drive it from its socket read loop. Zero timers
// live here, so tests can assert exact allocation counts without racing.

import {
  asMessageId,
  asTaskId,
  GATEWAY_ERROR_DATA_CODE,
  GatewayError,
  GatewayErrorCode,
  type CancelQueuedTaskResult,
  type EnqueueTaskArgs,
  type EnqueueTaskResult,
  type GatewayErrorData,
  type MessageId,
  type TaskId,
  type TaskState,
} from "./contract";

// ────────────────────────────────────────────────────────────────────────
// Wire-level types (subset of JSON-RPC 2.0)
// ────────────────────────────────────────────────────────────────────────

/** JSON-RPC 2.0 request id. Numeric or string per spec. `null` is
 *  reserved for notifications sent via response and is treated as
 *  "no id" here (rejected). */
export type JsonRpcRequestId = number | string;

export interface JsonRpcRequestFrame {
  readonly jsonrpc?: "2.0";
  readonly id: JsonRpcRequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponseSuccessFrame {
  readonly jsonrpc?: "2.0";
  readonly id: JsonRpcRequestId;
  readonly result: unknown;
}

export interface JsonRpcResponseErrorFrame {
  readonly jsonrpc?: "2.0";
  readonly id: JsonRpcRequestId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponseFrame =
  | JsonRpcResponseSuccessFrame
  | JsonRpcResponseErrorFrame;

export interface JsonRpcNotificationFrame {
  readonly jsonrpc?: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

// ────────────────────────────────────────────────────────────────────────
// Message classification
// ────────────────────────────────────────────────────────────────────────

/**
 * The five outcomes the gateway will ever see from a parsed JSON body.
 * `reverse_request` and `request` share `method + id`; the only thing
 * that separates them is the DIRECTION the message came from — that's
 * the caller's job to decide, not `classifyMessage`'s. `classifyMessage`
 * only ever answers "what shape is this frame?".
 */
export type ClassifiedMessage =
  | {
    readonly kind: "request";
    readonly frame: JsonRpcRequestFrame;
  }
  | {
    readonly kind: "response";
    readonly frame: JsonRpcResponseFrame;
    readonly isError: boolean;
  }
  | {
    readonly kind: "notification";
    readonly frame: JsonRpcNotificationFrame;
  }
  | {
    readonly kind: "malformed";
    readonly reason: string;
  };

/**
 * Given a parsed JSON body, classify it. Pure. Reject anything that
 * isn't a plain object, that mixes `method` + `result`, that has an
 * id that's neither number nor string, and so on. The reason string
 * flows into logs / audit — never back to the sender.
 */
export function classifyMessage(raw: unknown): ClassifiedMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "malformed", reason: "not_a_json_object" };
  }
  const obj = raw as Record<string, unknown>;

  const hasMethod = typeof obj.method === "string";
  const hasId =
    Object.prototype.hasOwnProperty.call(obj, "id") &&
    (typeof obj.id === "number" || typeof obj.id === "string");
  const hasResult = Object.prototype.hasOwnProperty.call(obj, "result");
  const hasError = Object.prototype.hasOwnProperty.call(obj, "error");

  // Explicit refusals for shapes that MUST NOT be treated as either
  // requests or responses.
  if (Object.prototype.hasOwnProperty.call(obj, "id") && !hasId) {
    // Someone sent `id: null` or `id: {…}`.
    return { kind: "malformed", reason: "id_not_number_or_string" };
  }
  if (hasMethod && (hasResult || hasError)) {
    // JSON-RPC spec forbids this exact shape; it's likely a bug or an
    // attempt to smuggle a response through the request path.
    return { kind: "malformed", reason: "mixed_request_and_response" };
  }
  if (hasResult && hasError) {
    return { kind: "malformed", reason: "both_result_and_error" };
  }

  // Request-shaped (also the wire shape for reverse-request).
  if (hasMethod && hasId) {
    return {
      kind: "request",
      frame: {
        jsonrpc: "2.0",
        id: obj.id as JsonRpcRequestId,
        method: obj.method as string,
        params: obj.params,
      },
    };
  }

  // Notification.
  if (hasMethod && !hasId) {
    return {
      kind: "notification",
      frame: {
        jsonrpc: "2.0",
        method: obj.method as string,
        params: obj.params,
      },
    };
  }

  // Response.
  if (hasId && (hasResult || hasError)) {
    if (hasError) {
      const err = obj.error as Record<string, unknown> | null | undefined;
      if (
        !err ||
        typeof err !== "object" ||
        typeof err.code !== "number" ||
        typeof err.message !== "string"
      ) {
        return { kind: "malformed", reason: "error_object_bad_shape" };
      }
      return {
        kind: "response",
        isError: true,
        frame: {
          jsonrpc: "2.0",
          id: obj.id as JsonRpcRequestId,
          error: {
            code: err.code,
            message: err.message,
            data: err.data,
          },
        },
      };
    }
    return {
      kind: "response",
      isError: false,
      frame: {
        jsonrpc: "2.0",
        id: obj.id as JsonRpcRequestId,
        result: obj.result,
      },
    };
  }

  return { kind: "malformed", reason: "unknown_shape" };
}

// ────────────────────────────────────────────────────────────────────────
// Method whitelists per direction
// ────────────────────────────────────────────────────────────────────────

/**
 * Agent-side allowlist. Fixed closed set — the Agent runtime speaks
 * only the typed contract (contract.ts) + `initialize` / `initialized`
 * for bootstrap. Anything else → `UnknownMethod`.
 */
export const AGENT_ALLOWED_METHODS = new Set<string>([
  "initialize",
  "initialized",
  "enqueueTask",
  "getTaskState",
  "cancelQueuedTask",
  "runtimeState.subscribe",
  "runtimeState.unsubscribe",
]);

export function enforceMethodOnAgentSide(method: string): boolean {
  return AGENT_ALLOWED_METHODS.has(method);
}

// ────────────────────────────────────────────────────────────────────────
// TUI classification + policy hook (Wave 1A req delta #1, 副指挥 f84942e8)
// ────────────────────────────────────────────────────────────────────────

/**
 * The ONLY TUI-inbound methods A layer handles directly. Everything
 * else on the TUI socket is a Codex-protocol request the TUI needs
 * to drive (`thread/resume`, `thread/read`, `thread/status`,
 * `turn/start`, `turn/interrupt`, response frames to reverse requests,
 * etc.) — A does not enumerate that set. `classifyTuiRequest` marks
 * such frames as `policy_delegate` and the caller (uds-server.ts)
 * hands them to a `TuiPolicyHook` filled in by B. Concrete
 * bound-thread / scheduler policy stays out of A by design.
 */
export const TUI_BOOTSTRAP_METHODS = new Set<string>([
  "initialize",
  "initialized",
]);

/**
 * Methods reserved for the Agent typed contract. The TUI must NEVER
 * send these on its socket — that would be either a bug or an attempt
 * to smuggle an Agent-shaped request through the human side. A layer
 * rejects them before the policy hook runs.
 */
export const AGENT_RESERVED_METHODS = new Set<string>([
  "enqueueTask",
  "getTaskState",
  "cancelQueuedTask",
  "runtimeState.subscribe",
  "runtimeState.unsubscribe",
]);

/**
 * The outcome of A-layer classification for a TUI-inbound request.
 * `policy_delegate` is intentionally the LARGEST branch — everything
 * that isn't `initialize` / `initialized` and isn't reserved for the
 * Agent typed contract flows to B's policy hook.
 */
export type TuiClassifyOutcome =
  | { readonly kind: "bootstrap"; readonly method: "initialize" | "initialized" }
  | { readonly kind: "reserved_agent_method"; readonly method: string }
  | { readonly kind: "policy_delegate"; readonly method: string };

export function classifyTuiRequest(method: string): TuiClassifyOutcome {
  if (method === "initialize" || method === "initialized") {
    return { kind: "bootstrap", method };
  }
  if (AGENT_RESERVED_METHODS.has(method)) {
    return { kind: "reserved_agent_method", method };
  }
  return { kind: "policy_delegate", method };
}

/**
 * B fills this in with the concrete bound-thread / reservation /
 * scheduler / ledger policy (see 副指挥 Phase 1 policy on task
 * 7d70dcbd for the concrete Wave 1A rules). A layer only defines
 * the surface and calls the authorizer via `dispatchTuiRequest` —
 * no policy content leaks into A.
 *
 * The authorizer is only consulted for `policy_delegate` frames.
 * `bootstrap` frames are answered by A directly; `reserved_agent_
 * method` frames are rejected by A without consulting the authorizer.
 *
 * `verdict` is a required discriminant (per B guidance, 副指挥
 * ed3f92bf); `code` and `reason` are REQUIRED on `deny` outcomes so
 * every refusal carries a stable typed code + a human-readable
 * reason. Deny outcomes MAY carry additional diagnostic `extra`.
 */
export type TuiPolicyDecision =
  | { readonly verdict: "allow" }
  | {
    readonly verdict: "deny";
    readonly code: GatewayErrorCode;
    readonly reason: string;
    readonly extra?: Readonly<Record<string, unknown>>;
  };

/**
 * B fills this in. Renamed from `TuiPolicyHook` per B naming
 * (`TuiRequestAuthorizer`).
 */
export interface TuiRequestAuthorizer {
  /**
   * Return `verdict:"allow"` to forward the frame upstream (uds-
   * server.ts owns the actual forward), or `verdict:"deny"` with a
   * typed gateway code + reason. Async so the authorizer can consult
   * the scheduler / ledger / reservation table.
   */
  authorize(frame: JsonRpcRequestFrame): Promise<TuiPolicyDecision>;
}

/** @deprecated use `TuiRequestAuthorizer` — kept only for internal
 *  reviewer diffs; no re-exports outside this file. */
export type TuiPolicyHook = TuiRequestAuthorizer;

/**
 * A snapshot of the upstream Codex app-server initialize result,
 * captured by lifecycle.ts at gateway boot (exactly once) and cached.
 *
 * Delta 9 (副指挥 4d8bd951): the TUI is a NATIVE Codex client. Its
 * `initialize` MUST return upstream-shape metadata + capabilities, not
 * the Agent-facing `codex-policy-gateway/1 + enqueueTask...` shape —
 * that would fail the native TUI handshake at P0.
 *
 * A layer defines the interface; B / lifecycle.ts owns the concrete
 * `currentSnapshot()` (virtualizes / whitelists what fields are safe
 * to reflect to the TUI, and pins the exact Codex 0.144.0 shape).
 *
 * `currentSnapshot()` returns `undefined` during the brief window
 * between TUI connect and successful upstream init; `dispatchTuiRequest`
 * fails closed in that window with `Unavailable` rather than
 * fabricating.
 */
export interface TuiInitializeProvider {
  currentSnapshot(): Readonly<Record<string, unknown>> | undefined;
}

/**
 * Narrow diagnostics hook for internal (non-typed, non-Gateway)
 * exceptions bubbling out of the backend. Delta 10 (副指挥 4d8bd951):
 * `safeBackendCall` must NOT drop the exception on the floor — the
 * caller (uds-server) never sees exceptions raised INSIDE the safe
 * boundary, so A must feed them to a sink itself.
 *
 * Wire response gets a stable `data.correlationId` string but a
 * generic message. The full exception (raw message, stack, operation,
 * correlationId) is handed to `reportInternalError` for the operator
 * log. A layer defines the interface; B / lifecycle.ts owns the sink
 * (typically a structured logger with token/path scrubbing).
 *
 * `newCorrelationId()` is called once per unknown-throw event; the
 * same id lands in `data.correlationId` and in the log entry, so
 * the operator can correlate a support ticket to a log line.
 */
export interface ProtocolDiagnostics {
  newCorrelationId(): string;
  reportInternalError(entry: InternalErrorEntry): void;
}

export interface InternalErrorEntry {
  readonly correlationId: string;
  /** Symbolic operation label, e.g. `"enqueueTask"` or `"tui_policy_authorize"`. */
  readonly operation: string;
  /** The raw thrown value. May be any shape; the sink is expected to
   *  stringify + scrub. Never crosses the wire. */
  readonly error: unknown;
}

/**
 * Outcome of the A-layer TUI dispatcher. UDS server takes this and
 * either wires a bootstrap reply back to the TUI, forwards the frame
 * to upstream Codex, or writes a JSON-RPC error to the TUI socket.
 */
export type TuiDispatchOutcome =
  | { readonly kind: "bootstrap_reply"; readonly tuiId: JsonRpcRequestId; readonly result: unknown }
  | { readonly kind: "forward_upstream"; readonly frame: JsonRpcRequestFrame }
  | {
    readonly kind: "reject";
    readonly tuiId: JsonRpcRequestId;
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly data: GatewayErrorData;
  };

/**
 * Top-level TUI-inbound dispatcher. Bootstrap frames are answered
 * directly; reserved-agent-method frames are rejected as InvalidArg
 * (they should never appear on this socket); everything else is
 * handed to the injected authorizer — B decides.
 */
export async function dispatchTuiRequest(
  frame: JsonRpcRequestFrame,
  authorizer: TuiRequestAuthorizer,
  initProvider: TuiInitializeProvider,
  diagnostics: ProtocolDiagnostics,
): Promise<TuiDispatchOutcome> {
  const classified = classifyTuiRequest(frame.method);
  switch (classified.kind) {
    case "bootstrap": {
      if (classified.method === "initialize") {
        // Delta 9 (副指挥 4d8bd951): TUI is a NATIVE Codex client. Its
        // initialize MUST return the upstream Codex app-server
        // metadata (virtualized by the provider), NEVER the Agent
        // handshake shape. Fabricating would break P0 handshake.
        const snapshot = initProvider.currentSnapshot();
        if (snapshot === undefined) {
          // Upstream init hasn't completed yet — fail closed instead
          // of guessing a shape.
          return {
            kind: "reject",
            tuiId: frame.id,
            code: GatewayErrorCode.Unavailable,
            message: "upstream not initialized",
            data: makeErrorData(GatewayErrorCode.Unavailable, {
              source: "tui_initialize",
              reason: "upstream_not_initialized",
            }),
          };
        }
        return {
          kind: "bootstrap_reply",
          tuiId: frame.id,
          result: snapshot,
        };
      }
      // "initialized" — no-op ack.
      return { kind: "bootstrap_reply", tuiId: frame.id, result: {} };
    }
    case "reserved_agent_method": {
      return {
        kind: "reject",
        tuiId: frame.id,
        code: GatewayErrorCode.InvalidArg,
        message: `method '${classified.method}' is reserved for the Agent typed contract and MUST NOT arrive on the TUI socket`,
        data: makeErrorData(GatewayErrorCode.InvalidArg, {
          method: classified.method,
          reason: "reserved_for_agent_typed_contract",
        }),
      };
    }
    case "policy_delegate": {
      let decision: TuiPolicyDecision;
      try {
        decision = await authorizer.authorize(frame);
      } catch (e: unknown) {
        // Authorizer itself failed — sanitised Unavailable. Same
        // policy as an unknown backend throw on the Agent side; the
        // raw exception message is intentionally not surfaced. But
        // we DO log to the diagnostics sink so operators see it.
        const correlationId = diagnostics.newCorrelationId();
        diagnostics.reportInternalError({
          correlationId,
          operation: "tui_policy_authorize",
          error: e,
        });
        return {
          kind: "reject",
          tuiId: frame.id,
          code: GatewayErrorCode.Unavailable,
          message: "tui policy hook error",
          data: makeErrorData(GatewayErrorCode.Unavailable, {
            source: "tui_policy_hook",
            correlationId,
          }),
        };
      }
      if (decision.verdict === "allow") {
        return { kind: "forward_upstream", frame };
      }
      return {
        kind: "reject",
        tuiId: frame.id,
        code: decision.code,
        message: decision.reason,
        // Δ13 (副指挥 9a019ff4): decision.reason is the authoritative
        // deny reason and MUST NOT be shadowed by decision.extra.
        // Merge extra first, then write reason last so it wins.
        // (data.code is stable-code-guarded inside makeErrorData.)
        data: makeErrorData(decision.code, {
          ...(decision.extra ?? {}),
          reason: decision.reason,
        }),
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// TUI response frame handling — approval consumption path
// ────────────────────────────────────────────────────────────────────────

/**
 * Approvals arrive on the TUI socket as JSON-RPC RESPONSE frames
 * (not method requests): the human says "yes" or "no" to a
 * previously-dispatched reverse request from Codex. This path does
 * NOT go through the `TuiRequestAuthorizer` — it's purely a
 * namespace consume of a known pending reverse-request id.
 *
 * Phase 1 approvals are disabled (`approval=never`; the gateway
 * never sends a reverse request to the TUI). But the structure is
 * present so Phase 2 turn-on is a config change, not a code change.
 * Unknown or duplicate TUI id → fail closed (per B guidance, 副指挥
 * 7d70dcbd approval spoof rejection).
 *
 * The mux this consumes from is the SEPARATE reverse-namespace map
 * on `ReverseRequestNamespace` — not `UpstreamRequestMux` (which
 * multiplexes proxied-TUI + internal-scheduler upstream requests,
 * a distinct namespace).
 */
export type TuiResponseOutcome =
  | {
    readonly kind: "forward_reverse_response";
    readonly codexReverseId: JsonRpcRequestId;
    readonly frame: JsonRpcResponseFrame;
  }
  | {
    readonly kind: "reject";
    readonly tuiId: JsonRpcRequestId;
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly data: GatewayErrorData;
  };

export function handleTuiResponseFrame(
  frame: JsonRpcResponseFrame,
  reverse: ReverseRequestNamespace,
): TuiResponseOutcome {
  const codexReverseId = reverse.consumeCodexReverseByTuiId(frame.id);
  if (codexReverseId === null) {
    // Unknown or already-consumed id. Approval-spoof / replay
    // protection: fail closed. The TUI sender gets an error keyed
    // on the offending tuiId; the reverse request Codex is waiting
    // on stays untouched.
    return {
      kind: "reject",
      tuiId: frame.id,
      code: GatewayErrorCode.InvalidArg,
      message: "tui response id is unknown or already consumed",
      data: makeErrorData(GatewayErrorCode.InvalidArg, {
        reason: "reverse_id_unknown_or_duplicate",
        tuiId: frame.id,
      }),
    };
  }
  // Rewrite the response id back to the Codex reverse-request id and
  // let uds-server forward it upstream. `result` / `error` shape is
  // preserved verbatim — this layer never inspects the payload.
  const rewritten: JsonRpcResponseFrame = "error" in frame
    ? { jsonrpc: "2.0", id: codexReverseId, error: frame.error }
    : { jsonrpc: "2.0", id: codexReverseId, result: frame.result };
  return {
    kind: "forward_reverse_response",
    codexReverseId,
    frame: rewritten,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Request-id namespace mapping
// ────────────────────────────────────────────────────────────────────────

/**
 * P0 (副指挥 ed3f92bf): SINGLE upstream id allocator for BOTH kinds
 * of upstream request. There is no such thing as "Agent typed
 * request → upstream" — typed Agent methods (enqueueTask etc.) never
 * travel to Codex directly. They mutate the backend queue / ledger;
 * the scheduler decides when to send a `turn/start` upstream, and
 * every such internal request goes through the SAME allocator that
 * proxied-TUI requests use.
 *
 * The two origin kinds:
 *
 *   proxied_tui       — a raw TUI request that the authorizer allowed
 *                       upstream. Save the downstream TUI id so the
 *                       response can be rewritten back to the TUI.
 *
 *   internal          — a request the scheduler / lifecycle layer
 *                       makes to Codex on its own behalf (turn/start,
 *                       turn/interrupt, thread/status polls). Save an
 *                       opaque origin handle so the response arrives
 *                       back at the right internal resolver.
 *
 * Reverse requests (Codex → gateway → TUI) have a DIFFERENT namespace
 * — see `ReverseRequestNamespace` below. They must not multiplex
 * through this class because that would let a Codex reverse id
 * collide with an outbound upstream id in the same map.
 *
 * The upstream id counter is monotonic across both origin kinds, so
 * a raw TUI id=1 and an internal scheduler request never collide on
 * the wire to Codex. The B-side client's own `nextId++` no longer
 * participates: the client MUST consume this mux (the client PR is
 * separate; A owns this class).
 */

/**
 * Opaque origin handle for an internal scheduler upstream request.
 * The gateway doesn't inspect it; the lifecycle / scheduler layer
 * uses it to correlate a response back to its own state (Promise
 * resolver, task id + turn id, etc.). Parameterised so callers can
 * pin a concrete type.
 */
export type InternalRequestOrigin = unknown;

/**
 * Discriminated result of consuming an upstream response.
 */
export type UpstreamResponseOrigin<TInternal = InternalRequestOrigin> =
  | { readonly kind: "proxied_tui"; readonly tuiId: JsonRpcRequestId }
  | { readonly kind: "internal"; readonly origin: TInternal };

export class UpstreamRequestMux<TInternal = InternalRequestOrigin> {
  private nextUpstreamId = 1;

  /** Outstanding upstream requests, keyed by upstream id. */
  private readonly outstanding = new Map<number, UpstreamResponseOrigin<TInternal>>();

  /**
   * Dedup on the proxied side — an incoming TUI id already in flight
   * is a protocol violation and must be refused before allocation.
   * Internal callers don't dedup here (they're trusted; if they
   * accidentally reuse a handle it's a bug in B, not a protocol
   * violation).
   */
  private readonly tuiIdInFlight = new Set<string>();

  /**
   * Allocate an upstream id for a proxied TUI request. Refuses if the
   * TUI has an outstanding request with the same id (pending
   * duplicate). Returns the upstream id the gateway puts on the wire
   * to Codex.
   */
  allocateForProxiedTui(tuiId: JsonRpcRequestId): { upstreamId: number } | { collision: true } {
    const key = idKey(tuiId);
    if (this.tuiIdInFlight.has(key)) {
      return { collision: true };
    }
    const upstreamId = this.nextUpstreamId++;
    this.tuiIdInFlight.add(key);
    this.outstanding.set(upstreamId, { kind: "proxied_tui", tuiId });
    return { upstreamId };
  }

  /**
   * Allocate an upstream id for an internal scheduler request. The
   * `origin` handle is opaque — the caller passes anything (a Promise
   * resolver, a task+turn tuple, etc.). Never rejects; the internal
   * caller is trusted.
   */
  allocateForInternalScheduler(origin: TInternal): { upstreamId: number } {
    const upstreamId = this.nextUpstreamId++;
    this.outstanding.set(upstreamId, { kind: "internal", origin });
    return { upstreamId };
  }

  /**
   * Consume an upstream response. Returns the origin (proxied_tui or
   * internal) so the caller knows where to route the response, or
   * `null` if the upstream id is unknown or already consumed.
   * Consumption is one-shot per id.
   */
  consumeUpstreamResponse(upstreamId: JsonRpcRequestId): UpstreamResponseOrigin<TInternal> | null {
    if (typeof upstreamId !== "number") return null;
    const origin = this.outstanding.get(upstreamId);
    if (origin === undefined) return null;
    this.outstanding.delete(upstreamId);
    if (origin.kind === "proxied_tui") {
      this.tuiIdInFlight.delete(idKey(origin.tuiId));
    }
    return origin;
  }

  pendingCount(): number {
    return this.outstanding.size;
  }

  /** Diagnostic — number of pending upstream requests of a given kind. */
  pendingCountByKind(kind: "proxied_tui" | "internal"): number {
    let n = 0;
    for (const o of this.outstanding.values()) {
      if (o.kind === kind) n++;
    }
    return n;
  }

  /**
   * Delta 11 (副指挥 4d8bd951): TUI disconnect ≠ upstream disconnect.
   * Drop ONLY the proxied-TUI origins; internal scheduler resolvers
   * survive. Callers (human-owner.ts) invoke this when the TUI
   * disconnects; upstream requests the scheduler already sent stay
   * consumable so long-running Agent internal work isn't lost.
   *
   * Returns the number of proxied-TUI origins dropped, so operators
   * can log the churn.
   */
  drainProxiedTui(): number {
    let dropped = 0;
    for (const [upstreamId, origin] of this.outstanding) {
      if (origin.kind === "proxied_tui") {
        this.outstanding.delete(upstreamId);
        dropped++;
      }
    }
    this.tuiIdInFlight.clear();
    return dropped;
  }

  /**
   * Drop every pending origin. Reserved for FULL upstream shutdown /
   * restart — never called on plain TUI disconnect (use
   * `drainProxiedTui` for that so internal work is preserved).
   * lifecycle.ts owns rejecting any internal scheduler Promises.
   */
  drainAll(): void {
    this.outstanding.clear();
    this.tuiIdInFlight.clear();
  }
}

/**
 * Independent namespace for Codex → gateway REVERSE requests (server
 * → client), which flow to the TUI for approval. Kept SEPARATE from
 * `UpstreamRequestMux` because these ids live in a distinct wire
 * direction and mixing them in the same map would allow a Codex
 * reverse-request id to collide with an outbound upstream id.
 */
export class ReverseRequestNamespace {
  private nextTuiId = 1;

  private readonly codexReverseToTui = new Map<string, number>();
  private readonly tuiToCodexReverse = new Map<number, JsonRpcRequestId>();

  allocateTuiIdForCodexReverseRequest(codexReverseId: JsonRpcRequestId): { tuiId: number } | { collision: true } {
    const key = idKey(codexReverseId);
    if (this.codexReverseToTui.has(key)) {
      return { collision: true };
    }
    const tuiId = this.nextTuiId++;
    this.codexReverseToTui.set(key, tuiId);
    this.tuiToCodexReverse.set(tuiId, codexReverseId);
    return { tuiId };
  }

  consumeCodexReverseByTuiId(tuiId: JsonRpcRequestId): JsonRpcRequestId | null {
    if (typeof tuiId !== "number") return null;
    const codexId = this.tuiToCodexReverse.get(tuiId);
    if (codexId === undefined) return null;
    this.tuiToCodexReverse.delete(tuiId);
    this.codexReverseToTui.delete(idKey(codexId));
    return codexId;
  }

  pendingCount(): number {
    return this.codexReverseToTui.size;
  }

  /**
   * Drop every pending reverse mapping. `human-owner.ts` calls this
   * on TUI disconnect so a replayed reverse request can't be re-
   * approved after the owner leaves.
   */
  drainAll(): void {
    this.codexReverseToTui.clear();
    this.tuiToCodexReverse.clear();
  }
}

/**
 * JSON-RPC ids can be numbers or strings, and Map keys are
 * insertion-invariant on `===`. Coerce to a stable string so a
 * number `1` and a string `"1"` don't collide accidentally.
 */
function idKey(id: JsonRpcRequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

// ────────────────────────────────────────────────────────────────────────
// initialize / initialized virtualisation
// ────────────────────────────────────────────────────────────────────────

/**
 * Fixed metadata the gateway synthesises in response to an Agent-side
 * `initialize`. The real handshake with the upstream Codex happens
 * elsewhere (lifecycle.ts) exactly once per gateway boot; the Agent
 * gets this canned answer without a round-trip.
 *
 * `serverInfo.name` is deliberately the gateway's name, not Codex's —
 * the Agent is talking to the gateway, not to Codex.
 */
export interface AgentInitializeResult {
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * Advertised protocol name for the Agent typed contract. Pinned
   * exactly so a mismatched client aborts on handshake instead of
   * discovering the mismatch mid-turn.
   */
  readonly protocol: "codex-policy-gateway/1";
  /**
   * The set of methods the Agent socket accepts. Callers can log this
   * or use it as a permission check. Matches AGENT_ALLOWED_METHODS.
   */
  readonly methods: readonly string[];
}

/** Version pin. Bumped when the Agent-facing contract shape changes. */
export const GATEWAY_VERSION = "0.1.0-wave1a";

export function buildAgentInitializeResult(): AgentInitializeResult {
  return {
    serverInfo: {
      name: "codex-policy-gateway",
      version: GATEWAY_VERSION,
    },
    protocol: "codex-policy-gateway/1",
    methods: Array.from(AGENT_ALLOWED_METHODS).sort(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Method dispatch envelope shapes
// ────────────────────────────────────────────────────────────────────────

/**
 * The result of running a classified Agent request through the
 * protocol layer's dispatcher. UDS server takes this and writes the
 * corresponding JSON-RPC frame back to the Agent socket.
 *
 * Deliberately does not carry a `Response` object — the wire framing
 * lives in `uds-server.ts`. This is just the semantic outcome.
 */
export type AgentDispatchOutcome =
  | {
    readonly kind: "reply";
    readonly agentId: JsonRpcRequestId;
    readonly result: unknown;
  }
  | {
    readonly kind: "error";
    readonly agentId: JsonRpcRequestId;
    readonly code: GatewayErrorCode;
    readonly message: string;
    /** Structured `error.data` per RFC-030 B delta — always carries the
     *  stable `code: string` from GATEWAY_ERROR_DATA_CODE + zero or
     *  more diagnostic keys (e.g. field, queueDepth, limit). */
    readonly data: GatewayErrorData;
  }
  | {
    readonly kind: "notification_ack";
    /**
     * Notifications get no response by JSON-RPC spec; we return this
     * marker so the caller knows the message parsed cleanly + was
     * routed. Nothing goes on the wire.
     */
  };

/**
 * Reserved keys on `error.data` that come from the numeric error code
 * itself. Untrusted `extra` payloads (authorizer `decision.extra`,
 * `GatewayError.gatewayData`, unknown-throw context) MUST NOT be
 * allowed to override these — the numeric/string pair would decouple
 * and consumers keying on `data.code` would be lied to.
 *
 * Δ13 (副指挥 9a019ff4): `code` in particular was previously
 * override-able (extra was spread AFTER the code slot). Silent
 * dropping is preferred over throwing: the outbound frame stays valid
 * but with the authoritative stable code.
 */
const MAKE_ERROR_DATA_RESERVED_KEYS: readonly string[] = ["code"];

/**
 * Build the `data` payload for an error outcome.
 *
 * Order is CRITICAL (Δ13 副指挥 9a019ff4):
 *   1. Merge caller-supplied `extra` first, filtering out any keys in
 *      `MAKE_ERROR_DATA_RESERVED_KEYS`. A silently-dropped attempt to
 *      override `code` MUST NOT crash the wire response — it just gets
 *      discarded.
 *   2. THEN write the authoritative stable string code from
 *      `GATEWAY_ERROR_DATA_CODE` last, so it cannot be shadowed by
 *      anything the caller (or a hostile authorizer) supplied.
 *
 * Result: `data.code` (string) and the numeric outer `code` always
 * agree, regardless of what `extra` contains. Non-reserved diagnostic
 * keys (`field`, `queueDepth`, `limit`, `reason`, `source`,
 * `correlationId`, …) pass through untouched.
 */
function makeErrorData(
  code: GatewayErrorCode,
  extra?: Record<string, unknown>,
): GatewayErrorData {
  const filtered: Record<string, unknown> = {};
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) {
      if (MAKE_ERROR_DATA_RESERVED_KEYS.includes(k)) continue;
      filtered[k] = v;
    }
  }
  // Stable code lands LAST so it wins over any residual attempt.
  filtered.code = GATEWAY_ERROR_DATA_CODE[code];
  return filtered as GatewayErrorData;
}

// Strict allow-lists for `enqueueTask.params`. Any key OUTSIDE these
// sets is rejected at the wire boundary — top-level or nested. The
// previous banned-list approach (`method`, `threadId`, etc.) was
// incomplete: an attacker could smuggle any other unknown key
// (`evil`, `params`, arbitrary nested state) and be silently ignored
// by the destructure. The allowlist flips the default from "accept
// unless banned" to "reject unless explicitly allowed".
//
// Wave 1A req delta #2 (副指挥 f84942e8).
const ENQUEUE_TASK_ALLOWED_TOP_KEYS = new Set<string>([
  "taskId",
  "messageId",
  "authenticatedSender",
  "text",
]);

const AUTHENTICATED_SENDER_ALLOWED_KEYS = new Set<string>([
  "alias",
  "tokenId",
  "role",
  "networkId",
]);

/**
 * Δ12 (副指挥 efde3938): `"unknown"` is REFUSED at the Agent surface.
 * Legacy inbox rows without a principal stamp are the server / DB
 * layer's concern — they must be reclassified or refused before
 * reaching the gateway. If unknown ever appears here it is either a
 * mis-plumbed principal or a rogue client; fail closed either way.
 */
const AUTHENTICATED_SENDER_VALID_ROLES = new Set<string>([
  "admin", "owner", "member", "viewer", "child",
]);

/**
 * Parse an Agent-side `enqueueTask` params blob under a STRICT
 * allowlist. Both top-level and nested `authenticatedSender` are
 * closed sets — any extra key is refused. Missing required keys are
 * refused. Type mismatches are refused. Rejection carries the exact
 * offending field so tests + logs can spot smuggling attempts.
 *
 * The Wave-0 banned identifiers (method / threadId / turnId / policy /
 * path / config / requestId / jsonrpc / id) are ALL caught by this
 * allowlist for free — they aren't in
 * `ENQUEUE_TASK_ALLOWED_TOP_KEYS` or
 * `AUTHENTICATED_SENDER_ALLOWED_KEYS`, so their presence at any
 * level fails the check.
 */
export function parseEnqueueTaskParams(raw: unknown):
  | { ok: true; args: EnqueueTaskArgs }
  | { ok: false; field: string; reason: string }
{
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, field: "params", reason: "must be an object" };
  }
  const obj = raw as Record<string, unknown>;

  // Top-level allow-set gate — the source of a lot of previous
  // "silently ignored" bugs.
  for (const key of Object.keys(obj)) {
    if (!ENQUEUE_TASK_ALLOWED_TOP_KEYS.has(key)) {
      return { ok: false, field: key, reason: "not part of the Agent typed contract" };
    }
  }

  // Required-field presence check. `authenticatedSender` is validated
  // structurally below.
  for (const required of ENQUEUE_TASK_ALLOWED_TOP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, required)) {
      return { ok: false, field: required, reason: "required" };
    }
  }

  const { taskId, messageId, authenticatedSender, text } = obj;
  if (typeof taskId !== "string") return { ok: false, field: "taskId", reason: "must be a string" };
  if (typeof messageId !== "string") return { ok: false, field: "messageId", reason: "must be a string" };
  if (typeof text !== "string") return { ok: false, field: "text", reason: "must be a string" };
  if (text.length === 0) return { ok: false, field: "text", reason: "must be a non-empty string" };
  if (text.length > 128 * 1024) return { ok: false, field: "text", reason: "exceeds 128KB" };

  if (typeof authenticatedSender !== "object" || authenticatedSender === null || Array.isArray(authenticatedSender)) {
    return { ok: false, field: "authenticatedSender", reason: "must be an object" };
  }
  const s = authenticatedSender as Record<string, unknown>;

  // Nested allow-set gate on authenticatedSender.
  for (const key of Object.keys(s)) {
    if (!AUTHENTICATED_SENDER_ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        field: `authenticatedSender.${key}`,
        reason: "not part of the Agent typed contract",
      };
    }
  }

  // Fail-closed on missing principal fields per B delta security
  // contract (contract.ts AuthenticatedSender docstring).
  for (const required of AUTHENTICATED_SENDER_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(s, required)) {
      return { ok: false, field: `authenticatedSender.${required}`, reason: "required" };
    }
  }

  if (typeof s.alias !== "string" || s.alias.length === 0 || s.alias.length > 200) {
    return { ok: false, field: "authenticatedSender.alias", reason: "must be a string 1..200" };
  }
  if (typeof s.tokenId !== "string" || s.tokenId.length === 0 || s.tokenId.length > 200) {
    return { ok: false, field: "authenticatedSender.tokenId", reason: "must be a string 1..200" };
  }
  if (typeof s.networkId !== "string" || s.networkId.length === 0 || s.networkId.length > 200) {
    return { ok: false, field: "authenticatedSender.networkId", reason: "must be a string 1..200" };
  }
  if (typeof s.role !== "string" || !AUTHENTICATED_SENDER_VALID_ROLES.has(s.role)) {
    return { ok: false, field: "authenticatedSender.role", reason: "must be one of admin/owner/member/viewer/child" };
  }

  let brandedTaskId: TaskId;
  let brandedMessageId: MessageId;
  try {
    brandedTaskId = asTaskId(taskId);
    brandedMessageId = asMessageId(messageId);
  } catch (e: unknown) {
    return { ok: false, field: "taskId/messageId", reason: e instanceof Error ? e.message : "invalid brand" };
  }

  return {
    ok: true,
    args: {
      taskId: brandedTaskId,
      messageId: brandedMessageId,
      authenticatedSender: {
        alias: s.alias,
        tokenId: s.tokenId,
        role: s.role as EnqueueTaskArgs["authenticatedSender"]["role"],
        networkId: s.networkId,
      },
      text,
    },
  };
}

/**
 * Parse a `getTaskState` params blob. Args: `{ taskId }`.
 */
export function parseGetTaskStateParams(raw: unknown):
  | { ok: true; taskId: TaskId }
  | { ok: false; field: string; reason: string }
{
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, field: "params", reason: "must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length !== 1 || typeof obj.taskId !== "string") {
    return { ok: false, field: "taskId", reason: "params must be { taskId }" };
  }
  try {
    return { ok: true, taskId: asTaskId(obj.taskId) };
  } catch (e: unknown) {
    return { ok: false, field: "taskId", reason: e instanceof Error ? e.message : "invalid taskId" };
  }
}

/**
 * Parse a `cancelQueuedTask` params blob. Args: `{ taskId }`.
 */
export function parseCancelQueuedTaskParams(raw: unknown):
  | { ok: true; taskId: TaskId }
  | { ok: false; field: string; reason: string }
{
  return parseGetTaskStateParams(raw);
}

/**
 * Interface backend impls (lifecycle.ts, human-owner.ts) fulfil to
 * answer the parsed method. `protocol.ts` doesn't know how to enqueue
 * or query — it just routes. Kept slim so a test double is trivial.
 *
 * Throw contract: backends MAY throw a `GatewayError` to signal a
 * typed refusal (queue-full / no-owner / gateway state). Any OTHER
 * exception (unexpected IO / DB / P0 bug) is sanitised by the
 * dispatcher into `Unavailable`. Backends MUST NOT throw plain
 * `Error("bad taskId")`-style client-parameter refusals — those are
 * caught by the params parser before the backend is called, so a
 * throw here always means a gateway-side failure.
 */
export interface ProtocolBackend {
  enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult>;
  getTaskState(taskId: TaskId): Promise<TaskState>;
  cancelQueuedTask(taskId: TaskId): Promise<CancelQueuedTaskResult>;
}

/**
 * Uniform throw handling for backend calls. If the backend throws a
 * `GatewayError`, its typed `code` + `data` pass through verbatim.
 * Any other exception is sanitised into `Unavailable` — never blamed
 * on the client, and never leaks the raw `Error.message` to the wire.
 *
 * The internal exception is dropped on the floor here; the caller
 * (uds-server.ts) is expected to log it before invoking the dispatch.
 * That keeps the wire response free of leaked internals while still
 * leaving a diagnostic trail in operator logs.
 *
 * Wave 1A req delta #3 (副指挥 f84942e8).
 */
async function safeBackendCall<T>(
  agentId: JsonRpcRequestId,
  operation: string,
  op: () => Promise<T>,
  diagnostics: ProtocolDiagnostics,
): Promise<{ kind: "ok"; value: T } | { kind: "error"; outcome: AgentDispatchOutcome }> {
  try {
    return { kind: "ok", value: await op() };
  } catch (e: unknown) {
    if (e instanceof GatewayError) {
      return {
        kind: "error",
        outcome: {
          kind: "error",
          agentId,
          code: e.gatewayCode,
          message: e.message,
          data: makeErrorData(e.gatewayCode, e.gatewayData),
        },
      };
    }
    // Delta 10 (副指挥 4d8bd951): unknown / non-Gateway exception is
    // a P0 gateway-side failure (unexpected IO, DB, bug). We MUST:
    //   (1) generate a correlationId,
    //   (2) hand the raw exception + operation label to the injected
    //       diagnostics sink FIRST so operators see it,
    //   (3) return a wire response with a generic message + the same
    //       correlationId in `data`, and never the raw Error.message
    //       (which could leak file paths, tokens, or user input).
    const correlationId = diagnostics.newCorrelationId();
    diagnostics.reportInternalError({ correlationId, operation, error: e });
    return {
      kind: "error",
      outcome: {
        kind: "error",
        agentId,
        code: GatewayErrorCode.Unavailable,
        message: "gateway backend error",
        data: makeErrorData(GatewayErrorCode.Unavailable, {
          source: "backend",
          correlationId,
        }),
      },
    };
  }
}

/**
 * Top-level Agent-side dispatcher. Given a classified request frame,
 * return an `AgentDispatchOutcome` the UDS server can wire-frame back.
 * Handles the four contract methods + initialize/initialized virtualisation
 * + everything else → UnknownMethod.
 *
 * Async because the backend is async (task queue writes etc.). Zero
 * timers. Errors thrown by the backend surface as `error` outcomes with
 * `GatewayErrorCode.InvalidArg` — a well-behaved backend should never
 * throw, but if it does the caller isn't left waiting on an unresponded
 * request.
 */
export async function dispatchAgentRequest(
  frame: JsonRpcRequestFrame,
  backend: ProtocolBackend,
  diagnostics: ProtocolDiagnostics,
): Promise<AgentDispatchOutcome> {
  if (!enforceMethodOnAgentSide(frame.method)) {
    return {
      kind: "error",
      agentId: frame.id,
      code: GatewayErrorCode.UnknownMethod,
      message: `method '${frame.method}' is not in the Agent typed contract`,
      data: makeErrorData(GatewayErrorCode.UnknownMethod, { method: frame.method }),
    };
  }

  switch (frame.method) {
    case "initialize": {
      return {
        kind: "reply",
        agentId: frame.id,
        result: buildAgentInitializeResult(),
      };
    }
    case "initialized": {
      // Per JSON-RPC / MCP convention this is a notification; but some
      // clients still send it with an id. We accept both; if there's
      // an id, we reply with `{}` to close the request cleanly.
      return {
        kind: "reply",
        agentId: frame.id,
        result: {},
      };
    }
    case "enqueueTask": {
      const parsed = parseEnqueueTaskParams(frame.params);
      if (!parsed.ok) {
        return {
          kind: "error",
          agentId: frame.id,
          code: GatewayErrorCode.InvalidArg,
          message: `${parsed.field}: ${parsed.reason}`,
          data: makeErrorData(GatewayErrorCode.InvalidArg, { field: parsed.field, reason: parsed.reason }),
        };
      }
      const call = await safeBackendCall(frame.id, "enqueueTask", () => backend.enqueueTask(parsed.args), diagnostics);
      if (call.kind === "error") return call.outcome;
      return { kind: "reply", agentId: frame.id, result: call.value };
    }
    case "getTaskState": {
      const parsed = parseGetTaskStateParams(frame.params);
      if (!parsed.ok) {
        return {
          kind: "error",
          agentId: frame.id,
          code: GatewayErrorCode.InvalidArg,
          message: `${parsed.field}: ${parsed.reason}`,
          data: makeErrorData(GatewayErrorCode.InvalidArg, { field: parsed.field, reason: parsed.reason }),
        };
      }
      const call = await safeBackendCall(frame.id, "getTaskState", () => backend.getTaskState(parsed.taskId), diagnostics);
      if (call.kind === "error") return call.outcome;
      return { kind: "reply", agentId: frame.id, result: call.value };
    }
    case "cancelQueuedTask": {
      const parsed = parseCancelQueuedTaskParams(frame.params);
      if (!parsed.ok) {
        return {
          kind: "error",
          agentId: frame.id,
          code: GatewayErrorCode.InvalidArg,
          message: `${parsed.field}: ${parsed.reason}`,
          data: makeErrorData(GatewayErrorCode.InvalidArg, { field: parsed.field, reason: parsed.reason }),
        };
      }
      const call = await safeBackendCall(frame.id, "cancelQueuedTask", () => backend.cancelQueuedTask(parsed.taskId), diagnostics);
      if (call.kind === "error") return call.outcome;
      return { kind: "reply", agentId: frame.id, result: call.value };
    }
    case "runtimeState.subscribe":
    case "runtimeState.unsubscribe": {
      // The subscription lifecycle is handled by uds-server.ts (it
      // owns the socket that receives the events). Dispatching here
      // just acknowledges the request; the real bookkeeping is on the
      // socket layer. UDS server passes through to its subscription
      // manager and rewrites this outcome with the concrete result.
      return {
        kind: "reply",
        agentId: frame.id,
        result: { ok: true, note: "handled_by_uds_layer" },
      };
    }
    default: {
      return {
        kind: "error",
        agentId: frame.id,
        code: GatewayErrorCode.UnknownMethod,
        message: `method '${frame.method}' is not in the Agent typed contract`,
        data: makeErrorData(GatewayErrorCode.UnknownMethod, { method: frame.method }),
      };
    }
  }
}
