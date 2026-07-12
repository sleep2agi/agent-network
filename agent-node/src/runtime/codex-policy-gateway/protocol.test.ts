// RFC-030 Wave 1A — protocol layer tests.
//
// Six deliverable-list hazards mapped to test blocks:
//   (1) classification: request / response / notification / reverse /
//       malformed shapes each classified correctly, mixed / bad shapes
//       rejected.
//   (2) ID collision — repeat Agent id while previous is pending refused.
//   (3) Out-of-order response — mappings survive interleaved allocations.
//   (4) Reverse-request forgery — Agent id and Codex reverse id spaces
//       independent; consuming one doesn't touch the other.
//   (5) Unknown method — surfaces UnknownMethod (-32054) on the Agent
//       socket; no wire I/O happens.
//   (6) enqueueTask param sanitiser — banned keys rejected even if the
//       required keys are also present (defense against a rogue client
//       trying to smuggle threadId/policy/path/config).
// Plus a fixture for initialize virtualisation.
//
// Every test drives pure functions or a tiny in-memory backend; no
// timers, no sockets, no filesystem. If a test needs to touch either,
// it belongs in uds-server.test.ts / lifecycle.test.ts, not here.

import { describe, expect, test } from "bun:test";
import {
  AGENT_ALLOWED_METHODS,
  AGENT_RESERVED_METHODS,
  buildAgentInitializeResult,
  classifyMessage,
  classifyTuiRequest,
  dispatchAgentRequest as dispatchAgentRequestRaw,
  dispatchTuiRequest as dispatchTuiRequestRaw,
  enforceMethodOnAgentSide,
  handleTuiResponseFrame,
  parseEnqueueTaskParams,
  ReverseRequestNamespace,
  TUI_BOOTSTRAP_METHODS,
  UpstreamRequestMux,
  type AgentDispatchOutcome,
  type InternalErrorEntry,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type ProtocolBackend,
  type ProtocolDiagnostics,
  type TuiDispatchOutcome,
  type TuiInitializeProvider,
  type TuiPolicyDecision,
  type TuiRequestAuthorizer,
} from "./protocol";
import {
  asMessageId,
  asTaskId,
  GATEWAY_ERROR_DATA_CODE,
  GatewayError,
  GatewayErrorCode,
  type CancelQueuedTaskResult,
  type EnqueueTaskArgs,
  type EnqueueTaskResult,
  type TaskState,
} from "./contract";

// ─────────────────────────────────────────────────────────────────────
// Test-only default fixtures + wrappers (Checkpoint 4 deltas, 副指挥 4d8bd951)
// ─────────────────────────────────────────────────────────────────────
//
// After Δ9 / Δ10, `dispatchTuiRequest` takes an extra `TuiInitializeProvider`
// + `ProtocolDiagnostics`, and `dispatchAgentRequest` takes an extra
// `ProtocolDiagnostics`. The vast majority of existing tests don't care
// which snapshot or sink is used; they just need something plausible.
// These wrappers slot the defaults in, so existing test bodies stay
// unchanged. Tests that care about init / diagnostics behaviour pass
// their own fixtures explicitly.

/** Pinned Codex 0.144.0 upstream shape reflected by the default provider.
 *  Fixture only — B/lifecycle will inject the real captured snapshot in
 *  production. Deliberately does NOT contain enqueueTask / codex-
 *  policy-gateway/1 so tests verify TUI init isn't cross-wired to the
 *  Agent handshake shape. */
const DEFAULT_CODEX_INIT_SNAPSHOT: Readonly<Record<string, unknown>> = Object.freeze({
  serverInfo: Object.freeze({ name: "codex", version: "0.144.0" }),
  protocolVersion: "2024-11-05",
  capabilities: Object.freeze({
    tools: {},
    prompts: {},
    resources: {},
  }),
});

const _defaultInitProvider: TuiInitializeProvider = {
  currentSnapshot: () => DEFAULT_CODEX_INIT_SNAPSHOT,
};

const _defaultDiagnostics: ProtocolDiagnostics = {
  newCorrelationId: () => "cid-test-default",
  reportInternalError: () => {
    // Tests that care about the sink pass their own spy; the default
    // silently drops so unrelated tests don't have to touch it.
  },
};

function dispatchTuiRequest(
  frame: JsonRpcRequestFrame,
  authorizer: TuiRequestAuthorizer,
  initProvider: TuiInitializeProvider = _defaultInitProvider,
  diagnostics: ProtocolDiagnostics = _defaultDiagnostics,
): Promise<TuiDispatchOutcome> {
  return dispatchTuiRequestRaw(frame, authorizer, initProvider, diagnostics);
}

function dispatchAgentRequest(
  frame: JsonRpcRequestFrame,
  backend: ProtocolBackend,
  diagnostics: ProtocolDiagnostics = _defaultDiagnostics,
): Promise<AgentDispatchOutcome> {
  return dispatchAgentRequestRaw(frame, backend, diagnostics);
}

/** Convenience for tests that need to observe the sink. */
function makeDiagnosticsSpy(): {
  diagnostics: ProtocolDiagnostics;
  entries: InternalErrorEntry[];
  correlationIdsIssued: string[];
} {
  const entries: InternalErrorEntry[] = [];
  const correlationIdsIssued: string[] = [];
  let n = 0;
  const diagnostics: ProtocolDiagnostics = {
    newCorrelationId: () => {
      const id = `cid-spy-${++n}`;
      correlationIdsIssued.push(id);
      return id;
    },
    reportInternalError: (entry) => {
      entries.push(entry);
    },
  };
  return { diagnostics, entries, correlationIdsIssued };
}

// ─────────────────────────────────────────────────────────────────────
// classifyMessage
// ─────────────────────────────────────────────────────────────────────

