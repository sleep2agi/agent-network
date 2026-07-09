// RFC-030 Phase 0 — dispatch correctness tests for CodexAppServerClient.
//
// The load-bearing question: does the client route a message that carries
// BOTH `method` and `id` (a reverse request) to the `reverse_request` path
// instead of the response/orphan path? That's the bug in codex-stdio-client.ts
// (line ~145) that we must not repeat.
//
// These tests exercise the client's internal dispatch via a fake WS. We do
// not spawn a real `codex app-server` here — that lives in the docker smoke.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { CodexAppServerClient } from "./codex-app-server-client";

// ────────────────────────────────────────────────────────────────────────────
// Fake WebSocket server on loopback. Small helper to avoid pulling in `ws`.
// ────────────────────────────────────────────────────────────────────────────

interface FakeServer {
  url: string;
  connections: Set<{ send: (s: string) => void }>;
  received: string[];
  broadcast: (msg: object) => void;
  stop: () => Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const received: string[] = [];
  const connections = new Set<{ send: (s: string) => void }>();
  // Use Bun.serve — matches the agent-node runtime.
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        const handle = { send: (s: string) => ws.send(s) };
        connections.add(handle);
        (ws as unknown as { data: { handle: { send: (s: string) => void } } }).data = { handle };
      },
      message(_ws, msg) {
        received.push(typeof msg === "string" ? msg : String(msg));
      },
      close(ws) {
        const handle = (ws as unknown as { data?: { handle?: { send: (s: string) => void } } }).data?.handle;
        if (handle) connections.delete(handle);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    connections,
    received,
    broadcast: (obj: object) => {
      const line = JSON.stringify(obj);
      for (const c of connections) c.send(line);
    },
    stop: async () => {
      server.stop(true);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerClient — dispatch correctness (RFC-030 §7 + bug fix)", () => {
  let server: FakeServer;
  let client: CodexAppServerClient;

  beforeEach(async () => {
    server = await startFakeServer();
    client = new CodexAppServerClient({ url: server.url });
    await client.connect();
  });
  afterEach(async () => {
    await client.close().catch(() => undefined);
    await server.stop();
  });

  test("reverse request (method + id) routes to `reverse_request`, NOT orphan_response", async () => {
    // This is the exact bug pattern the RFC calls out: codex-stdio-client.ts
    // checks id first and would treat this as an orphan response.
    const rrEvents: Array<{ id: number; method: string; params: unknown }> = [];
    const orphans: unknown[] = [];
    client.on("reverse_request", (rr) => rrEvents.push(rr as never));
    client.on("orphan_response", (msg) => orphans.push(msg));

    server.broadcast({
      jsonrpc: "2.0",
      id: 999,
      method: "item/tool/requestApproval",
      params: { toolName: "shell", command: "rm -rf /" },
    });
    await tick();

    expect(rrEvents).toHaveLength(1);
    expect(rrEvents[0].id).toBe(999);
    expect(rrEvents[0].method).toBe("item/tool/requestApproval");
    expect((rrEvents[0].params as { toolName: string }).toolName).toBe("shell");
    expect(orphans).toHaveLength(0);
  });

  test("reverse request also fires `reverse:<method>` targeted event", async () => {
    const hit: Array<{ id: number; params: unknown }> = [];
    client.on("reverse:item/tool/requestApproval", (ev) => hit.push(ev as never));
    server.broadcast({ jsonrpc: "2.0", id: 42, method: "item/tool/requestApproval", params: {} });
    await tick();
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe(42);
  });

  test("notification (method + no id) routes to method-keyed event", async () => {
    const deltas: Array<{ text: string }> = [];
    const generic: unknown[] = [];
    client.on("item/agentMessage/delta", (p) => deltas.push(p as { text: string }));
    client.on("notification", (n) => generic.push(n));
    server.broadcast({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { text: "hi" } });
    await tick();
    expect(deltas).toEqual([{ text: "hi" }]);
    expect(generic).toHaveLength(1);
  });

  test("response (id + result) resolves the matching pending request", async () => {
    // Route: client sends a request; server replies with matching id.
    const respPromise = client.request<{ ok: true }>("initialize", { clientInfo: {} });
    await tick();
    expect(server.received.length).toBeGreaterThan(0);
    const req = JSON.parse(server.received[0]);
    expect(req.method).toBe("initialize");
    expect(req.id).toBeTypeOf("number");
    server.broadcast({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
    const resp = await respPromise;
    expect(resp).toEqual({ ok: true });
  });

  test("response (id + error) rejects with codex-formatted Error", async () => {
    const respPromise = client.request("thread/resume", { threadId: "not-real" });
    await tick();
    const req = JSON.parse(server.received[0]);
    server.broadcast({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: "unknown thread" },
    });
    let caught: Error | null = null;
    try {
      await respPromise;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("-32001");
    expect(caught!.message).toContain("unknown thread");
    // The pending method name should be included so callers can grep by call site.
    expect(caught!.message).toContain("thread/resume");
  });

  test("orphan response (id present, no matching pending) fires `orphan_response`", async () => {
    const orphans: unknown[] = [];
    client.on("orphan_response", (m) => orphans.push(m));
    server.broadcast({ jsonrpc: "2.0", id: 99999, result: { unrelated: true } });
    await tick();
    expect(orphans).toHaveLength(1);
  });

  test("malformed messages fire `malformed`", async () => {
    const bad: unknown[] = [];
    client.on("malformed", (m) => bad.push(m));
    // No id, no method — nothing dispatchable.
    server.broadcast({ jsonrpc: "2.0", garbage: true });
    await tick();
    expect(bad).toHaveLength(1);
  });

  test("parse errors on non-JSON payload fire `parse_error`", async () => {
    // We need the server to send raw non-JSON. Reach into a connection.
    const errors: Array<{ line: string; error: unknown }> = [];
    client.on("parse_error", (e) => errors.push(e as never));
    for (const c of server.connections) c.send("this is not json {[");
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toContain("not json");
  });

  test("request timeout rejects the pending promise and cleans up the entry", async () => {
    const p = client.request("thread/resume", { threadId: "never-answered" }, 40);
    let caught: Error | null = null;
    try {
      await p;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("timed out");
  });

  test("close rejects any in-flight request cleanly (no unhandled rejection)", async () => {
    const p = client.request("thread/resume", { threadId: "will-be-cut-off" }, 5_000);
    // Server never answers; we close.
    await client.close();
    let caught: Error | null = null;
    try {
      await p;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("closed");
  });

  test("respondToReverseRequest emits a well-formed response envelope", async () => {
    // The bridge policy is to NOT respond in Phase 0, but the primitive
    // still has to exist for later phases and must round-trip cleanly.
    server.broadcast({ jsonrpc: "2.0", id: 7, method: "tool/proxy/invoke", params: {} });
    await tick();
    client.respondToReverseRequest(7, { ok: true, output: "done" });
    await tick();
    const last = server.received[server.received.length - 1];
    const parsed = JSON.parse(last);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true, output: "done" } });
  });

  test("errorReverseRequest emits a JSON-RPC error envelope", async () => {
    client.errorReverseRequest(8, -32000, "not permitted", { hint: "no perms" });
    await tick();
    const last = server.received[server.received.length - 1];
    const parsed = JSON.parse(last);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toBe("not permitted");
    expect(parsed.error.data.hint).toBe("no perms");
  });
});

// A tiny helper — Bun's WebSocket delivers on the next microtask. We yield
// two macrotasks to be safe on slower CI runners.
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}
