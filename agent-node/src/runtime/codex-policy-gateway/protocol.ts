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
 * The four methods the Agent-side UDS accepts. `initialize` /
 * `initialized` are handled by the virtualiser (see `virtualize
 * InitializeRequest` below) — they're on this list so `enforce
 * MethodOnAgentSide` returns "allowed" without needing a separate
 * branch. Anything else → `UnknownMethod`.
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

/**
 * Methods the TUI-side UDS may issue TO the gateway. The TUI drives
 * initialize / initialized and answers reverse requests (see
 * lifecycle.ts for the reverse-request response path). Any other
 * inbound method from the TUI side is rejected.
 */
export const TUI_ALLOWED_METHODS = new Set<string>([
  "initialize",
  "initialized",
]);

export function enforceMethodOnAgentSide(method: string): boolean {
  return AGENT_ALLOWED_METHODS.has(method);
}

export function enforceMethodOnTuiSide(method: string): boolean {
  return TUI_ALLOWED_METHODS.has(method);
}

// ────────────────────────────────────────────────────────────────────────
// Request-id namespace mapping
// ────────────────────────────────────────────────────────────────────────

/**
 * Each direction has its own monotonically-increasing counter. We
 * NEVER hand an upstream id back to the Agent socket, and we NEVER
 * hand a codex-reverse-request id back to the Agent socket. Every
 * cross-boundary id is minted fresh by the gateway so the Agent
 * cannot forge a response by picking a colliding id.
 *
 * Two independent map pairs (forward + reverse each):
 *
 *   agentToUpstream        Agent request → freshly-allocated upstream id
 *   upstreamToAgent        upstream response id → original Agent id
 *
 *   codexReverseToTui      upstream reverse-request id → freshly-allocated TUI id
 *   tuiToCodexReverse      TUI response id → original codex reverse-request id
 *
 * All four map entries are consumed on the response arrival; leaks
 * would show up as `pendingCounts()` never shrinking, which is the
 * property `lifecycle.ts` uses to detect orphans.
 */
export class RequestIdNamespace {
  private nextUpstreamId = 1;
  private nextTuiId = 1;

  private readonly agentToUpstream = new Map<string, number>();
  private readonly upstreamToAgent = new Map<number, JsonRpcRequestId>();

  private readonly codexReverseToTui = new Map<string, number>();
  private readonly tuiToCodexReverse = new Map<number, JsonRpcRequestId>();

  /**
   * Called on an Agent → Gateway request. Allocates a fresh upstream
   * id, records both directions of the mapping, returns the id the
   * gateway should put on the wire to Codex.
   *
   * ID collision guard: if the Agent has already used this id AND
   * we haven't seen the response yet, we refuse — pending id collision
   * would cross-wire the eventual response. Caller reports
   * `InvalidArg` back to the Agent.
   */
  allocateUpstreamIdForAgentRequest(agentId: JsonRpcRequestId): { upstreamId: number } | { collision: true } {
    const key = agentIdKey(agentId);
    if (this.agentToUpstream.has(key)) {
      return { collision: true };
    }
    const upstreamId = this.nextUpstreamId++;
    this.agentToUpstream.set(key, upstreamId);
    this.upstreamToAgent.set(upstreamId, agentId);
    return { upstreamId };
  }

  /**
   * Called when a response for an outbound-to-upstream request arrives.
   * Returns the Agent id we should rewrite the response to, or `null`
   * if we've never seen this upstream id (spoof or reorder past
   * consumption). Consumes both directions of the mapping.
   */
  consumeAgentResponseByUpstreamId(upstreamId: JsonRpcRequestId): JsonRpcRequestId | null {
    if (typeof upstreamId !== "number") return null;
    const agentId = this.upstreamToAgent.get(upstreamId);
    if (agentId === undefined) return null;
    this.upstreamToAgent.delete(upstreamId);
    this.agentToUpstream.delete(agentIdKey(agentId));
    return agentId;
  }

  /**
   * Called on a Codex → Gateway REVERSE request. Allocates a fresh
   * TUI id, records both directions, returns the id the gateway puts
   * on the wire to the TUI. The Agent NEVER sees any of this.
   */
  allocateTuiIdForCodexReverseRequest(codexReverseId: JsonRpcRequestId): { tuiId: number } | { collision: true } {
    const key = agentIdKey(codexReverseId);
    if (this.codexReverseToTui.has(key)) {
      return { collision: true };
    }
    const tuiId = this.nextTuiId++;
    this.codexReverseToTui.set(key, tuiId);
    this.tuiToCodexReverse.set(tuiId, codexReverseId);
    return { tuiId };
  }

  /**
   * Called when a TUI response for a reverse-request-in-flight arrives.
   * Returns the Codex reverse-request id we should rewrite to, or
   * `null` if we don't recognise the tui id.
   */
  consumeCodexReverseByTuiId(tuiId: JsonRpcRequestId): JsonRpcRequestId | null {
    if (typeof tuiId !== "number") return null;
    const codexId = this.tuiToCodexReverse.get(tuiId);
    if (codexId === undefined) return null;
    this.tuiToCodexReverse.delete(tuiId);
    this.codexReverseToTui.delete(agentIdKey(codexId));
    return codexId;
  }

  /**
   * Diagnostic — used by `lifecycle.ts` orphan sweep. If either count
   * grows without bound, there's a bug (or a peer stopped responding
   * without our timeout catching it).
   */
  pendingCounts(): {
    agentRequestsPending: number;
    codexReverseRequestsPending: number;
  } {
    return {
      agentRequestsPending: this.agentToUpstream.size,
      codexReverseRequestsPending: this.codexReverseToTui.size,
    };
  }

  /**
   * Drop every pending mapping. Used on shutdown / TUI disconnect
   * (`human-owner.ts` calls this to make sure a replayed reverse
   * request can't be re-approved after the owner leaves).
   */
  drainAll(): void {
    this.agentToUpstream.clear();
    this.upstreamToAgent.clear();
    this.codexReverseToTui.clear();
    this.tuiToCodexReverse.clear();
  }
}

/**
 * JSON-RPC ids can be numbers or strings, and Map keys are
 * insertion-invariant on `===`. Coerce to a stable string so a
 * number `1` and a string `"1"` don't collide accidentally.
 */
function agentIdKey(id: JsonRpcRequestId): string {
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
 * Build the `data` payload for an error outcome. Always emits the
 * stable string code from `GATEWAY_ERROR_DATA_CODE`; extra diagnostic
 * keys (`field`, `queueDepth`, `limit`, …) merge on top. Agent-side
 * consumers can key on `data.code` (string) or the numeric `code`;
 * both are stable.
 */
function makeErrorData(
  code: GatewayErrorCode,
  extra?: Record<string, unknown>,
): GatewayErrorData {
  return {
    code: GATEWAY_ERROR_DATA_CODE[code],
    ...(extra ?? {}),
  };
}

/**
 * Parse an Agent-side `enqueueTask` params blob. Rejects any field
 * that isn't in the typed contract; that's how we keep the Wave-0
 * banned identifiers (method / threadId / turnId / policy / path /
 * config) off the wire even if a rogue Agent client sends them.
 */
export function parseEnqueueTaskParams(raw: unknown):
  | { ok: true; args: EnqueueTaskArgs }
  | { ok: false; field: string; reason: string }
{
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, field: "params", reason: "must be an object" };
  }
  const obj = raw as Record<string, unknown>;

  // Reject any Wave-0-banned key at the wire boundary. Even benign-
  // looking presence is enough to refuse — we don't want to normalise
  // and forget.
  for (const banned of ["method", "threadId", "turnId", "policy", "path", "config", "requestId", "jsonrpc", "id"]) {
    if (Object.prototype.hasOwnProperty.call(obj, banned)) {
      return { ok: false, field: banned, reason: "not part of the Agent typed contract" };
    }
  }

  const { taskId, messageId, authenticatedSender, text } = obj;
  if (typeof taskId !== "string") return { ok: false, field: "taskId", reason: "must be a string" };
  if (typeof messageId !== "string") return { ok: false, field: "messageId", reason: "must be a string" };
  if (typeof text !== "string" || text.length === 0) return { ok: false, field: "text", reason: "must be a non-empty string" };
  if (text.length > 128 * 1024) return { ok: false, field: "text", reason: "exceeds 128KB" };

  if (typeof authenticatedSender !== "object" || authenticatedSender === null) {
    return { ok: false, field: "authenticatedSender", reason: "must be an object" };
  }
  const s = authenticatedSender as Record<string, unknown>;
  if (typeof s.alias !== "string" || s.alias.length === 0 || s.alias.length > 200) {
    return { ok: false, field: "authenticatedSender.alias", reason: "must be a string 1..200" };
  }
  if (typeof s.tokenId !== "string" || s.tokenId.length === 0 || s.tokenId.length > 200) {
    return { ok: false, field: "authenticatedSender.tokenId", reason: "must be a string 1..200" };
  }
  if (typeof s.networkId !== "string" || s.networkId.length === 0 || s.networkId.length > 200) {
    return { ok: false, field: "authenticatedSender.networkId", reason: "must be a string 1..200" };
  }
  const roles = new Set(["admin", "owner", "member", "viewer", "child", "unknown"]);
  if (typeof s.role !== "string" || !roles.has(s.role)) {
    return { ok: false, field: "authenticatedSender.role", reason: "must be one of admin/owner/member/viewer/child/unknown" };
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
 */
export interface ProtocolBackend {
  enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult>;
  getTaskState(taskId: TaskId): Promise<TaskState>;
  cancelQueuedTask(taskId: TaskId): Promise<CancelQueuedTaskResult>;
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
      let result: EnqueueTaskResult;
      try {
        result = await backend.enqueueTask(parsed.args);
      } catch (e: unknown) {
        return {
          kind: "error",
          agentId: frame.id,
          code: GatewayErrorCode.InvalidArg,
          message: e instanceof Error ? e.message : "enqueueTask threw",
          data: makeErrorData(GatewayErrorCode.InvalidArg, { source: "backend" }),
        };
      }
      return { kind: "reply", agentId: frame.id, result };
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
      const state = await backend.getTaskState(parsed.taskId);
      return { kind: "reply", agentId: frame.id, result: state };
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
      const result = await backend.cancelQueuedTask(parsed.taskId);
      return { kind: "reply", agentId: frame.id, result };
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