describe("classifyMessage", () => {
  test("request: method + numeric id", () => {
    const c = classifyMessage({ jsonrpc: "2.0", id: 1, method: "foo", params: {} });
    if (c.kind !== "request") throw new Error(`expected request, got ${c.kind}`);
    expect(c.frame.id).toBe(1);
    expect(c.frame.method).toBe("foo");
  });

  test("request: method + string id", () => {
    const c = classifyMessage({ jsonrpc: "2.0", id: "abc", method: "foo" });
    expect(c.kind).toBe("request");
  });

  test("notification: method without id", () => {
    const c = classifyMessage({ jsonrpc: "2.0", method: "ping", params: { at: 1 } });
    if (c.kind !== "notification") throw new Error(`expected notification, got ${c.kind}`);
    expect(c.frame.method).toBe("ping");
  });

  test("response: id + result", () => {
    const c = classifyMessage({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    if (c.kind !== "response") throw new Error(`expected response, got ${c.kind}`);
    expect(c.isError).toBe(false);
    expect(c.frame.id).toBe(3);
    if ("result" in c.frame) expect(c.frame.result).toEqual({ ok: true });
  });

  test("response error: id + error{code,message}", () => {
    const c = classifyMessage({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32001, message: "unavailable" },
    });
    if (c.kind !== "response") throw new Error(`expected response, got ${c.kind}`);
    expect(c.isError).toBe(true);
    if ("error" in c.frame) {
      expect(c.frame.error.code).toBe(-32001);
      expect(c.frame.error.message).toBe("unavailable");
    }
  });

  test("malformed: null / array / primitive", () => {
    expect(classifyMessage(null).kind).toBe("malformed");
    expect(classifyMessage([]).kind).toBe("malformed");
    expect(classifyMessage("hi").kind).toBe("malformed");
    expect(classifyMessage(42).kind).toBe("malformed");
  });

  test("malformed: id present but not number/string", () => {
    const c = classifyMessage({ id: null, method: "x" });
    if (c.kind !== "malformed") throw new Error(`expected malformed, got ${c.kind}`);
    expect(c.reason).toBe("id_not_number_or_string");
  });

  test("malformed: method + result at the same time (mixed request/response)", () => {
    const c = classifyMessage({ id: 1, method: "x", result: {} });
    if (c.kind !== "malformed") throw new Error(`expected malformed, got ${c.kind}`);
    expect(c.reason).toBe("mixed_request_and_response");
  });

  test("malformed: both result and error", () => {
    const c = classifyMessage({ id: 1, result: {}, error: { code: 1, message: "x" } });
    if (c.kind !== "malformed") throw new Error(`expected malformed, got ${c.kind}`);
    expect(c.reason).toBe("both_result_and_error");
  });

  test("malformed: error object missing code/message", () => {
    const c = classifyMessage({ id: 1, error: { code: 1 } });
    if (c.kind !== "malformed") throw new Error(`expected malformed, got ${c.kind}`);
    expect(c.reason).toBe("error_object_bad_shape");
  });

  test("malformed: id only, no method, no result, no error", () => {
    const c = classifyMessage({ id: 1 });
    if (c.kind !== "malformed") throw new Error(`expected malformed, got ${c.kind}`);
    expect(c.reason).toBe("unknown_shape");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Method whitelists
// ─────────────────────────────────────────────────────────────────────

describe("Agent-side whitelist", () => {
  test("accepts the typed contract + initialize/initialized only", () => {
    expect(enforceMethodOnAgentSide("enqueueTask")).toBe(true);
    expect(enforceMethodOnAgentSide("getTaskState")).toBe(true);
    expect(enforceMethodOnAgentSide("cancelQueuedTask")).toBe(true);
    expect(enforceMethodOnAgentSide("runtimeState.subscribe")).toBe(true);
    expect(enforceMethodOnAgentSide("runtimeState.unsubscribe")).toBe(true);
    expect(enforceMethodOnAgentSide("initialize")).toBe(true);
    expect(enforceMethodOnAgentSide("initialized")).toBe(true);
  });

  test("rejects raw Codex/MCP methods", () => {
    for (const m of ["turn/start", "turn/steer", "thread/resume", "shutdown", "serverRequest/resolved"]) {
      expect(enforceMethodOnAgentSide(m)).toBe(false);
    }
  });

  test("AGENT_ALLOWED_METHODS pinned to the exact 7-method contract", () => {
    expect(Array.from(AGENT_ALLOWED_METHODS).sort()).toEqual([
      "cancelQueuedTask",
      "enqueueTask",
      "getTaskState",
      "initialize",
      "initialized",
      "runtimeState.subscribe",
      "runtimeState.unsubscribe",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// classifyTuiRequest + TUI policy hook (Wave 1A req delta #1, f84942e8)
// ─────────────────────────────────────────────────────────────────────

describe("classifyTuiRequest — no raw allowlist, delegates to policy hook", () => {
  test("initialize / initialized → bootstrap (A layer answers directly)", () => {
    expect(classifyTuiRequest("initialize")).toEqual({ kind: "bootstrap", method: "initialize" });
    expect(classifyTuiRequest("initialized")).toEqual({ kind: "bootstrap", method: "initialized" });
  });

  test("Codex-shape TUI methods (thread/*, turn/*) → policy_delegate (B decides)", () => {
    for (const m of [
      "thread/resume",
      "thread/read",
      "thread/status",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "serverRequest/resolved",
    ]) {
      expect(classifyTuiRequest(m)).toEqual({ kind: "policy_delegate", method: m });
    }
  });

  test("Agent-typed contract methods are RESERVED — TUI must not send them", () => {
    for (const m of [
      "enqueueTask",
      "getTaskState",
      "cancelQueuedTask",
      "runtimeState.subscribe",
      "runtimeState.unsubscribe",
    ]) {
      expect(classifyTuiRequest(m)).toEqual({ kind: "reserved_agent_method", method: m });
    }
  });

  test("Bootstrap + Agent-reserved sets are pinned; everything else flows to policy_delegate", () => {
    expect(Array.from(TUI_BOOTSTRAP_METHODS).sort()).toEqual(["initialize", "initialized"]);
    expect(Array.from(AGENT_RESERVED_METHODS).sort()).toEqual([
      "cancelQueuedTask",
      "enqueueTask",
      "getTaskState",
      "runtimeState.subscribe",
      "runtimeState.unsubscribe",
    ]);
    // The two sets are disjoint (compile-time obvious, runtime pin
    // in case of future refactor).
    for (const b of TUI_BOOTSTRAP_METHODS) {
      expect(AGENT_RESERVED_METHODS.has(b)).toBe(false);
    }
  });
});

describe("dispatchTuiRequest — B's authorizer is the arbiter for Codex-shape frames", () => {
  const alwaysAllow: TuiRequestAuthorizer = {
    async authorize() { return { verdict: "allow" }; },
  };
  const alwaysDeny: TuiRequestAuthorizer = {
    async authorize() {
      return { verdict: "deny", code: GatewayErrorCode.NoOwner, reason: "no bound thread" };
    },
  };
  const throwingHook: TuiRequestAuthorizer = {
    async authorize() { throw new Error("hook exploded"); },
  };

  test("initialize is answered by A directly (no authorizer call) using injected snapshot", async () => {
    // Δ9 (副指挥 4d8bd951): TUI initialize returns the upstream Codex
    // app-server snapshot, NOT the Agent handshake shape. The A layer
    // pulls the snapshot through TuiInitializeProvider (default fixture
    // here) and MUST NOT synthesize codex-policy-gateway/1.
    let called = false;
    const spy: TuiRequestAuthorizer = {
      async authorize() { called = true; return { verdict: "allow" }; },
    };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      spy,
    );
    if (out.kind !== "bootstrap_reply") throw new Error(`expected bootstrap_reply, got ${out.kind}`);
    expect(out.tuiId).toBe(1);
    // Native Codex TUI shape from the fixture:
    expect((out.result as { serverInfo: { name: string } }).serverInfo.name).toBe("codex");
    expect((out.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    // MUST NOT carry the Agent handshake fields — those would fail
    // the native Codex TUI's handshake check at P0.
    expect(JSON.stringify(out.result)).not.toContain("codex-policy-gateway/1");
    expect(JSON.stringify(out.result)).not.toContain("enqueueTask");
    expect(called).toBe(false);
  });

  test("initialized is answered by A directly (empty ack, no hook call)", async () => {
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "initialized" },
      alwaysDeny,
    );
    if (out.kind !== "bootstrap_reply") throw new Error(`expected bootstrap_reply`);
    expect(out.result).toEqual({});
  });

  test("policy_delegate: hook allow → forward_upstream", async () => {
    const frame = { jsonrpc: "2.0" as const, id: 3, method: "thread/resume", params: { threadId: "t_x" } };
    const out = await dispatchTuiRequest(frame, alwaysAllow);
    if (out.kind !== "forward_upstream") throw new Error(`expected forward_upstream, got ${out.kind}`);
    expect(out.frame.method).toBe("thread/resume");
    expect((out.frame.params as { threadId: string }).threadId).toBe("t_x");
  });

  test("policy_delegate: authorizer deny → reject with the authorizer's typed code + reason", async () => {
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 4, method: "turn/start" },
      alwaysDeny,
    );
    if (out.kind !== "reject") throw new Error(`expected reject, got ${out.kind}`);
    expect(out.code).toBe(GatewayErrorCode.NoOwner);
    expect(out.message).toBe("no bound thread");
    expect(out.data.code).toBe("codex_gateway_no_owner");
    // Reason MUST land in the error data too (副指挥 ed3f92bf: reason
    // is required, not optional, so downstream diagnostics get it).
    expect(out.data.reason).toBe("no bound thread");
  });

  test("policy_delegate: authorizer deny with extra diagnostic fields → merged into data", async () => {
    // Δ8 (副指挥 4d8bd951): reservation conflict is Busy, not
    // NoOwner. NoOwner is reserved for "no human owner bound at all"
    // (see the alwaysDeny fixture above).
    const denyWithExtra: TuiRequestAuthorizer = {
      async authorize() {
        return {
          verdict: "deny",
          code: GatewayErrorCode.Busy,
          reason: "reservation held by agent",
          extra: { reservationHolder: "agent", taskId: "t_x" },
        };
      },
    };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 4, method: "turn/start" },
      denyWithExtra,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.Busy);
    expect(out.data.code).toBe("codex_gateway_busy");
    expect(out.data.reason).toBe("reservation held by agent");
    expect(out.data.reservationHolder).toBe("agent");
    expect(out.data.taskId).toBe("t_x");
  });

  test("reserved agent method sent on TUI socket → InvalidArg (authorizer not consulted)", async () => {
    let called = false;
    const spy: TuiRequestAuthorizer = {
      async authorize() { called = true; return { verdict: "allow" }; },
    };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 5, method: "enqueueTask" },
      spy,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.InvalidArg);
    expect(out.data.code).toBe("codex_gateway_invalid_arg");
    expect(out.data.reason).toBe("reserved_for_agent_typed_contract");
    expect(out.data.method).toBe("enqueueTask");
    expect(called).toBe(false);
  });

  test("hook throws → sanitised Unavailable + diagnostics sink logs full error (Δ10)", async () => {
    const spy = makeDiagnosticsSpy();
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 6, method: "thread/resume" },
      throwingHook,
      _defaultInitProvider,
      spy.diagnostics,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.Unavailable);
    expect(out.data.code).toBe("codex_gateway_unavailable");
    expect(out.data.source).toBe("tui_policy_hook");
    // Wire response carries a stable correlationId — the same one
    // handed to the sink, so an operator can grep the log.
    expect(typeof out.data.correlationId).toBe("string");
    // No leakage of `hook exploded` on the wire.
    expect(out.message).not.toContain("hook exploded");
    expect(JSON.stringify(out.data)).not.toContain("hook exploded");
    // Sink got exactly ONE entry with the raw error preserved for
    // the operator log.
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].operation).toBe("tui_policy_authorize");
    expect(spy.entries[0].correlationId).toBe(out.data.correlationId);
    expect((spy.entries[0].error as Error).message).toBe("hook exploded");
  });

  test("A layer does NOT hardcode Codex-shape methods (no allowlist regression)", () => {
    // The A layer's source must not enumerate any Codex-shape method
    // (thread/*, turn/*, serverRequest/*). If a future refactor adds
    // one to a hardcoded set, this test fails.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require("node:fs").readFileSync(__dirname + "/protocol.ts", "utf-8");
    for (const banned of [
      "\"thread/resume\"",
      "\"thread/read\"",
      "\"thread/status\"",
      "\"turn/start\"",
      "\"turn/steer\"",
      "\"turn/interrupt\"",
      "\"serverRequest/resolved\"",
    ]) {
      if (src.includes(banned)) {
        throw new Error(`protocol.ts hardcodes ${banned} — should defer to TuiRequestAuthorizer instead`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Delta 7 — Phase 1 policy structural tests (副指挥 7d70dcbd)
// ─────────────────────────────────────────────────────────────────────
//
// These tests verify how A's dispatch layer wires B's authorizer
// verdicts through to concrete outcomes:
//
//   reservation=agent  →  human turn/start + turn/steer denied (0 upstream writes)
//                         human turn/interrupt allowed (exactly 1 forward_upstream)
//                         after interrupt, subsequent turn/start still denied
//                         (no auto-replay observable at this layer)
//
//   reservation=human  →  turn/start + turn/steer allowed (forward_upstream)
//
//   approval spoof     →  unknown TUI response id rejected
//                         (already covered above; smoke-checked here)
//
// The concrete reservation/ledger rules live in B. A's job is to
// carry the verdict faithfully. If A ever forwards a denied frame
// upstream, these tests fail.

describe("Phase 1 policy wiring (Delta 7, 副指挥 7d70dcbd)", () => {
  // Concrete authorizer that models the reservation state machine
  // per Phase 1 spec. Mirrors what B will ship on its side.
  function makeReservationAuthorizer(state: {
    reservation: "human" | "agent";
    interrupted: boolean;
  }): TuiRequestAuthorizer {
    return {
      async authorize(frame) {
        const m = frame.method;
        if (state.reservation === "human") {
          // All three humanly-initiated turn ops allowed.
          if (m === "turn/start" || m === "turn/steer" || m === "turn/interrupt") {
            return { verdict: "allow" };
          }
          return {
            verdict: "deny",
            code: GatewayErrorCode.InvalidArg,
            reason: `method ${m} not in Phase 1 human-reservation policy`,
          };
        }
        // reservation === "agent"
        if (m === "turn/interrupt") {
          state.interrupted = true;
          return { verdict: "allow" };
        }
        if (m === "turn/start" || m === "turn/steer") {
          // Δ8 (副指挥 4d8bd951): reservation conflict uses Busy.
          // NoOwner would misleadingly imply no human owner is bound
          // at all; in this state the owner IS bound, just holding
          // the reservation for the agent side.
          return {
            verdict: "deny",
            code: GatewayErrorCode.Busy,
            reason: "reservation held by agent",
            extra: { reservationHolder: "agent", suggested: "turn/interrupt" },
          };
        }
        return {
          verdict: "deny",
          code: GatewayErrorCode.InvalidArg,
          reason: `method ${m} not in Phase 1 agent-reservation policy`,
        };
      },
    };
  }

  test("reservation=agent — turn/start denied → 0 forward_upstream outcomes", async () => {
    const state = { reservation: "agent" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "turn/start", params: {} },
      authorizer,
    );
    if (out.kind !== "reject") throw new Error(`expected reject, got ${out.kind}`);
    expect(out.code).toBe(GatewayErrorCode.Busy);
    expect(out.data.code).toBe("codex_gateway_busy");
    expect(out.data.reason).toBe("reservation held by agent");
    expect(out.data.reservationHolder).toBe("agent");
  });

  test("reservation=agent — turn/steer denied → 0 forward_upstream outcomes", async () => {
    const state = { reservation: "agent" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "turn/steer", params: {} },
      authorizer,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.Busy);
    expect(out.data.code).toBe("codex_gateway_busy");
  });

  test("reservation=agent — turn/interrupt allowed → exactly 1 forward_upstream", async () => {
    const state = { reservation: "agent" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 3, method: "turn/interrupt", params: {} },
      authorizer,
    );
    if (out.kind !== "forward_upstream") throw new Error(`expected forward_upstream, got ${out.kind}`);
    expect(out.frame.method).toBe("turn/interrupt");
    expect(state.interrupted).toBe(true);
  });

  test("reservation=agent, post-interrupt — subsequent turn/start still denied (no auto-replay at A layer)", async () => {
    const state = { reservation: "agent" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    // Emergency interrupt.
    await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "turn/interrupt", params: {} },
      authorizer,
    );
    // Now the ledger enters a structured "interrupted_by_human"
    // terminal state (B owns that; A only needs to keep denying
    // fresh starts until reservation changes). The A layer must
    // NOT resurrect the prior request — a subsequent turn/start is
    // still a fresh caller under the same reservation.
    const out2 = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "turn/start", params: {} },
      authorizer,
    );
    if (out2.kind !== "reject") throw new Error(`expected reject on post-interrupt start, got ${out2.kind}`);
    // Δ8: post-interrupt subsequent start is still reservation-conflict → Busy.
    expect(out2.code).toBe(GatewayErrorCode.Busy);
  });

  test("reservation=human — turn/start allowed → forward_upstream", async () => {
    const state = { reservation: "human" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "turn/start", params: {} },
      authorizer,
    );
    if (out.kind !== "forward_upstream") throw new Error(`expected forward_upstream, got ${out.kind}`);
    expect(out.frame.method).toBe("turn/start");
  });

  test("reservation=human — turn/steer allowed → forward_upstream", async () => {
    const state = { reservation: "human" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "turn/steer", params: {} },
      authorizer,
    );
    if (out.kind !== "forward_upstream") throw new Error(`expected forward_upstream`);
  });

  test("Phase 1 approval spoof — unknown TUI response id rejected fail-closed", () => {
    // Approval channel: Codex never sent a reverse request (Phase 1
    // approval=never), so any inbound TUI response frame is a spoof.
    const reverse = new ReverseRequestNamespace();
    const out = handleTuiResponseFrame(
      { jsonrpc: "2.0", id: 42, result: { approved: true } },
      reverse,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.InvalidArg);
    expect(out.data.reason).toBe("reverse_id_unknown_or_duplicate");
    expect(reverse.pendingCount()).toBe(0);
  });

  test("Phase 2 turn-on smoke — allow-verdict does NOT sneak human turn/steer of Agent turn open", async () => {
    // 副指挥 7d70dcbd: "human steer Agent turn deferred to Phase2,
    // must not sneak open in current policy." This test locks in
    // that our reservation authorizer, under state.reservation=
    // "agent", refuses turn/steer even though structurally
    // authorizer.authorize() COULD return {verdict:"allow"} for it.
    const state = { reservation: "agent" as const, interrupted: false };
    const authorizer = makeReservationAuthorizer(state);
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "turn/steer", params: {} },
      authorizer,
    );
    if (out.kind !== "reject") throw new Error(`expected reject`);
    // Δ8: Phase 2 turn-on smoke — reservation conflict → Busy.
    expect(out.code).toBe(GatewayErrorCode.Busy);
  });
});

