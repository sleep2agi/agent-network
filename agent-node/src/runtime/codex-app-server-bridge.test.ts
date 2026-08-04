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
            } else if (parsed.method === "thread/start") {
              respond({ result: { threadId: "thread_new_xyz" } });
            } else if (parsed.method === "turn/start") {
              respond({ result: { turn: { id: `turn_${received.length}` } } });
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

  test("empty threadId → bootstrap creates a thread (thread/start) and adopts its id", async () => {
    const app2 = await startFakeApp();
    const client2 = new CodexAppServerClient({ url: app2.url });
    await client2.connect();
    const bridge2 = new CodexAppServerBridge({ client: client2 }); // no threadId
    const ready: Array<{ threadId: string; created: boolean }> = [];
    bridge2.on("thread_ready", (e) => ready.push(e as never));
    await bridge2.bootstrap();
    const methods = app2.received.map((m) => (m as { method?: string }).method).filter(Boolean);
    expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
    expect(bridge2.getThreadId()).toBe("thread_new_xyz");
    expect(ready).toEqual([{ threadId: "thread_new_xyz", created: true }]);
    expect(bridge2.currentStatus()).toBe("idle");
    await client2.close().catch(() => undefined);
    await app2.stop();
  });

  test("stale threadId with no rollout → resume fails, bootstrap falls back to thread/start", async () => {
    const app2 = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume")
          return respond({ error: { code: -32600, message: "no rollout found for thread id stale_id" } });
        if (msg.method === "thread/start") return respond({ result: { threadId: "thread_fresh" } });
      },
    });
    const client2 = new CodexAppServerClient({ url: app2.url });
    await client2.connect();
    const bridge2 = new CodexAppServerBridge({ client: client2, threadId: "stale_id" });
    const ready: Array<{ threadId: string; created: boolean }> = [];
    bridge2.on("thread_ready", (e) => ready.push(e as never));
    await bridge2.bootstrap();
    expect(bridge2.getThreadId()).toBe("thread_fresh");
    expect(ready).toEqual([{ threadId: "thread_fresh", created: true }]);
    expect(bridge2.currentStatus()).toBe("idle");
    await client2.close().catch(() => undefined);
    await app2.stop();
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
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId, item: { type: "agentMessage", phase: "final_answer", text: "done!" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: turnId } },
    });
    await tick(10);
    expect(replies).toEqual([{ taskId: "task_1", text: "done!" }]);
    expect(bridge.currentStatus()).toBe("idle");
    expect(bridge.activeTurn()).toBeNull();
  });

  test("clientUserMessageId rebinds a task when a goal successor replaces the turn/start response id", async () => {
    await client.close();
    await app.stop();
    app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") {
          return respond({ result: {} });
        }
        if (msg.method === "thread/read") {
          return respond({ result: { thread: { status: { type: "active" }, turns: [] } } });
        }
        if (msg.method === "turn/start") {
          return respond({ result: { turn: { id: "turn_response_phantom" } } });
        }
      },
    });
    client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();

    const started: Array<{ taskId: string; turnId: string }> = [];
    const rebound: Array<{ taskId: string; fromTurnId: string; toTurnId: string }> = [];
    const replies: Array<{ taskId: string; text: string }> = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    bridge.on("task_started", (event) => started.push(event as never));
    bridge.on("task_turn_rebound", (event) => rebound.push(event as never));
    bridge.on("task_reply", (event) => replies.push(event as never));
    bridge.on("task_error", (event) => errors.push(event as never));

    const result = await bridge.submitTask({ taskId: "goal-race", text: "answer me" });
    expect(result).toEqual({ started: true, turnId: "turn_response_phantom" });
    // Two turns are concurrently in progress. A positional/latest-turn
    // heuristic would bind the task to this first, wrong client id.
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD, turn: { id: "turn_competing_wrong_client", status: "inProgress" } },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: "turn_competing_wrong_client",
        item: { type: "userMessage", clientId: "anet:different-task" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD, turn: { id: "turn_actual_successor", status: "inProgress" } },
    });
    // The response-id turn can report interrupted while the actual successor
    // is taking ownership. It must not fail the Hub task before identity is
    // confirmed by the echoed client id.
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_response_phantom", status: "interrupted" } },
    });
    await tick(10);
    expect(errors).toEqual([]);
    expect(replies).toEqual([]);

    app.broadcast({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: "turn_competing_wrong_client",
        item: { type: "agentMessage", phase: "final_answer", text: "wrong concurrent reply" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_competing_wrong_client", status: "completed" } },
    });
    await tick(10);
    expect(rebound).toEqual([]);
    expect(replies).toEqual([]);

    app.broadcast({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: "turn_actual_successor",
        item: { type: "userMessage", clientId: "anet:goal-race" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: "turn_actual_successor",
        item: { type: "agentMessage", phase: "final_answer", text: "race-safe reply" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_actual_successor", status: "completed" } },
    });
    await tick(20);

    expect(started).toEqual([{ taskId: "goal-race", turnId: "turn_response_phantom", steered: false }]);
    expect(rebound).toEqual([{
      taskId: "goal-race",
      fromTurnId: "turn_response_phantom",
      toTurnId: "turn_actual_successor",
      clientUserMessageId: "anet:goal-race",
    }]);
    expect(errors).toEqual([]);
    expect(replies).toEqual([{ taskId: "goal-race", text: "race-safe reply" }]);
    expect(bridge.activeTurn()).toBeNull();
    expect(bridge.pendingTurnCount()).toBe(0);
  });

  test("client-id ownership observed before the RPC response wins without reversing task event order", async () => {
    await client.close();
    await app.stop();
    app = await startFakeApp({
      onRequest: (msg, respond, broadcast) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") {
          return respond({ result: {} });
        }
        if (msg.method === "turn/start") {
          broadcast({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: "turn_actual_early",
              item: { type: "userMessage", clientId: "anet:early-race" },
            },
          });
          // The authoritative terminal arrives before turn/start returns and
          // therefore before task_started. It must be cached, then claimed
          // after the exact client id establishes ownership.
          broadcast({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: "turn_actual_early",
              item: { type: "agentMessage", phase: "final_answer", text: "early reply" },
            },
          });
          broadcast({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: "turn_actual_early", status: "completed" } },
          });
          setTimeout(() => respond({ result: { turn: { id: "turn_response_late" } } }), 5);
        }
      },
    });
    client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();

    const events: string[] = [];
    bridge.on("task_started", () => events.push("started"));
    bridge.on("task_reply", () => events.push("reply"));
    const result = await bridge.submitTask({ taskId: "early-race", text: "answer me" });
    expect(result).toEqual({ started: true, turnId: "turn_actual_early" });
    await tick(10);
    expect(events).toEqual(["started", "reply"]);
    expect(bridge.activeTurn()).toBeNull();
  });

  test("agentMessage/delta accumulates when server omits finalText", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_1", text: "hi" });
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r as never));
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: THREAD, turnId, delta: "hello " },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: THREAD, turnId, delta: "world" },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: turnId } },
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
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "turn_human_only", item: { type: "agentMessage", phase: "final_answer", text: "human turn text" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_human_only" } },
    });
    await tick(10);
    expect(replies).toHaveLength(0);
    expect(drops).toHaveLength(1);
  });

  test("events for a DIFFERENT thread are dropped (defense in depth)", async () => {
    const drops: unknown[] = [];
    bridge.on("cross_thread_drop", (d) => drops.push(d));
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "OTHER_THREAD", turnId: "whatever", item: { type: "agentMessage", phase: "final_answer", text: "nope" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "OTHER_THREAD", turn: { id: "whatever" } },
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
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId,
        item: { type: "userMessage", clientId: "anet:task_1" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: turnId, error: { message: "model unavailable" } } },
    });
    await tick(10);
    expect(replies).toHaveLength(0);
    expect(errors).toEqual([{ taskId: "task_1", error: "model unavailable" }]);
    expect(bridge.currentStatus()).toBe("idle");
  });

  test("turn/completed with interrupted status cannot become a successful reply", async () => {
    const turnId = await bridge.startTaskTurn({ taskId: "task_interrupted", text: "hi" });
    const replies: unknown[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r));
    bridge.on("task_error", (e) => errors.push(e as never));
    app.broadcast({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId,
        item: { type: "userMessage", clientId: "anet:task_interrupted" },
      },
    });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: turnId, status: "interrupted" } },
    });
    await tick(10);
    expect(replies).toHaveLength(0);
    expect(errors).toEqual([{
      taskId: "task_interrupted",
      error: "Codex turn was interrupted without an error message",
    }]);
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

    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: winningTurnId, item: { type: "agentMessage", phase: "final_answer", text: "shared reply" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: winningTurnId } },
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

