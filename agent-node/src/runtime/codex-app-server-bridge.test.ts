// RFC-030 Phase 0 — bridge behaviour tests for CodexAppServerBridge.
//
// Uses a real WS server as the fake `codex app-server` and drives it by hand
// to reproduce the scenarios that matter:
//   - bootstrap: initialize → initialized → thread/resume
//   - turn/start returns turnId, bridge tracks pending
//   - turn/completed on OUR turn triggers task_reply
//   - turn/completed on a HUMAN-TUI turn (unknown turnId) is dropped
//   - cross-thread events are dropped
//   - reverse request (approval) → waiting_human, NO response sent
//   - serverRequest/resolved clears waiting_human; status recovers
//   - two bridges pointed at the same fake server race for `idle` — only one
//     wins turn/start; the other observes the winner's turn and does not
//     produce a task_reply.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { CodexAppServerClient } from "./codex-app-server-client";
import { CodexAppServerBridge } from "./codex-app-server-bridge";

// ────────────────────────────────────────────────────────────────────────────
// Fake app-server that autoreplies to initialize / thread/resume / turn/start.
// ────────────────────────────────────────────────────────────────────────────

interface FakeApp {
  url: string;
  received: object[];
  connections: Set<{ send: (s: string) => void }>;
  broadcast: (obj: object) => void;
  /** Send only to the client that most recently sent a request. */
  respondLast: (result: object | { error: object }) => void;
  /** Send to the client whose sequence number is offered. */
  connectionCount: () => number;
  stop: () => Promise<void>;
}

async function startFakeApp(config?: {
  onRequest?: (
    msg: { id: number; method: string; params?: unknown },
    respond: (r: { result?: unknown; error?: { code: number; message: string } }) => void,
    broadcast: (obj: object) => void,
  ) => void;
}): Promise<FakeApp> {
  const received: object[] = [];
  const connections = new Set<{ send: (s: string) => void }>();
  let lastResponder: ((s: string) => void) | null = null;
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
      message(ws, raw) {
        const line = typeof raw === "string" ? raw : String(raw);
        const parsed = JSON.parse(line);
        received.push(parsed);
        const handle = (ws as unknown as { data: { handle: { send: (s: string) => void } } }).data.handle;
        lastResponder = handle.send;
        if (typeof parsed.id === "number" && typeof parsed.method === "string") {
          const respond = (r: { result?: unknown; error?: { code: number; message: string } }) => {
            handle.send(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, ...r }));
          };
          const broadcast = (obj: object) => {
            const line = JSON.stringify(obj);
            for (const c of connections) c.send(line);
          };
          if (config?.onRequest) {
            config.onRequest(parsed, respond, broadcast);
          } else {
            // Default: auto-ok initialize / thread/resume; assign turnId to turn/start.
            if (parsed.method === "initialize") {
              respond({ result: { serverInfo: { name: "fake-codex" } } });
            } else if (parsed.method === "thread/resume") {
              respond({ result: {} });
            } else if (parsed.method === "turn/start") {
              respond({ result: { turnId: `turn_${received.length}` } });
            }
          }
        }
      },
      close(ws) {
        const handle = (ws as unknown as { data?: { handle?: { send: (s: string) => void } } }).data?.handle;
        if (handle) connections.delete(handle);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    connections,
    broadcast: (obj: object) => {
      const line = JSON.stringify(obj);
      for (const c of connections) c.send(line);
    },
    respondLast: (r) => {
      if (lastResponder) lastResponder(JSON.stringify({ jsonrpc: "2.0", ...r }));
    },
    connectionCount: () => connections.size,
    stop: async () => {
      server.stop(true);
    },
  };
}