// ─────────────────────────────────────────────────────────────────────
// UpstreamRequestMux + ReverseRequestNamespace
// ─────────────────────────────────────────────────────────────────────

describe("UpstreamRequestMux (P0 ed3f92bf) — single upstream allocator, two origin kinds", () => {
  test("monotonic upstream ids across both allocation kinds", () => {
    const mux = new UpstreamRequestMux();
    expect(mux.allocateForProxiedTui(1).upstreamId).toBe(1);
    expect(mux.allocateForInternalScheduler({ task: "t_x" }).upstreamId).toBe(2);
    expect(mux.allocateForProxiedTui("abc").upstreamId).toBe(3);
    expect(mux.allocateForInternalScheduler({ task: "t_y" }).upstreamId).toBe(4);
    expect(mux.pendingCount()).toBe(4);
  });

  test("P0 hard test: TUI raw id=1 + internal turn/start simultaneously → distinct upstream ids", () => {
    const mux = new UpstreamRequestMux();
    const proxied = mux.allocateForProxiedTui(1);         // TUI-side id "1"
    const internalHandle = { kind: "turn_start", taskId: "t_x" };
    const internal = mux.allocateForInternalScheduler(internalHandle);
    // Different upstream ids on the wire — no collision.
    expect(proxied.upstreamId).not.toBe(internal.upstreamId);
    expect(proxied.upstreamId).toBeGreaterThan(0);
    expect(internal.upstreamId).toBeGreaterThan(0);
  });

  test("P0 hard test: out-of-order responses each route to correct origin", () => {
    const mux = new UpstreamRequestMux<{ kind: string; taskId: string }>();
    const p1 = mux.allocateForProxiedTui(100).upstreamId;
    const i1 = mux.allocateForInternalScheduler({ kind: "turn_start", taskId: "t_a" }).upstreamId;
    const p2 = mux.allocateForProxiedTui(200).upstreamId;
    const i2 = mux.allocateForInternalScheduler({ kind: "turn_interrupt", taskId: "t_a" }).upstreamId;

    // Response arrival: i2, p1, i1, p2.
    const r_i2 = mux.consumeUpstreamResponse(i2);
    if (!r_i2 || r_i2.kind !== "internal") throw new Error("expected internal");
    expect(r_i2.origin.kind).toBe("turn_interrupt");

    const r_p1 = mux.consumeUpstreamResponse(p1);
    if (!r_p1 || r_p1.kind !== "proxied_tui") throw new Error("expected proxied_tui");
    expect(r_p1.tuiId).toBe(100);

    const r_i1 = mux.consumeUpstreamResponse(i1);
    if (!r_i1 || r_i1.kind !== "internal") throw new Error("expected internal");
    expect(r_i1.origin.kind).toBe("turn_start");

    const r_p2 = mux.consumeUpstreamResponse(p2);
    if (!r_p2 || r_p2.kind !== "proxied_tui") throw new Error("expected proxied_tui");
    expect(r_p2.tuiId).toBe(200);

    expect(mux.pendingCount()).toBe(0);
  });

  test("P0 hard test: proxied TUI id collision (same id in flight) refused", () => {
    const mux = new UpstreamRequestMux();
    expect(mux.allocateForProxiedTui(5).upstreamId).toBe(1);
    const dup = mux.allocateForProxiedTui(5);
    if (!("collision" in dup) || !dup.collision) throw new Error(`expected collision, got ${JSON.stringify(dup)}`);
    // After the outstanding one drains, the id may be reused.
    mux.consumeUpstreamResponse(1);
    expect(mux.allocateForProxiedTui(5).upstreamId).toBe(2);
  });

  test("P0 hard test: numeric 1 vs string \"1\" are distinct TUI ids (no accidental merge)", () => {
    const mux = new UpstreamRequestMux();
    expect(mux.allocateForProxiedTui(1).upstreamId).toBe(1);
    expect(mux.allocateForProxiedTui("1").upstreamId).toBe(2);
  });

  test("internal ids never collide with each other even with identical origin object shape", () => {
    const mux = new UpstreamRequestMux();
    const originA = { taskId: "t_1", turn: "u_1" };
    const originB = { taskId: "t_1", turn: "u_1" };  // same shape, different alloc
    const a = mux.allocateForInternalScheduler(originA);
    const b = mux.allocateForInternalScheduler(originB);
    expect(a.upstreamId).not.toBe(b.upstreamId);
    // Both consumable independently.
    const rA = mux.consumeUpstreamResponse(a.upstreamId);
    if (!rA || rA.kind !== "internal") throw new Error("expected internal");
    expect(rA.origin).toBe(originA);
  });

  test("consume unknown upstream id → null (spoof / replay protection)", () => {
    const mux = new UpstreamRequestMux();
    expect(mux.consumeUpstreamResponse(999)).toBeNull();
    // Non-numeric upstream id also null (upstream ids are always numeric).
    expect(mux.consumeUpstreamResponse("999")).toBeNull();
  });

  test("consume twice → null the second time (no double-consume)", () => {
    const mux = new UpstreamRequestMux();
    mux.allocateForProxiedTui(1);
    const r1 = mux.consumeUpstreamResponse(1);
    if (!r1) throw new Error("expected first consume to succeed");
    expect(mux.consumeUpstreamResponse(1)).toBeNull();
  });

  test("drainAll clears everything (used on shutdown)", () => {
    const mux = new UpstreamRequestMux();
    mux.allocateForProxiedTui(1);
    mux.allocateForInternalScheduler({ task: "t" });
    expect(mux.pendingCount()).toBe(2);
    mux.drainAll();
    expect(mux.pendingCount()).toBe(0);
    expect(mux.consumeUpstreamResponse(1)).toBeNull();
    expect(mux.consumeUpstreamResponse(2)).toBeNull();
    // TUI id reuse permitted after drain.
    expect(mux.allocateForProxiedTui(1).upstreamId).toBe(3);
  });

  // Δ11 (副指挥 4d8bd951): TUI disconnect ≠ upstream disconnect.
  test("drainProxiedTui — clears TUI origins ONLY, internal scheduler pending survives", () => {
    const mux = new UpstreamRequestMux<{ kind: string; taskId: string }>();
    const p1 = mux.allocateForProxiedTui(1).upstreamId;
    const i1 = mux.allocateForInternalScheduler({ kind: "turn_start", taskId: "t_a" }).upstreamId;
    const p2 = mux.allocateForProxiedTui(2).upstreamId;
    const i2 = mux.allocateForInternalScheduler({ kind: "turn_interrupt", taskId: "t_a" }).upstreamId;
    expect(mux.pendingCount()).toBe(4);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(2);
    expect(mux.pendingCountByKind("internal")).toBe(2);

    const dropped = mux.drainProxiedTui();
    expect(dropped).toBe(2);
    // TUI origins gone.
    expect(mux.consumeUpstreamResponse(p1)).toBeNull();
    expect(mux.consumeUpstreamResponse(p2)).toBeNull();
    // Internal origins STILL consumable — the scheduler's Promise
    // resolvers must not be lost when the TUI disconnects.
    const r_i1 = mux.consumeUpstreamResponse(i1);
    if (!r_i1 || r_i1.kind !== "internal") throw new Error("internal must survive drainProxiedTui");
    expect(r_i1.origin.kind).toBe("turn_start");
    const r_i2 = mux.consumeUpstreamResponse(i2);
    if (!r_i2 || r_i2.kind !== "internal") throw new Error("internal must survive drainProxiedTui");
    expect(r_i2.origin.kind).toBe("turn_interrupt");
    expect(mux.pendingCount()).toBe(0);
  });

  test("drainProxiedTui — TUI id reuse permitted after selective drain", () => {
    const mux = new UpstreamRequestMux();
    mux.allocateForProxiedTui(5);
    // Would collide without drain.
    const before = mux.allocateForProxiedTui(5);
    if (!("collision" in before) || !before.collision) throw new Error("expected pre-drain collision");
    mux.drainProxiedTui();
    // Same TUI id now allocatable again.
    const after = mux.allocateForProxiedTui(5);
    if (!("upstreamId" in after)) throw new Error("expected allocation after drain");
  });

  test("drainProxiedTui — no-op when there are only internal originations pending", () => {
    const mux = new UpstreamRequestMux<{ tag: string }>();
    mux.allocateForInternalScheduler({ tag: "a" });
    mux.allocateForInternalScheduler({ tag: "b" });
    expect(mux.drainProxiedTui()).toBe(0);
    expect(mux.pendingCount()).toBe(2);
  });

  test("drainAll — full clear, distinct from drainProxiedTui (used on upstream shutdown)", () => {
    const mux = new UpstreamRequestMux<{ tag: string }>();
    mux.allocateForProxiedTui(1);
    mux.allocateForInternalScheduler({ tag: "a" });
    expect(mux.pendingCount()).toBe(2);
    mux.drainAll();
    expect(mux.pendingCount()).toBe(0);
    // Both origins gone.
    expect(mux.consumeUpstreamResponse(1)).toBeNull();
    expect(mux.consumeUpstreamResponse(2)).toBeNull();
  });
});