// ────────────────────────────────────────────────────────────────────────────
// Dashboard → active human TUI turn steering.
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerBridge — authenticated Dashboard steering", () => {
  test("reconnect recovers an active human turn and keeps it steerable", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "thread/read") return respond({ result: { thread: {
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "human-before-restart", status: "inProgress", items: [{ type: "userMessage", content: [{ type: "text", text: "human prompt" }] }] }],
        } } });
        if (msg.method === "turn/steer") return respond({ result: { turnId: "human-before-restart" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    expect(await bridge.recoverSharedActiveTurn()).toEqual({ turnId: "human-before-restart", steerable: true });
    expect(await bridge.submitTask({ taskId: "dash-after-restart", text: "follow up", steerIfExternalTurn: true }))
      .toEqual({ started: true, turnId: "human-before-restart", steered: true });
    expect(app.received.filter((entry) => (entry as any).method === "turn/steer")).toHaveLength(1);
    await client.close();
    await app.stop();
  });

  test("reconnect provenance keeps an orphaned network turn FIFO-only", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "thread/read") return respond({ result: { thread: {
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "network-before-restart", status: "inProgress", items: [{ type: "userMessage", content: [{ type: "text", text: "[Agent Network/task=old] work" }] }] }],
        } } });
        if (msg.method === "turn/start") return respond({ result: { turnId: "after-orphan" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    expect(await bridge.recoverSharedActiveTurn()).toEqual({ turnId: "network-before-restart", steerable: false });
    expect((await bridge.submitTask({ taskId: "dash-not-mixed", text: "do not steer", steerIfExternalTurn: true })).started).toBe(false);
    expect(app.received.filter((entry) => (entry as any).method === "turn/steer")).toHaveLength(0);
    expect(bridge.queueDepth()).toBe(1);
    app.broadcast({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD, turn: { id: "network-before-restart", status: "completed" } } });
    await tick(20);
    expect(app.received.filter((entry) => (entry as any).method === "turn/start")).toHaveLength(1);
    await client.close();
    await app.stop();
  });

  test("reconnect provenance ignores leading whitespace before the network prefix", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "thread/read") return respond({ result: { thread: {
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "spaced-network-before-restart", status: "inProgress", items: [{ type: "userMessage", content: [{ type: "text", text: "  \n[Agent Network/task=old] work" }] }] }],
        } } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    expect(await bridge.recoverSharedActiveTurn()).toEqual({ turnId: "spaced-network-before-restart", steerable: false });
    expect((await bridge.submitTask({ taskId: "dash-spaced-network", text: "queue safely", steerIfExternalTurn: true })).started).toBe(false);
    expect(app.received.filter((entry) => (entry as any).method === "turn/steer")).toHaveLength(0);
    await client.close();
    await app.stop();
  });

  test("reconnect stays FIFO-only when real-wire active history omits userMessage", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "thread/read") return respond({ result: { thread: {
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "unknown-before-restart", status: "inProgress", items: [{ type: "agentMessage", text: "partial" }] }],
        } } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    expect(await bridge.recoverSharedActiveTurn()).toEqual({ turnId: "unknown-before-restart", steerable: false });
    expect((await bridge.submitTask({ taskId: "dash-unknown", text: "queue safely", steerIfExternalTurn: true })).started).toBe(false);
    expect(app.received.filter((entry) => (entry as any).method === "turn/steer")).toHaveLength(0);
    await client.close();
    await app.stop();
  });

  test("uses exact turn/steer contract and maps the human turn final answer", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/steer") {
          const expected = (msg.params as { expectedTurnId?: string })?.expectedTurnId;
          return respond({ result: { turnId: expected } });
        }
        if (msg.method === "turn/start") return respond({ result: { turnId: "must-not-start" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    app.broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: "human-1", status: "inProgress" } } });
    await tick(10);

    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (event) => replies.push(event as never));
    const started: unknown[] = [];
    bridge.on("task_started", (event) => started.push(event));
    const submitted = await bridge.submitTask({
      taskId: "dash-1",
      text: "第二条消息",
      from: "admin",
      steerIfExternalTurn: true,
    });
    expect(submitted).toEqual({ started: true, turnId: "human-1", steered: true });
    expect(started).toEqual([{ taskId: "dash-1", turnId: "human-1", steered: true }]);
    const steer = app.received.find((entry) => (entry as { method?: string }).method === "turn/steer") as any;
    expect(steer.params).toEqual({
      threadId: THREAD,
      expectedTurnId: "human-1",
      input: [{ type: "text", text: "[Agent Network/from=admin/task=dash-1] 第二条消息" }],
    });
    expect(app.received.filter((entry) => (entry as any).method === "turn/start")).toHaveLength(0);

    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "human-1", item: { type: "agentMessage", phase: "final_answer", text: "收到并处理" } } });
    app.broadcast({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD, turn: { id: "human-1", status: "completed" } } });
    await tick(10);
    expect(replies).toEqual([{ taskId: "dash-1", text: "收到并处理" }]);
    await client.close();
    await app.stop();
  });

  test("multiple Dashboard rows steer one human turn while ordinary agent work stays queued", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/steer") return respond({ result: { turnId: (msg.params as any).expectedTurnId } });
        if (msg.method === "turn/start") return respond({ result: { turnId: "agent-after-human" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    app.broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: "human-many" } } });
    await tick(10);

    await Promise.all([
      bridge.submitTask({ taskId: "dash-a", text: "A", steerIfExternalTurn: true }),
      bridge.submitTask({ taskId: "dash-b", text: "B", steerIfExternalTurn: true }),
      bridge.submitTask({ taskId: "node-c", text: "C", from: "node" }),
    ]);
    expect(app.received.filter((entry) => (entry as any).method === "turn/steer")).toHaveLength(2);
    expect(bridge.queueDepth()).toBe(1);
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (event) => replies.push(event as never));
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "human-many", item: { type: "agentMessage", phase: "final_answer", text: "shared" } } });
    app.broadcast({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD, turn: { id: "human-many", status: "completed" } } });
    await tick(20);
    expect(replies).toEqual([
      { taskId: "dash-a", text: "shared" },
      { taskId: "dash-b", text: "shared" },
    ]);
    expect(app.received.filter((entry) => (entry as any).method === "turn/start")).toHaveLength(1);
    await client.close();
    await app.stop();
  });

  test("steer mismatch fails closed and preserves the task in the normal FIFO", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/steer") return respond({ result: { turnId: "wrong-turn" } });
        if (msg.method === "turn/start") return respond({ result: { turnId: "recovered-turn" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    app.broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: "human-race" } } });
    await tick(10);
    const result = await bridge.submitTask({ taskId: "dash-race", text: "keep me", steerIfExternalTurn: true });
    expect(result.started).toBe(false);
    await tick(20);
    expect(app.received.filter((entry) => (entry as any).method === "turn/start")).toHaveLength(1);
    expect(bridge.pendingTurnCount()).toBe(1);
    await client.close();
    await app.stop();
  });

  test("turn completion cannot attribute a task before turn/steer acceptance", async () => {
    let answerSteer!: () => void;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/steer") answerSteer = () => respond({ result: { turnId: "human-accept-race" } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    app.broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: "human-accept-race" } } });
    await tick(10);
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (event) => replies.push(event as never));
    const submission = bridge.submitTask({ taskId: "dash-accept-race", text: "late ack", steerIfExternalTurn: true });
    await tick(10);
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "human-accept-race", item: { type: "agentMessage", phase: "final_answer", text: "accepted answer" } } });
    app.broadcast({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD, turn: { id: "human-accept-race", status: "completed" } } });
    await tick(10);
    expect(replies).toHaveLength(0);
    answerSteer();
    await submission;
    expect(replies).toEqual([{ taskId: "dash-accept-race", text: "accepted answer" }]);
    await client.close();
    await app.stop();
  });

  test("reconciliation recovers a missed human turn completion and exact steered reply", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/steer") return respond({ result: { turnId: "human-missed" } });
        if (msg.method === "thread/read" && (msg.params as any).includeTurns === false) {
          return respond({ result: { thread: { status: "idle" } } });
        }
        if (msg.method === "thread/read") return respond({ result: { thread: { turns: [{ id: "human-missed", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "history answer" }] }] } } });
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    app.broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: "human-missed" } } });
    await tick(10);
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (event) => replies.push(event as never));
    await bridge.submitTask({ taskId: "dash-missed", text: "recover", steerIfExternalTurn: true });
    expect(await bridge.reconcileActiveTurn()).toEqual({ recovered: true, turnId: "human-missed", status: "completed" });
    expect(replies).toEqual([{ taskId: "dash-missed", text: "history answer" }]);
    await client.close();
    await app.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 通信龙 additions — synchronous claim race fix + submitTask FIFO queue.
