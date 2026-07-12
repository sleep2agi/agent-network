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
  buildAgentInitializeResult,
  classifyMessage,
  dispatchAgentRequest,
  enforceMethodOnAgentSide,
  enforceMethodOnTuiSide,
  parseEnqueueTaskParams,
  RequestIdNamespace,
  AGENT_ALLOWED_METHODS,
  TUI_ALLOWED_METHODS,
  type ProtocolBackend,
} from "./protocol";
import {
  asMessageId,
  asTaskId,
  GATEWAY_ERROR_DATA_CODE,
  GatewayErrorCode,
  type CancelQueuedTaskResult,
  type EnqueueTaskArgs,
  type EnqueueTaskResult,
  type TaskState,
} from "./contract";

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

describe("method whitelist", () => {
  test("Agent side accepts the typed contract + initialize/initialized only", () => {
    expect(enforceMethodOnAgentSide("enqueueTask")).toBe(true);
    expect(enforceMethodOnAgentSide("getTaskState")).toBe(true);
    expect(enforceMethodOnAgentSide("cancelQueuedTask")).toBe(true);
    expect(enforceMethodOnAgentSide("runtimeState.subscribe")).toBe(true);
    expect(enforceMethodOnAgentSide("runtimeState.unsubscribe")).toBe(true);
    expect(enforceMethodOnAgentSide("initialize")).toBe(true);
    expect(enforceMethodOnAgentSide("initialized")).toBe(true);
  });

  test("Agent side rejects raw Codex/MCP methods", () => {
    for (const m of ["turn/start", "turn/steer", "thread/resume", "shutdown", "serverRequest/resolved"]) {
      expect(enforceMethodOnAgentSide(m)).toBe(false);
    }
  });

  test("TUI side accepts only initialize/initialized (responses are id-only, not method-carrying)", () => {
    expect(enforceMethodOnTuiSide("initialize")).toBe(true);
    expect(enforceMethodOnTuiSide("initialized")).toBe(true);
    expect(enforceMethodOnTuiSide("enqueueTask")).toBe(false);
    expect(enforceMethodOnTuiSide("turn/start")).toBe(false);
    expect(enforceMethodOnTuiSide("shutdown")).toBe(false);
  });

  test("AGENT_ALLOWED_METHODS + TUI_ALLOWED_METHODS have exactly the sets Wave 1A pinned", () => {
    expect(Array.from(AGENT_ALLOWED_METHODS).sort()).toEqual([
      "cancelQueuedTask",
      "enqueueTask",
      "getTaskState",
      "initialize",
      "initialized",
      "runtimeState.subscribe",
      "runtimeState.unsubscribe",
    ]);
    expect(Array.from(TUI_ALLOWED_METHODS).sort()).toEqual([
      "initialize",
      "initialized",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// RequestIdNamespace
// ─────────────────────────────────────────────────────────────────────

describe("RequestIdNamespace — Agent ↔ upstream", () => {
  test("allocates monotonic upstream ids starting at 1", () => {
    const ns = new RequestIdNamespace();
    expect(ns.allocateUpstreamIdForAgentRequest(1)).toEqual({ upstreamId: 1 });
    expect(ns.allocateUpstreamIdForAgentRequest(2)).toEqual({ upstreamId: 2 });
    expect(ns.allocateUpstreamIdForAgentRequest("abc")).toEqual({ upstreamId: 3 });
  });

  test("out-of-order response arrival works — consume returns matching agent id", () => {
    const ns = new RequestIdNamespace();
    ns.allocateUpstreamIdForAgentRequest(10);   // upstream=1
    ns.allocateUpstreamIdForAgentRequest(11);   // upstream=2
    ns.allocateUpstreamIdForAgentRequest(12);   // upstream=3
    // Responses arrive in reverse order.
    expect(ns.consumeAgentResponseByUpstreamId(3)).toBe(12);
    expect(ns.consumeAgentResponseByUpstreamId(1)).toBe(10);
    expect(ns.consumeAgentResponseByUpstreamId(2)).toBe(11);
    expect(ns.pendingCounts().agentRequestsPending).toBe(0);
  });

  test("ID collision — same agent id in flight refused", () => {
    const ns = new RequestIdNamespace();
    expect(ns.allocateUpstreamIdForAgentRequest(1)).toEqual({ upstreamId: 1 });
    const collision = ns.allocateUpstreamIdForAgentRequest(1);
    if (!("collision" in collision) || !collision.collision) {
      throw new Error(`expected collision, got ${JSON.stringify(collision)}`);
    }
  });

  test("ID collision distinguishes numeric 1 from string \"1\" (no accidental merge)", () => {
    const ns = new RequestIdNamespace();
    expect(ns.allocateUpstreamIdForAgentRequest(1)).toEqual({ upstreamId: 1 });
    // "1" is a DIFFERENT id per JSON-RPC (`n:1` vs `s:1` internally).
    expect(ns.allocateUpstreamIdForAgentRequest("1")).toEqual({ upstreamId: 2 });
  });

  test("consuming a spoof upstream id (never allocated) returns null", () => {
    const ns = new RequestIdNamespace();
    expect(ns.consumeAgentResponseByUpstreamId(999)).toBeNull();
  });

  test("consume with non-numeric upstream id is null (upstream ids are always numeric)", () => {
    const ns = new RequestIdNamespace();
    expect(ns.consumeAgentResponseByUpstreamId("999")).toBeNull();
  });

  test("consuming twice returns null the second time — no double-consume", () => {
    const ns = new RequestIdNamespace();
    ns.allocateUpstreamIdForAgentRequest(1);
    expect(ns.consumeAgentResponseByUpstreamId(1)).toBe(1);
    expect(ns.consumeAgentResponseByUpstreamId(1)).toBeNull();
  });

  test("after consuming, the same agent id can be reused for a new request", () => {
    const ns = new RequestIdNamespace();
    ns.allocateUpstreamIdForAgentRequest(1);
    expect(ns.consumeAgentResponseByUpstreamId(1)).toBe(1);
    expect(ns.allocateUpstreamIdForAgentRequest(1)).toEqual({ upstreamId: 2 });
  });
});

describe("RequestIdNamespace — Codex reverse ↔ TUI", () => {
  test("Codex reverse-request ids and Agent ids share no state", () => {
    const ns = new RequestIdNamespace();
    ns.allocateUpstreamIdForAgentRequest(1);           // Agent id 1 in flight
    // Codex sends reverse request with id 1 — different namespace, no collision.
    const alloc = ns.allocateTuiIdForCodexReverseRequest(1);
    if ("collision" in alloc && alloc.collision) throw new Error("must not collide across namespaces");
    if (!("tuiId" in alloc)) throw new Error("must allocate a tui id");
    expect(alloc.tuiId).toBe(1);
    // Consuming Agent side does NOT affect the reverse map.
    ns.consumeAgentResponseByUpstreamId(1);
    expect(ns.pendingCounts()).toEqual({
      agentRequestsPending: 0,
      codexReverseRequestsPending: 1,
    });
  });

  test("TUI response is rewritten back to the Codex reverse id", () => {
    const ns = new RequestIdNamespace();
    ns.allocateTuiIdForCodexReverseRequest("cx_5"); // reverse id "cx_5" → tuiId 1
    expect(ns.consumeCodexReverseByTuiId(1)).toBe("cx_5");
  });

  test("collision within reverse namespace refused", () => {
    const ns = new RequestIdNamespace();
    ns.allocateTuiIdForCodexReverseRequest("cx_1");
    const c = ns.allocateTuiIdForCodexReverseRequest("cx_1");
    if (!("collision" in c) || !c.collision) throw new Error("must collide within same reverse ns");
  });

  test("spoofed TUI id consumption returns null (reverse-request forgery prevention)", () => {
    const ns = new RequestIdNamespace();
    // TUI didn't get any reverse request. It tries to answer id=1 anyway.
    expect(ns.consumeCodexReverseByTuiId(1)).toBeNull();
  });

  test("drainAll clears both namespaces (used on shutdown / TUI disconnect)", () => {
    const ns = new RequestIdNamespace();
    ns.allocateUpstreamIdForAgentRequest(1);
    ns.allocateTuiIdForCodexReverseRequest("cx_1");
    expect(ns.pendingCounts()).toEqual({
      agentRequestsPending: 1,
      codexReverseRequestsPending: 1,
    });
    ns.drainAll();
    expect(ns.pendingCounts()).toEqual({
      agentRequestsPending: 0,
      codexReverseRequestsPending: 0,
    });
    // After drain, previously-pending consumes fail closed.
    expect(ns.consumeAgentResponseByUpstreamId(1)).toBeNull();
    expect(ns.consumeCodexReverseByTuiId(1)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseEnqueueTaskParams — Wave-0 banned identifier defense
// ─────────────────────────────────────────────────────────────────────

describe("parseEnqueueTaskParams", () => {
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

  test("happy path — all required fields, no banned fields", () => {
    const r = parseEnqueueTaskParams(goodParams());
    if (!r.ok) throw new Error(`expected ok, got ${r.reason} on ${r.field}`);
    expect(r.args.text).toBe("hi");
    expect(r.args.authenticatedSender.tokenId).toBe("tok_1");
  });

  test.each([
    "method",
    "threadId",
    "turnId",
    "policy",
    "path",
    "config",
    "requestId",
    "jsonrpc",
    "id",
  ])("banned key '%s' → rejected even when other required fields present", (key) => {
    const bad: Record<string, unknown> = { ...goodParams(), [key]: "smuggled" };
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error(`should have refused banned key '${key}'`);
    expect(r.field).toBe(key);
    expect(r.reason).toMatch(/not part of the Agent typed contract/);
  });

  test("params not an object → refused", () => {
    expect(parseEnqueueTaskParams(null).ok).toBe(false);
    expect(parseEnqueueTaskParams([]).ok).toBe(false);
    expect(parseEnqueueTaskParams("hi").ok).toBe(false);
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

  test("authenticatedSender missing tokenId → refused", () => {
    const bad = goodParams() as Record<string, unknown>;
    const sender = { ...goodSender() } as Record<string, unknown>;
    delete sender.tokenId;
    bad.authenticatedSender = sender;
    const r = parseEnqueueTaskParams(bad);
    if (r.ok) throw new Error("expected refusal on missing tokenId");
    expect(r.field).toBe("authenticatedSender.tokenId");
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
    // Case 2: backend throws → InvalidArg with source=backend
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
    expect(err2.data.code).toBe("codex_gateway_invalid_arg");
    expect(err2.data.source).toBe("backend");
  });

  test("backend throws inside enqueueTask → surfaces as InvalidArg (never leaves the request hanging)", async () => {
    const backend = makeBackend({
      async enqueueTask() {
        throw new Error("backend blew up");
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
    expect(out.code).toBe(GatewayErrorCode.InvalidArg);
    expect(out.message).toContain("backend blew up");
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