describe("ReverseRequestNamespace (Codex → TUI) — SEPARATE from UpstreamRequestMux", () => {
  test("upstream mux and reverse namespace share no state — id=1 in both is fine", () => {
    const mux = new UpstreamRequestMux();
    const reverse = new ReverseRequestNamespace();
    // Same id=1 on wildly different sides. Distinct classes → no
    // collision possible (compile-time also enforces this).
    expect(mux.allocateForProxiedTui(1).upstreamId).toBe(1);
    const rev = reverse.allocateTuiIdForCodexReverseRequest(1);
    if (!("tuiId" in rev)) throw new Error("expected tuiId");
    expect(rev.tuiId).toBe(1);
    // Consuming upstream doesn't touch reverse.
    mux.consumeUpstreamResponse(1);
    expect(reverse.pendingCount()).toBe(1);
  });

  test("TUI response is rewritten back to the Codex reverse id", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_5"); // reverse id "cx_5" → tuiId 1
    expect(reverse.consumeCodexReverseByTuiId(1)).toBe("cx_5");
  });

  test("collision within reverse namespace refused", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_1");
    const c = reverse.allocateTuiIdForCodexReverseRequest("cx_1");
    if (!("collision" in c) || !c.collision) throw new Error("must collide within same reverse ns");
  });

  test("spoofed TUI id consumption returns null (approval-spoof prevention, 副指挥 7d70dcbd)", () => {
    const reverse = new ReverseRequestNamespace();
    // TUI didn't get any reverse request. It tries to answer id=1 anyway.
    expect(reverse.consumeCodexReverseByTuiId(1)).toBeNull();
  });

  test("drainAll — used on TUI disconnect / shutdown, no re-approval after owner leaves", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_1");
    reverse.allocateTuiIdForCodexReverseRequest("cx_2");
    expect(reverse.pendingCount()).toBe(2);
    reverse.drainAll();
    expect(reverse.pendingCount()).toBe(0);
    expect(reverse.consumeCodexReverseByTuiId(1)).toBeNull();
    expect(reverse.consumeCodexReverseByTuiId(2)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// TUI approval-response path (Delta 6, 副指挥 ed3f92bf + 7d70dcbd)
// ─────────────────────────────────────────────────────────────────────

describe("handleTuiResponseFrame — approval consumption path (reverse namespace only)", () => {
  test("known TUI id → forward reverse response rewritten to Codex reverse id", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_9"); // tuiId = 1
    const frame: JsonRpcResponseFrame = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const out = handleTuiResponseFrame(frame, reverse);
    if (out.kind !== "forward_reverse_response") throw new Error(`expected forward, got ${out.kind}`);
    expect(out.codexReverseId).toBe("cx_9");
    if ("result" in out.frame) expect(out.frame.result).toEqual({ ok: true });
  });

  test("known TUI id + error response → rewritten error frame", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_9"); // tuiId = 1
    const frame: JsonRpcResponseFrame = {
      jsonrpc: "2.0", id: 1, error: { code: -32001, message: "denied" },
    };
    const out = handleTuiResponseFrame(frame, reverse);
    if (out.kind !== "forward_reverse_response") throw new Error(`expected forward`);
    if ("error" in out.frame) {
      expect(out.frame.error.message).toBe("denied");
    } else throw new Error("expected error variant");
  });

  test("unknown TUI id → reject as InvalidArg with stable reason", () => {
    const reverse = new ReverseRequestNamespace();
    const frame: JsonRpcResponseFrame = { jsonrpc: "2.0", id: 99, result: {} };
    const out = handleTuiResponseFrame(frame, reverse);
    if (out.kind !== "reject") throw new Error(`expected reject`);
    expect(out.code).toBe(GatewayErrorCode.InvalidArg);
    expect(out.data.reason).toBe("reverse_id_unknown_or_duplicate");
    expect(out.data.tuiId).toBe(99);
  });

  test("duplicate TUI id (already consumed) → reject fail closed (no re-approval)", () => {
    const reverse = new ReverseRequestNamespace();
    reverse.allocateTuiIdForCodexReverseRequest("cx_1"); // tuiId = 1
    // First consume succeeds.
    const first = handleTuiResponseFrame({ jsonrpc: "2.0", id: 1, result: {} }, reverse);
    if (first.kind !== "forward_reverse_response") throw new Error("first should succeed");
    // Replay of same TUI id → rejected.
    const replay = handleTuiResponseFrame({ jsonrpc: "2.0", id: 1, result: {} }, reverse);
    if (replay.kind !== "reject") throw new Error(`expected replay reject, got ${replay.kind}`);
    expect(replay.code).toBe(GatewayErrorCode.InvalidArg);
    expect(replay.data.reason).toBe("reverse_id_unknown_or_duplicate");
  });

  test("approval-frame path does NOT touch UpstreamRequestMux (independent namespace)", () => {
    const mux = new UpstreamRequestMux();
    const reverse = new ReverseRequestNamespace();
    // Set up a pending upstream request with id=1 AND a pending reverse.
    mux.allocateForProxiedTui(1);
    reverse.allocateTuiIdForCodexReverseRequest("cx_1"); // tuiId=1
    // Approval response with tuiId=1 consumes reverse only.
    handleTuiResponseFrame({ jsonrpc: "2.0", id: 1, result: {} }, reverse);
    // Upstream mux still has its pending id=1.
    expect(mux.pendingCount()).toBe(1);
    expect(reverse.pendingCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Δ9 — TUI initialize virtualisation (副指挥 4d8bd951)
// ─────────────────────────────────────────────────────────────────────

describe("TUI initialize virtualisation via TuiInitializeProvider (Δ9)", () => {
  const noopAuthorizer: TuiRequestAuthorizer = {
    async authorize() {
      throw new Error("authorizer must not be called during initialize");
    },
  };

  test("initialize returns injected upstream snapshot verbatim (native Codex shape, not Agent handshake)", async () => {
    const codexSnapshot = Object.freeze({
      serverInfo: Object.freeze({ name: "codex", version: "0.144.0" }),
      protocolVersion: "2024-11-05",
      capabilities: Object.freeze({ tools: {}, prompts: {}, resources: {} }),
    });
    const provider: TuiInitializeProvider = { currentSnapshot: () => codexSnapshot };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      noopAuthorizer,
      provider,
    );
    if (out.kind !== "bootstrap_reply") throw new Error(`expected bootstrap_reply, got ${out.kind}`);
    // Exact snapshot reflected — no rewrapping, no mutation.
    expect(out.result).toBe(codexSnapshot);
    // No Agent handshake leakage.
    const dump = JSON.stringify(out.result);
    expect(dump).not.toContain("codex-policy-gateway/1");
    expect(dump).not.toContain("enqueueTask");
    expect(dump).not.toContain("getTaskState");
    expect(dump).not.toContain("cancelQueuedTask");
    expect(dump).not.toContain("runtimeState");
  });

  test("initialize before upstream init completes (snapshot=undefined) → fail closed Unavailable", async () => {
    const provider: TuiInitializeProvider = { currentSnapshot: () => undefined };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      noopAuthorizer,
      provider,
    );
    if (out.kind !== "reject") throw new Error(`expected reject, got ${out.kind}`);
    expect(out.code).toBe(GatewayErrorCode.Unavailable);
    expect(out.data.code).toBe("codex_gateway_unavailable");
    expect(out.data.source).toBe("tui_initialize");
    expect(out.data.reason).toBe("upstream_not_initialized");
  });

  test("initialized (no id) still ack'd with {} regardless of snapshot (unchanged behaviour)", async () => {
    const provider: TuiInitializeProvider = { currentSnapshot: () => undefined };
    const out = await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "initialized" },
      noopAuthorizer,
      provider,
    );
    if (out.kind !== "bootstrap_reply") throw new Error(`expected bootstrap_reply`);
    expect(out.result).toEqual({});
  });

  test("provider is only called for initialize — policy_delegate and reserved_agent_method do not touch it", async () => {
    let called = 0;
    const provider: TuiInitializeProvider = {
      currentSnapshot() { called++; return DEFAULT_CODEX_INIT_SNAPSHOT; },
    };
    const allow: TuiRequestAuthorizer = { async authorize() { return { verdict: "allow" }; } };
    await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 1, method: "thread/resume" },
      allow,
      provider,
    );
    await dispatchTuiRequest(
      { jsonrpc: "2.0", id: 2, method: "enqueueTask" },
      allow,
      provider,
    );
    expect(called).toBe(0);
  });

  test("Agent-side initialize is UNCHANGED — still uses buildAgentInitializeResult (Agent handshake shape)", async () => {
    // Δ9 splits the TWO initialize paths: TUI gets upstream Codex
    // shape (above); Agent still gets the typed contract handshake.
    // If the two were ever merged, this test fails.
    const backend: ProtocolBackend = {
      async enqueueTask() { return { kind: "accepted" }; },
      async getTaskState() { return { kind: "unknown" }; },
      async cancelQueuedTask() { return { kind: "cancelled" }; },
    };
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      backend,
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    const r = out.result as { protocol: string; serverInfo: { name: string } };
    expect(r.protocol).toBe("codex-policy-gateway/1");
    expect(r.serverInfo.name).toBe("codex-policy-gateway");
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseEnqueueTaskParams — Wave-0 banned identifier defense
// ─────────────────────────────────────────────────────────────────────

describe("parseEnqueueTaskParams — strict allowlist (req delta #2, f84942e8)", () => {
  function goodSender() {
    return { alias: "reviewer", tokenId: "tok_1", role: "member", networkId: "net_1" };
  }
  function goodParams() {
    return {
      taskId: "t_1",
      messageId: "m_1",
      authenticatedSender: goodSender(),
      text: "hi",
    };
  }

  test("happy path — all four required top-level keys, no extras", () => {
    const r = parseEnqueueTaskParams(goodParams());
    if (!r.ok) throw new Error(`expected ok, got ${r.reason} on ${r.field}`);
    expect(r.args.text).toBe("hi");
    expect(r.args.authenticatedSender.tokenId).toBe("tok_1");
  });

  test.each([
    // Banned identifiers explicitly named in Wave-0 lockout
    "method",
    "threadId",
    "turnId",
    "policy",
    "path",
    "config",
    "requestId",
    "jsonrpc",
    "id",
    "params",
    // 副指挥 f84942e8 repro: nondescriptive key MUST be caught by allowlist,
    // not by banned-list.
    "evil",
    "extra",
    "foo",
    "hint",
  ])("top-level key '%s' outside the allowlist → rejected", (key) => {
    const bad: Record<string, unknown> = { ...goodParams(), [key]: "smuggled" };
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error(`should have refused unknown key '${key}'`);
    expect(r.field).toBe(key);
    expect(r.reason).toMatch(/not part of the Agent typed contract/);
  });

  test.each([
    // Even the Wave-0-banned identifiers nested INSIDE authenticatedSender
    // must be caught by the nested allowlist.
    "method",
    "threadId",
    "id",
    "params",
    // Arbitrary attacker keys the banned-list didn't enumerate.
    "evil",
    "smuggled",
    "role_hint",
  ])("nested authenticatedSender key '%s' outside the allowlist → rejected", (key) => {
    const bad = goodParams() as Record<string, unknown>;
    bad.authenticatedSender = { ...goodSender(), [key]: "smuggled" };
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error(`should have refused nested unknown key 'authenticatedSender.${key}'`);
    expect(r.field).toBe(`authenticatedSender.${key}`);
    expect(r.reason).toMatch(/not part of the Agent typed contract/);
  });

  test("副指挥 exact repro from checkpoint 2: nested method smuggled → rejected", () => {
    const bad = {
      ...goodParams(),
      evil: "ignored",
      params: "ignored",
      authenticatedSender: { ...goodSender(), method: "smuggled" },
    };
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error("expected refusal — this is the checkpoint-2 repro");
    // First offending key is the top-level one caught first (evil).
    expect(["evil", "params", "authenticatedSender.method"]).toContain(r.field);
  });

  test("params not an object → refused", () => {
    expect(parseEnqueueTaskParams(null).ok).toBe(false);
    expect(parseEnqueueTaskParams([]).ok).toBe(false);
    expect(parseEnqueueTaskParams("hi").ok).toBe(false);
    expect(parseEnqueueTaskParams(42).ok).toBe(false);
  });

  test("authenticatedSender not an object → refused", () => {
    for (const bad of [null, "hi", 42, []]) {
      const r = parseEnqueueTaskParams({ ...goodParams(), authenticatedSender: bad });
      if (r.ok) throw new Error(`should have refused authenticatedSender=${JSON.stringify(bad)}`);
      expect(r.field).toBe("authenticatedSender");
    }
  });

  test.each([
    ["taskId", { messageId: "m_1", authenticatedSender: goodSender(), text: "hi" }],
    ["messageId", { taskId: "t_1", authenticatedSender: goodSender(), text: "hi" }],
    ["authenticatedSender", { taskId: "t_1", messageId: "m_1", text: "hi" }],
    ["text", { taskId: "t_1", messageId: "m_1", authenticatedSender: goodSender() }],
  ])("missing top-level '%s' → refused with `required`", (key, params) => {
    const r = parseEnqueueTaskParams(params);
    if (r.ok) throw new Error(`should have refused missing '${key}'`);
    expect(r.field).toBe(key);
    expect(r.reason).toBe("required");
  });

  test.each([
    "alias",
    "tokenId",
    "role",
    "networkId",
  ])("missing sender field '%s' → refused fail-closed (per B security contract)", (key) => {
    const bad = goodParams() as Record<string, unknown>;
    const sender = { ...goodSender() } as Record<string, unknown>;
    delete sender[key];
    bad.authenticatedSender = sender;
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error(`should have refused missing 'authenticatedSender.${key}'`);
    expect(r.field).toBe(`authenticatedSender.${key}`);
  });

  test("text empty / too long → refused", () => {
    const r1 = parseEnqueueTaskParams({ ...goodParams(), text: "" });
    if (r1.ok) throw new Error("expected refusal on empty text");
    expect(r1.field).toBe("text");

    const r2 = parseEnqueueTaskParams({ ...goodParams(), text: "a".repeat(128 * 1024 + 1) });
    if (r2.ok) throw new Error("expected refusal on >128KB text");
    expect(r2.field).toBe("text");
  });

  test("authenticatedSender.role not in enum → refused", () => {
    const r = parseEnqueueTaskParams({
      ...goodParams(),
      authenticatedSender: { ...goodSender(), role: "godmode" },
    });
    if (r.ok) throw new Error("expected refusal on bogus role");
    expect(r.field).toBe("authenticatedSender.role");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildAgentInitializeResult
// ─────────────────────────────────────────────────────────────────────

describe("buildAgentInitializeResult (initialize virtualisation)", () => {
  test("names the gateway (not Codex) and pins the protocol string", () => {
    const r = buildAgentInitializeResult();
    expect(r.serverInfo.name).toBe("codex-policy-gateway");
    expect(r.protocol).toBe("codex-policy-gateway/1");
    expect(r.methods).toContain("enqueueTask");
    expect(r.methods).toContain("getTaskState");
    expect(r.methods).toContain("cancelQueuedTask");
    expect(r.methods).toContain("runtimeState.subscribe");
    // Sorted for stability
    const sorted = [...r.methods].sort();
    expect(r.methods).toEqual(sorted);
  });

  test("does NOT mention any codex-facing method — Agent socket only sees gateway methods", () => {
    const r = buildAgentInitializeResult();
    for (const forbidden of ["turn/start", "turn/steer", "thread/resume", "serverRequest/resolved"]) {
      expect(r.methods).not.toContain(forbidden);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// dispatchAgentRequest — round-trip through the pure protocol layer
// ─────────────────────────────────────────────────────────────────────

/** In-memory backend for the dispatcher tests. */
function makeBackend(overrides: Partial<ProtocolBackend> = {}): ProtocolBackend {
  return {
    async enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult> {
      return { outcome: "accepted", taskId: args.taskId, queuePosition: 0, duplicate: false };
    },
    async getTaskState(_): Promise<TaskState> {
      return { state: "unknown" };
    },
    async cancelQueuedTask(_): Promise<CancelQueuedTaskResult> {
      return { outcome: "refused_not_queued", currentState: "unknown" };
    },
    ...overrides,
  };
}

describe("dispatchAgentRequest", () => {
  test("initialize → synthesised result, no backend call", async () => {
    let backendCalled = false;
    const backend = makeBackend({
      async enqueueTask() {
        backendCalled = true;
        return { outcome: "accepted", taskId: asTaskId("t_x"), queuePosition: 0, duplicate: false };
      },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      backend,
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    expect(out.agentId).toBe(1);
    expect((out.result as { protocol: string }).protocol).toBe("codex-policy-gateway/1");
    expect(backendCalled).toBe(false);
  });

  test("initialized → replies with empty object (compatible with id-carrying clients)", async () => {
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 2, method: "initialized" },
      makeBackend(),
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    expect(out.result).toEqual({});
  });

  test("enqueueTask with clean params → forwards to backend + returns its result", async () => {
    const backend = makeBackend({
      async enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult> {
        expect(args.text).toBe("hi");
        return { outcome: "accepted", taskId: args.taskId, queuePosition: 3, duplicate: false };
      },
    });
    const out = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
        },
      },
      backend,
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    const r = out.result as { outcome: string; queuePosition: number };
    expect(r.outcome).toBe("accepted");
    expect(r.queuePosition).toBe(3);
  });

  test("enqueueTask with banned key → InvalidArg (does NOT reach the backend)", async () => {
    let called = false;
    const backend = makeBackend({
      async enqueueTask() {
        called = true;
        return { outcome: "accepted", taskId: asTaskId("t_x"), queuePosition: 0, duplicate: false };
      },
    });
    const out = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
          threadId: "smuggled_thread", // <— banned
        },
      },
      backend,
    );
    if (out.kind !== "error") throw new Error(`expected error, got ${out.kind}`);
    expect(out.code).toBe(GatewayErrorCode.InvalidArg);
    expect(out.message).toContain("threadId");
    expect(called).toBe(false);
  });

  test("getTaskState → forwards taskId + returns state", async () => {
    const backend = makeBackend({
      async getTaskState(taskId): Promise<TaskState> {
        expect(taskId).toBe(asTaskId("t_probe"));
        return { state: "running", startedAtMs: 42 };
      },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 7, method: "getTaskState", params: { taskId: "t_probe" } },
      backend,
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    const r = out.result as { state: string };
    expect(r.state).toBe("running");
  });

  test("cancelQueuedTask → forwards taskId + returns outcome", async () => {
    const backend = makeBackend({
      async cancelQueuedTask(taskId): Promise<CancelQueuedTaskResult> {
        expect(taskId).toBe(asTaskId("t_c"));
        return { outcome: "cancelled", cancelledAtMs: 100 };
      },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 8, method: "cancelQueuedTask", params: { taskId: "t_c" } },
      backend,
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    const r = out.result as { outcome: string };
    expect(r.outcome).toBe("cancelled");
  });

  test("unknown method → UnknownMethod (-32054), never touches backend", async () => {
    let called = false;
    const backend = makeBackend({
      async enqueueTask() {
        called = true;
        return { outcome: "accepted", taskId: asTaskId("t_x"), queuePosition: 0, duplicate: false };
      },
    });
    for (const m of ["turn/start", "turn/steer", "thread/resume", "shutdown", "hacked/thing"]) {
      const out = await dispatchAgentRequest(
        { jsonrpc: "2.0", id: 9, method: m },
        backend,
      );
      if (out.kind !== "error") throw new Error(`expected error, got ${out.kind}`);
      expect(out.code).toBe(GatewayErrorCode.UnknownMethod);
      expect(out.message).toContain(m);
      // B delta: `error.data.code` carries the stable string. Consumers
      // key on that instead of the numeric where preferred.
      expect(out.data.code).toBe(GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.UnknownMethod]);
      expect(out.data.code).toBe("codex_gateway_unknown_method");
      // Diagnostic key merges on top.
      expect(out.data.method).toBe(m);
    }
    expect(called).toBe(false);
  });

  test("dispatch errors always carry stable `data.code` (matches GATEWAY_ERROR_DATA_CODE)", async () => {
    // Case 1: banned key → InvalidArg
    const err1 = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 100,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
          threadId: "smuggled", // banned
        },
      },
      makeBackend(),
    );
    if (err1.kind !== "error") throw new Error("expected error");
    expect(err1.data.code).toBe("codex_gateway_invalid_arg");
    expect(err1.data.field).toBe("threadId");
    // Case 2: backend throws an unknown exception → sanitised
    // Unavailable with source=backend (per Delta 3, f84942e8).
    // The old expectation was InvalidArg, which was WRONG — the
    // ledger/IO/P0 failure isn't the client's fault.
    const err2 = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 101,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
        },
      },
      makeBackend({
        async enqueueTask() {
          throw new Error("boom");
        },
      }),
    );
    if (err2.kind !== "error") throw new Error("expected error");
    expect(err2.data.code).toBe("codex_gateway_unavailable");
    expect(err2.data.source).toBe("backend");
  });

  test("backend throws a GatewayError → typed passthrough (code + data preserved)", async () => {
    const backend = makeBackend({
      async enqueueTask() {
        throw new GatewayError(
          GatewayErrorCode.QueueFull,
          "queue is full",
          { queueDepth: 12, limit: 8 },
        );
      },
    });
    const out = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
        },
      },
      backend,
    );
    if (out.kind !== "error") throw new Error(`expected error, got ${out.kind}`);
    expect(out.code).toBe(GatewayErrorCode.QueueFull);
    expect(out.message).toBe("queue is full");
    expect(out.data.code).toBe("codex_gateway_queue_full");
    expect(out.data.queueDepth).toBe(12);
    expect(out.data.limit).toBe(8);
  });

  test("backend throws an unknown exception → sanitised Unavailable + diagnostics sink (Δ10, no wire leak)", async () => {
    // Obviously-fake fixture strings. The test asserts none of them
    // appear on the wire; the sink still sees them raw.
    const raw = "boom -- ledger says table missing, error 5001 file=REDACTABLE_PATH token=REDACTABLE_TOKEN";
    const backend = makeBackend({
      async enqueueTask() {
        throw new Error(raw);
      },
    });
    const spy = makeDiagnosticsSpy();
    const out = await dispatchAgentRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "enqueueTask",
        params: {
          taskId: "t_1",
          messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
        },
      },
      backend,
      spy.diagnostics,
    );
    if (out.kind !== "error") throw new Error(`expected error, got ${out.kind}`);
    // Sanitised: Unavailable, not InvalidArg (that would blame the client).
    expect(out.code).toBe(GatewayErrorCode.Unavailable);
    expect(out.data.code).toBe("codex_gateway_unavailable");
    expect(out.data.source).toBe("backend");
    // Correlation id: wire response has one that MATCHES what the
    // sink saw. Operator can grep the log.
    expect(typeof out.data.correlationId).toBe("string");
    expect(spy.correlationIdsIssued).toContain(out.data.correlationId);
    // Raw internal message MUST NOT leak. This covers the concrete
    // classes of things that can end up in Error.message and would
    // be catastrophic on the wire: SQL fragments, filesystem paths,
    // token literals, error codes, table names.
    expect(out.message).toBe("gateway backend error");
    const wireDump = JSON.stringify(out);
    expect(wireDump).not.toContain("ledger");
    expect(wireDump).not.toContain("5001");
    expect(wireDump).not.toContain("REDACTABLE_PATH");
    expect(wireDump).not.toContain("REDACTABLE_TOKEN");
    // Sink got exactly ONE entry with the raw error preserved for
    // the operator log; the sink is where redaction happens (or
    // not), not on the wire.
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].operation).toBe("enqueueTask");
    expect(spy.entries[0].correlationId).toBe(out.data.correlationId);
    expect((spy.entries[0].error as Error).message).toBe(raw);
  });

  test("getTaskState backend throw → same sanitised path (not left hanging)", async () => {
    const backend = makeBackend({
      async getTaskState() { throw new Error("internal io"); },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 12, method: "getTaskState", params: { taskId: "t_1" } },
      backend,
    );
    if (out.kind !== "error") throw new Error(`expected error`);
    expect(out.code).toBe(GatewayErrorCode.Unavailable);
    expect(out.data.code).toBe("codex_gateway_unavailable");
  });

  test("cancelQueuedTask backend throw → same sanitised path", async () => {
    const backend = makeBackend({
      async cancelQueuedTask() { throw new Error("internal io"); },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 13, method: "cancelQueuedTask", params: { taskId: "t_1" } },
      backend,
    );
    if (out.kind !== "error") throw new Error(`expected error`);
    expect(out.code).toBe(GatewayErrorCode.Unavailable);
  });

  test("getTaskState backend GatewayError → typed passthrough", async () => {
    const backend = makeBackend({
      async getTaskState() {
        throw new GatewayError(
          GatewayErrorCode.UnknownTask,
          "task not found",
          { taskId: "t_missing" },
        );
      },
    });
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 14, method: "getTaskState", params: { taskId: "t_missing" } },
      backend,
    );
    if (out.kind !== "error") throw new Error(`expected error`);
    expect(out.code).toBe(GatewayErrorCode.UnknownTask);
    expect(out.data.code).toBe("codex_gateway_unknown_task");
  });

  test("runtimeState.subscribe → acknowledged (uds layer takes over)", async () => {
    const out = await dispatchAgentRequest(
      { jsonrpc: "2.0", id: 11, method: "runtimeState.subscribe" },
      makeBackend(),
    );
    if (out.kind !== "reply") throw new Error(`expected reply, got ${out.kind}`);
    const r = out.result as { ok: boolean; note: string };
    expect(r.ok).toBe(true);
    expect(r.note).toBe("handled_by_uds_layer");
  });
});