// ────────────────────────────────────────────────────────────────────────────

describe("CodexAppServerBridge — sync claim + FIFO queue (通信龙)", () => {
  test("concurrent startTaskTurn: exactly ONE turn/start reaches the server even with a slow response", async () => {
    let turnStartCount = 0;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          turnStartCount++;
          // Slow server: respond after 50ms so the pre-response race window
          // (the original bug) is wide open.
          setTimeout(() => respond({ result: { turn: { id: "turn_slow_1" } } }), 50);
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();

    const results = await Promise.allSettled([
      bridge.startTaskTurn({ taskId: "t-race-1", text: "one" }),
      bridge.startTaskTurn({ taskId: "t-race-2", text: "two" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(turnStartCount).toBe(1); // the load-bearing assertion: server saw ONE start
    await client.close();
    await app.stop();
  });

  test("submitTask queues the second task and drains it after turn/completed (order preserved)", async () => {
    let seq = 0;
    const turnStartTaskIds: string[] = [];
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          seq++;
          const clientUserMessageId = (msg.params as any)?.clientUserMessageId as string;
          turnStartTaskIds.push(clientUserMessageId.replace(/^anet:/, ""));
          respond({ result: { turn: { id: `turn_q_${seq}` } } });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();

    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (r) => replies.push(r as { taskId: string; text: string }));
    const queued: string[] = [];
    bridge.on("task_queued", (q) => queued.push((q as { taskId: string }).taskId));
    const started: Array<{ taskId: string; turnId: string; steered: boolean }> = [];
    bridge.on("task_started", (event) => started.push(event as never));

    const r1 = await bridge.submitTask({ taskId: "t-q-1", text: "first" });
    const r2 = await bridge.submitTask({ taskId: "t-q-2", text: "second" });
    expect(r1.started).toBe(true);
    expect(r2.started).toBe(false);
    expect(queued).toEqual(["t-q-2"]);
    expect(bridge.queueDepth()).toBe(1);
    // Wire gate: B is admitted into bridge FIFO, but no second turn/start is
    // emitted while A is active.
    expect(turnStartTaskIds).toEqual(["t-q-1"]);
    expect(started).toEqual([{ taskId: "t-q-1", turnId: "turn_q_1", steered: false }]);

    // Complete turn 1 → bridge should auto-drain and start turn 2.
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "turn_q_1", item: { type: "agentMessage", phase: "final_answer", text: "answer-1" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_q_1" } },
    });
    // Wait for the drain's turn/start round-trip.
    await new Promise((r) => setTimeout(r, 80));
    expect(bridge.queueDepth()).toBe(0);
    expect(bridge.activeTurn()).toBe("turn_q_2");
    expect(turnStartTaskIds).toEqual(["t-q-1", "t-q-2"]);
    expect(started).toEqual([
      { taskId: "t-q-1", turnId: "turn_q_1", steered: false },
      { taskId: "t-q-2", turnId: "turn_q_2", steered: false },
    ]);

    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "turn_q_2", item: { type: "agentMessage", phase: "final_answer", text: "answer-2" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_q_2" } },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(replies.map((r) => r.taskId)).toEqual(["t-q-1", "t-q-2"]);
    expect(replies.map((r) => r.text)).toEqual(["answer-1", "answer-2"]);
    expect(bridge.currentStatus()).toBe("idle");
    await client.close();
    await app.stop();
  });

  test("cancelQueuedTask removes only the named FIFO row before it can execute", async () => {
    const startedTaskIds: string[] = [];
    let seq = 0;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          const clientId = String((msg.params as { clientUserMessageId?: string })?.clientUserMessageId ?? "");
          startedTaskIds.push(clientId.replace(/^anet:/, ""));
          return respond({ result: { turn: { id: `turn_cancel_${++seq}` } } });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();

    await bridge.submitTask({ taskId: "cancel-active", text: "first" });
    await bridge.submitTask({ taskId: "cancel-me", text: "must never execute" });
    await bridge.submitTask({ taskId: "cancel-survivor", text: "third" });
    expect(bridge.queueDepth()).toBe(2);
    expect(bridge.cancelQueuedTask("missing-task")).toBe(false);
    expect(bridge.cancelQueuedTask("cancel-me")).toBe(true);
    expect(bridge.queueDepth()).toBe(1);

    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_cancel_1", status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startedTaskIds).toEqual(["cancel-active", "cancel-survivor"]);
    expect(bridge.activeTurn()).toBe("turn_cancel_2");
    await client.close();
    await app.stop();
  });

  test("thread/read recovers a completed owned turn while a successor keeps the thread active", async () => {
    let seq = 0;
    let firstTurnIsPersistedComplete = false;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          seq++;
          return respond({ result: { turn: { id: `turn_reconcile_${seq}` } } });
        }
        if (msg.method === "thread/read") {
          const includeTurns = (msg.params as { includeTurns?: boolean } | undefined)?.includeTurns;
          return respond({
            result: {
              thread: {
                id: THREAD,
                // Production UAT: the exact owned turn completed, but a new
                // TUI/goal turn started without an idle polling gap. Aggregate
                // thread status therefore stays active throughout.
                status: { type: "active" },
                turns: includeTurns && firstTurnIsPersistedComplete
                  ? [{
                      id: "turn_reconcile_1",
                      status: "completed",
                      items: [{
                        type: "agentMessage",
                        phase: "final_answer",
                        text: "recovered-answer-1",
                      }],
                    }]
                  : undefined,
              },
            },
          });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (reply) => replies.push(reply as { taskId: string; text: string }));

    await bridge.submitTask({ taskId: "t-reconcile-1", text: "first" });
    await bridge.submitTask({ taskId: "t-reconcile-2", text: "second" });
    expect(bridge.activeTurn()).toBe("turn_reconcile_1");
    expect(bridge.queueDepth()).toBe(1);

    // No turn/completed notification is broadcast. A non-terminal persisted
    // status must not release the local claim.
    expect(await bridge.reconcileActiveTurn()).toEqual({
      recovered: false,
      turnId: "turn_reconcile_1",
      status: "active",
    });
    expect(bridge.activeTurn()).toBe("turn_reconcile_1");
    expect(bridge.queueDepth()).toBe(1);

    // Production failure shape: the exact owned turn is terminal, its
    // turn/completed frame is lost, and a successor starts immediately so the
    // aggregate thread never becomes idle. The successor notification forces
    // one exact-history reconciliation.
    firstTurnIsPersistedComplete = true;
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD, turn: { id: "human-successor" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(replies).toEqual([{ taskId: "t-reconcile-1", text: "recovered-answer-1" }]);
    expect(bridge.queueDepth()).toBe(1);
    expect(bridge.activeTurn()).toBeNull();
    expect(app.received.filter((entry) => (entry as { method?: string }).method === "turn/start")).toHaveLength(1);

    // Recovery must not start queued task 2 while the successor is active.
    // Its terminal event is the next legitimate FIFO drain edge.
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "human-successor", status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bridge.queueDepth()).toBe(0);
    expect(bridge.activeTurn()).toBe("turn_reconcile_2");
    expect(app.received.filter((entry) => (entry as { method?: string }).method === "turn/start")).toHaveLength(2);

    await client.close();
    await app.stop();
  });

  test("thread/read uses clientUserMessageId to recover a replacement turn when all live item events were lost", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") {
          return respond({ result: {} });
        }
        if (msg.method === "turn/start") {
          return respond({ result: { turn: { id: "turn_history_phantom" } } });
        }
        if (msg.method === "thread/read" && !(msg.params as { includeTurns?: boolean })?.includeTurns) {
          return respond({ result: { thread: { status: { type: "active" } } } });
        }
        if (msg.method === "thread/read") {
          return respond({
            result: {
              thread: {
                status: { type: "active" },
                turns: [{
                  id: "turn_history_actual",
                  status: "completed",
                  items: [
                    { type: "userMessage", clientId: "anet:history-race" },
                    { type: "agentMessage", phase: "final_answer", text: "history rebound reply" },
                  ],
                }],
              },
            },
          });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (event) => replies.push(event as never));

    await bridge.submitTask({ taskId: "history-race", text: "first" });
    expect(await bridge.reconcileActiveTurn(true)).toEqual({
      recovered: true,
      turnId: "turn_history_actual",
      status: "completed",
    });
    expect(replies).toEqual([{ taskId: "history-race", text: "history rebound reply" }]);
    expect(bridge.activeTurn()).toBeNull();
    expect(bridge.pendingTurnCount()).toBe(0);
    await client.close();
    await app.stop();
  });

  test("slow full-history fallback recovers when both terminal and successor notifications are lost", async () => {
    let persistedComplete = false;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") return respond({ result: { turn: { id: "turn_double_loss" } } });
        if (msg.method === "thread/read") {
          const includeTurns = (msg.params as { includeTurns?: boolean } | undefined)?.includeTurns;
          return respond({ result: { thread: {
            status: { type: "active" },
            turns: includeTurns && persistedComplete ? [{
              id: "turn_double_loss",
              status: "completed",
              items: [{ type: "agentMessage", phase: "final_answer", text: "fallback-answer" }],
            }] : undefined,
          } } });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({
      client,
      threadId: THREAD,
      // Test seam: make the production 60s slow fallback due immediately.
      fullHistoryReconciliationIntervalMs: 0,
    });
    await bridge.bootstrap();
    const replies: Array<{ taskId: string; text: string }> = [];
    bridge.on("task_reply", (reply) => replies.push(reply as never));
    await bridge.submitTask({ taskId: "t-double-loss", text: "recover without frames" });

    persistedComplete = true;
    expect(await bridge.reconcileActiveTurn()).toEqual({
      recovered: true,
      turnId: "turn_double_loss",
      status: "completed",
    });
    expect(replies).toEqual([{ taskId: "t-double-loss", text: "fallback-answer" }]);
    expect(app.received.filter((entry) => (entry as { method?: string }).method === "thread/read")).toHaveLength(2);
    await client.close();
    await app.stop();
  });

  test("full history never attributes a different completed turn to the owned task", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize" || msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") return respond({ result: { turn: { id: "turn_exact_owner" } } });
        if (msg.method === "thread/read") {
          const includeTurns = (msg.params as { includeTurns?: boolean } | undefined)?.includeTurns;
          return respond({ result: { thread: {
            status: { type: "active" },
            turns: includeTurns ? [{
              id: "different_completed_turn",
              status: "completed",
              items: [{ type: "agentMessage", phase: "final_answer", text: "must-not-leak" }],
            }] : undefined,
          } } });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({
      client,
      threadId: THREAD,
      fullHistoryReconciliationIntervalMs: 0,
    });
    await bridge.bootstrap();
    const replies: unknown[] = [];
    bridge.on("task_reply", (reply) => replies.push(reply));
    await bridge.submitTask({ taskId: "t-exact-owner", text: "do not steal another turn" });

    expect(await bridge.reconcileActiveTurn()).toEqual({
      recovered: false,
      turnId: "turn_exact_owner",
      status: "active",
    });
    expect(replies).toHaveLength(0);
    expect(bridge.activeTurn()).toBe("turn_exact_owner");
    await client.close();
    await app.stop();
  });

  test("thread/read never recovers an interrupted turn as success", async () => {
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          return respond({ result: { turn: { id: "turn_reconcile_interrupted" } } });
        }
        if (msg.method === "thread/read") {
          const includeTurns = (msg.params as { includeTurns?: boolean } | undefined)?.includeTurns;
          return respond({
            result: {
              thread: {
                id: THREAD,
                status: { type: "idle" },
                turns: includeTurns ? [{
                  id: "turn_reconcile_interrupted",
                  status: "interrupted",
                  items: [{ type: "agentMessage", phase: "final_answer", text: "partial text" }],
                }] : undefined,
              },
            },
          });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    const replies: unknown[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    bridge.on("task_reply", (reply) => replies.push(reply));
    bridge.on("task_error", (error) => errors.push(error as never));

    await bridge.submitTask({ taskId: "t-reconcile-interrupted", text: "first" });
    expect(await bridge.reconcileActiveTurn()).toEqual({
      recovered: true,
      turnId: "turn_reconcile_interrupted",
      status: "interrupted",
    });
    expect(replies).toHaveLength(0);
    expect(errors).toEqual([{
      taskId: "t-reconcile-interrupted",
      error: "Codex turn was interrupted without an error message",
    }]);

    await client.close();
    await app.stop();
  });

  test("drain losing the idle race requeues at the FRONT and retries on next idle", async () => {
    let denials = 0;
    let seq = 0;
    let denyNext = false;
    const app = await startFakeApp({
      onRequest: (msg, respond) => {
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return respond({ result: {} });
        if (msg.method === "turn/start") {
          if (denyNext) {
            denyNext = false;
            denials++;
            return respond({ error: { code: -32009, message: "turn already active" } });
          }
          seq++;
          respond({ result: { turn: { id: `turn_d_${seq}` } } });
        }
      },
    });
    const client = new CodexAppServerClient({ url: app.url });
    await client.connect();
    const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
    await bridge.bootstrap();
    const deferred: string[] = [];
    bridge.on("drain_deferred", (d) => deferred.push((d as { taskId: string }).taskId));

    await bridge.submitTask({ taskId: "t-d-1", text: "first" });
    await bridge.submitTask({ taskId: "t-d-2", text: "second" }); // queued
    // Human TUI "wins" the next idle: server denies our drain's turn/start.
    denyNext = true;
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "turn_d_1", item: { type: "agentMessage", phase: "final_answer", text: "a1" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_d_1" } },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(denials).toBe(1);
    expect(deferred).toEqual(["t-d-2"]); // requeued, not lost
    expect(bridge.queueDepth()).toBe(1);

    // Simulate the human's turn finishing: we only observe idle again via our
    // own accounting when OUR turn completes — Phase 0 drains retry on the
    // next completion event we own. Trigger with a fresh submit+complete.
    const r3 = await bridge.submitTask({ taskId: "t-d-3", text: "third" });
    expect(r3.started).toBe(false); // goes behind t-d-2 in FIFO? No — unshift kept t-d-2 first
    expect(bridge.queueDepth()).toBe(2);
    // Free the thread: drain starts t-d-2 FIRST (order preserved).
    app.broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: "turn_d_999_unknown", item: { type: "agentMessage", phase: "final_answer", text: "human turn done" } } });
    app.broadcast({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "turn_d_999_unknown" } },
    });
    // Human turn completed → thread idle → drain starts t-d-2 FIRST (order kept).
    await new Promise((r) => setTimeout(r, 80));
    expect(bridge.queueDepth()).toBe(1); // t-d-3 still waiting
    expect(bridge.activeTurn()).toBe("turn_d_2");
    await client.close();
    await app.stop();
  });
});