const THREAD = "thread_abc";

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap + happy path
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerBridge — bootstrap + task mapping", () => {
  let app: FakeApp;
  let client: CodexAppServerClient;
  let bridge: CodexAppServerBridge;

  beforeEach(async () => {
    app = await startFakeApp();
    client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
  });
  afterEach(async () => {
    await client.close().catch(() => undefined);
    await app.stop();
  });

  test("bootstrap sends initialize + initialized + thread/resume in order", () => {
    const methods = app.received
      .map((m) => (m as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(bridge.currentStatus()).toBe("idle");
  });

  test("startTaskTurn returns the server-assigned turnId and marks bridge working", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_1", text: "please help" });
    expect(turnId).toBeTypeOf("string");
    expect(bridge.currentStatus()).toBe("working");
    expect(bridge.activeTurn()).toBe(turnId);
    expect(bridge.pendingTurnCount()).toBe(1);
  });

  test("turn/completed for OUR turn fires task_reply mapped back to the task_id", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_1", text: "hello" });
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r as never));
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turnId, finalText: "done!" },
    });
    await tick(10);
    expect(replies).toEqual([{ taskId: "task_1", text: "done!" }]);
    expect(bridge.currentStatus()).toBe("idle");
    expect(bridge.activeTurn()).toBeNull();
  });

  test("agentMessage/delta accumulates when server omits finalText", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_1", text: "hi" });
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r as never));
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: THREAD, turnId, delta: { text: "hello " } },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: THREAD, turnId, delta: { text: "world" } },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turnId /* no finalText */ },
    });
    await tick(10);
    expect(replies).toEqual([{ taskId: "task_1", text: "hello world" }]);
  });

  test("turn/completed for a HUMAN-TUI-initiated turn is dropped (§7.5)", async () => {
    // No startTaskTurn — bridge has no pending turns.
    const replies: unknown[] = [];
    const drops: unknown[] = [];
    bridge.on("task_reply", (r) => replies.push(r));
    bridge.on("unowned_turn_drop", (d) => drops.push(d));
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turnId: "turn_human_only", finalText: "human turn text" },
    });
    await tick(10);
    expect(replies).toHaveLength(0);
    expect(drops).toHaveLength(1);
  });

  test("events for a DIFFERENT thread are dropped (defense in depth)", async () => {
    const drops: unknown[] = [];
    bridge.on("cross_thread_drop", (d) => drops.push(d));
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "OTHER_THREAD", turnId: "whatever", finalText: "nope" },
    });
    await tick(10);
    expect(drops).toHaveLength(1);
  });

  test("startTaskTurn refuses a second task while one is active", async () => {
    await bridge.startTaskTurn({ taskId: "task_a", text: "first" });
    let caught: Error | null = null;
    try {
      await bridge.startTaskTurn({ taskId: "task_b", text: "second" });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("active");
  });

  test("turn/completed with an error field fires task_error, NOT task_reply", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_1", text: "hi" });
    const replies: unknown[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r));
    bridge.on("task_error", (e) => errors.push(e as never));
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turnId, error: { message: "model unavailable" } },
    });
    await tick(10);
    expect(replies).toHaveLength(0);
    expect(errors).toEqual([{ taskId: "task_1", error: "model unavailable" }]);
    expect(bridge.currentStatus()).toBe("idle");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Approval / waiting_human (§7.6)
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerBridge — approvals (waiting_human) §7.6", () => {
  let app: FakeApp;
  let client: CodexAppServerClient;
  let bridge: CodexAppServerBridge;

  beforeEach(async () => {
    app = await startFakeApp();
    client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
  });
  afterEach(async () => {
    await client.close().catch(() => undefined);
    await app.stop();
  });

  test("reverse-request approval records waiting_human and sends NO response", async () => {
    await bridge.startTaskTurn({ taskId: "task_1", text: "run tests" });
    const initialSentCount = app.received.length;
    const waits: unknown[] = [];
    bridge.on("waiting_human", (w) => waits.push(w));

    app.broadcast({
      jsonrpc: "2.0",
      id: 501,
      method: "item/tool/requestApproval",
      params: { toolName: "shell", command: "rm -rf /" },
    });
    await tick(10);

    // Bridge records
    expect(waits).toHaveLength(1);
    expect(bridge.isWaitingHuman()).toBe(true);
    expect(bridge.currentStatus()).toBe("waiting_human");

    // The critical anti-regression: bridge sent NOTHING back to the server
    // during the approval window. That is what routes the decision to the
    // human TUI (which is the second client).
    expect(app.received.length).toBe(initialSentCount);
  });

  test("serverRequest/resolved clears waiting_human and status recovers", async () => {
    await bridge.startTaskTurn({ taskId: "task_1", text: "…" });
    app.broadcast({
      jsonrpc: "2.0",
      id: 700,
      method: "item/tool/requestApproval",
      params: {},
    });
    await tick(10);
    expect(bridge.currentStatus()).toBe("waiting_human");

    app.broadcast({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { reverseRequestId: 700 },
    });
    await tick(10);
    expect(bridge.isWaitingHuman()).toBe(false);
    expect(bridge.currentStatus()).toBe("working");
  });

  test("multiple concurrent approvals: bridge stays waiting_human until all resolve", async () => {
    await bridge.startTaskTurn({ taskId: "task_1", text: "…" });
    app.broadcast({ jsonrpc: "2.0", id: 800, method: "item/tool/requestApproval", params: {} });
    app.broadcast({ jsonrpc: "2.0", id: 801, method: "item/tool/requestUserInput", params: {} });
    await tick(10);
    expect(bridge.currentStatus()).toBe("waiting_human");

    app.broadcast({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { reverseRequestId: 800 },
    });
    await tick(10);
    expect(bridge.currentStatus()).toBe("waiting_human"); // still one open

    app.broadcast({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { reverseRequestId: 801 },
    });
    await tick(10);
    expect(bridge.currentStatus()).toBe("working");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Race: two bridges (or a bridge + a TUI) sharing one server (§6.1, §6.3)
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerBridge — two-client race for idle", () => {
  test("only one bridge wins turn/start; the other observes and does not reply", async () => {
    let firstStartAnswered = false;
    // Server policy: only one turn per thread at a time. Second concurrent
    // turn/start gets an error until the first turn/completed is broadcast.
    let activeTurn: string | null = null;
    const app = await startFakeApp({
      onRequest: (msg, respond, _broadcast) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          if (activeTurn) {
            return respond({
              error: { code: -32010, message: "thread busy" },
            });
          }
          const turnId = `turn_${msg.id}`;
          activeTurn = turnId;
          firstStartAnswered = true;
          return respond({ result: { turnId } });
        }
      },
    });

    const clientA = new CodexAppServerClient({ url: app.url });
    const clientB = new CodexAppServerClient({ url: app.url });
    await clientA.connect();
    await clientB.connect();
    const bridgeA = new CodexAppServerBridge({ client: clientA, threadId: THREAD, bridgeLabel: "A" });
    const bridgeB = new CodexAppServerBridge({ client: clientB, threadId: THREAD, bridgeLabel: "B" });
    await bridgeA.bootstrap();
    await bridgeB.bootstrap();

    // Both bridges try to grab the thread at the same time.
    const results = await Promise.allSettled([
      bridgeA.startTaskTurn({ taskId: "task_A", text: "A" }),
      bridgeB.startTaskTurn({ taskId: "task_B", text: "B" }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    const losses = results.filter((r) => r.status === "rejected").length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    expect(firstStartAnswered).toBe(true);

    // Now broadcast completion for whichever turn the server assigned.
    const winningTurnId = activeTurn!;
    const repliesA: Array<{ taskId: string }> = [];
    const repliesB: Array<{ taskId: string }> = [];
    bridgeA.on("task_reply", (r) => repliesA.push(r as never));
    bridgeB.on("task_reply", (r) => repliesB.push(r as never));

    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turnId: winningTurnId, finalText: "shared reply" },
    });
    await tick(15);

    // Exactly one bridge should attribute the reply to its own task.
    const totalReplies = repliesA.length + repliesB.length;
    expect(totalReplies).toBe(1);

    await clientA.close();
    await clientB.close();
    await app.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