// ─────────────────────────────────────────────────────────────────────
// The unified reverse-request forgery check
// ─────────────────────────────────────────────────────────────────────

describe("reverse-request forgery — Agent can't reach the TUI namespace", () => {
  test("Agent's dispatchAgentRequest surface exposes NO way to consume a TUI id", () => {
    // Exhaustive: `dispatchAgentRequest` reads only `frame.id` /
    // `frame.method` / `frame.params`. The RequestIdNamespace class
    // isn't threaded through the dispatcher at all (it's driven by
    // uds-server.ts on the transport side). So there's no code path
    // in this layer where an Agent frame can touch the reverse-request
    // side.
    // This test asserts the source-level property: `dispatchAgentRequest`
    // does not import RequestIdNamespace.
    // (Kept as a shape assertion so a refactor that adds a shortcut
    // fails visibly.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require("node:fs").readFileSync(__dirname + "/protocol.ts", "utf-8");
    const dispatchBody = src.slice(src.indexOf("export async function dispatchAgentRequest"));
    // The function body should NOT reference the reverse namespace.
    expect(dispatchBody).not.toContain("consumeCodexReverseByTuiId");
    expect(dispatchBody).not.toContain("allocateTuiIdForCodexReverseRequest");
    expect(dispatchBody).not.toContain("codexReverseToTui");
    expect(dispatchBody).not.toContain("tuiToCodexReverse");
  });
});
