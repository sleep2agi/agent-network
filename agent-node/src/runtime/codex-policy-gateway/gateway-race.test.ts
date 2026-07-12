// RFC-030 Wave 1B — CHECKPOINT integration suite against a fake app-server.
//
// Hard evidence required by 副指挥 before Wave 2:
//   1. 100 simultaneous idle submissions → all one-to-one (every task gets
//      its own turn; every reply maps back to exactly its own task).
//   2. Request-id collision + out-of-order responses → no cross-wiring.
//   3. Agent approval-response forgery → all rejected.
//   plus: missing-principal fail-closed (no bypass), FIFO under load.
//
// The fake app-server is a real WS server (Bun.serve) speaking the same
// JSON-RPC framing as codex app-server 0.144.0, with configurable
// misbehaviour (delays, duplicate responses, reverse requests).

import { describe, expect, test } from "bun:test";
import { CodexAppServerClient } from "../codex-app-server-client";
import { BridgeAdapter, senderFromInboxRow } from "./bridge-adapter";
import { GatewayScheduler } from "./scheduler";
import { GatewayLedger } from "./ledger";
import { resolveSqliteDriver } from "./sqlite-driver";
import { asTaskId, asMessageId, type AuthenticatedSender } from "./contract";

const THREAD = "11111111-2222-3333-4444-555555555555";

const FIXTURE_SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_fixture_001",
  role: "member",
  networkId: "net_default",
};

// ────────────────────────────────────────────────────────────────────────
// Fake codex app-server
// ────────────────────────────────────────────────────────────────────────

interface FakeAppOptions {
  /** Artificial per-request response delay chooser (ms). */
  delayFor?: (method: string, id: number) => number;
  /** When true, every turn/start response is also sent a SECOND time with
   *  the same id (duplicate/collision injection). */
  duplicateResponses?: boolean;
  /** Turn execution time (ms) before turn/completed fires. */
  turnDurationMs?: number;
}

interface FakeApp {
  url: string;
  sent: object[];
  received: object[];
  turnLog: Array<{ turnId: string; cumid: string }>;
  broadcast: (obj: object) => void;
  reverseRequestResponses: object[];
  stop: () => Promise<void>;
}

async function startFakeApp(opts: FakeAppOptions = {}): Promise<FakeApp> {
  const received: object[] = [];
  const sent: object[] = [];
  const turnLog: Array<{ turnId: string; cumid: string }> = [];
  const reverseRequestResponses: object[] = [];
  const connections = new Set<{ send: (s: string) => void }>();
  let turnSeq = 0;
  let activeTurn: string | null = null;
  const turnDurationMs = opts.turnDurationMs ?? 8;

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
        (ws as unknown as { data: { handle: typeof handle } }).data = { handle };
      },
      message(ws, raw) {
        const line = typeof raw === "string" ? raw : String(raw);
        const msg = JSON.parse(line);
        received.push(msg);
        const handle = (ws as unknown as { data: { handle: { send: (s: string) => void } } }).data
          .handle;
        const sendObj = (obj: object) => {
          sent.push(obj);
          handle.send(JSON.stringify(obj));
        };
        const broadcastObj = (obj: object) => {
          sent.push(obj);
          const s = JSON.stringify(obj);
          for (const c of connections) c.send(s);
        };

        // A response TO one of our reverse requests? (forgery detection)
        if (typeof msg.id === "number" && !msg.method && ("result" in msg || "error" in msg)) {
          // Not matching any request we sent → it's a client answering a
          // server request. Track it.
          reverseRequestResponses.push(msg);
          return;
        }

        if (typeof msg.method !== "string") return;
        if (msg.id === undefined || msg.id === null) return; // notification

        const respond = (payload: object) => {
          const delay = opts.delayFor?.(msg.method, msg.id) ?? 0;
          const envelope = { jsonrpc: "2.0", id: msg.id, ...payload };
          if (delay > 0) setTimeout(() => sendObj(envelope), delay);
          else sendObj(envelope);
          if (opts.duplicateResponses && msg.method === "turn/start") {
            setTimeout(() => sendObj(envelope), delay + 2);
          }
        };

        switch (msg.method) {
          case "initialize":
            respond({ result: { serverInfo: { name: "fake-codex-0.144.0" } } });
            return;
          case "thread/resume":
          case "thread/start":
            respond({ result: { threadId: THREAD } });
            return;
          case "turn/start": {
            if (activeTurn) {
              respond({ error: { code: -32010, message: "thread busy" } });
              return;
            }
            const turnId = `turn_${++turnSeq}`;
            const cumid = msg.params?.clientUserMessageId ?? "";
            activeTurn = turnId;
            turnLog.push({ turnId, cumid });
            respond({ result: { turnId } });
            // Emit lifecycle: started → delta → completed.
            setTimeout(() => {
              broadcastObj({
                jsonrpc: "2.0",
                method: "turn/started",
                params: { threadId: THREAD, turnId, clientUserMessageId: cumid },
              });
              broadcastObj({
                jsonrpc: "2.0",
                method: "item/agentMessage/delta",
                params: { threadId: THREAD, turnId, delta: { text: `echo:${cumid}` } },
              });
              setTimeout(() => {
                activeTurn = null;
                broadcastObj({
                  jsonrpc: "2.0",
                  method: "turn/completed",
                  params: { threadId: THREAD, turnId, finalText: `echo:${cumid}` },
                });
              }, turnDurationMs);
            }, 1);
            return;
          }
          default:
            respond({ error: { code: -32601, message: `unknown method ${msg.method}` } });
        }
      },
      close(ws) {
        const handle = (ws as unknown as { data?: { handle?: { send: (s: string) => void } } })
          .data?.handle;
        if (handle) connections.delete(handle);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    sent,
    received,
    turnLog,
    reverseRequestResponses,
    broadcast: (obj: object) => {
      const s = JSON.stringify(obj);
      for (const c of connections) c.send(s);
    },
    stop: async () => server.stop(true),
  };
}

async function buildGateway(app: FakeApp, queueLimit = 256) {
  const client = new CodexAppServerClient({ url: app.url });
  await client.connect();
  await client.request("initialize", { clientInfo: { name: "gateway-test" } });
  client.notify("initialized", {});
  await client.request("thread/resume", { threadId: THREAD });

  const adapter = new BridgeAdapter({ client, threadId: THREAD, dispatchTimeoutMs: 5_000 });
  const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
  const scheduler = new GatewayScheduler({ ledger, dispatcher: adapter, queueLimit });
  adapter.bindScheduler(scheduler);
  return { client, adapter, ledger, scheduler };
}

function waitFor(cond: () => boolean, timeoutMs = 15_000, everyMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, everyMs);
  });
}

// ────────────────────────────────────────────────────────────────────────
// CHECKPOINT 1 — 100 simultaneous idle submissions, all one-to-one
// ────────────────────────────────────────────────────────────────────────

describe("CHECKPOINT — 100-way idle race", () => {
  test("100 concurrent enqueues: each task gets its own turn and its own reply", async () => {
    const app = await startFakeApp({ turnDurationMs: 1 });
    const { client, ledger, scheduler } = await buildGateway(app);

    // All 100 fired on the same tick — maximal race pressure on the
    // reservation critical section.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        scheduler.enqueueTask({
          taskId: asTaskId(`task_${i}`),
          messageId: asMessageId(`msg_${i}`),
          authenticatedSender: FIXTURE_SENDER,
          text: `payload ${i}`,
        }),
      ),
    );
    expect(results.every((r) => r.outcome === "accepted")).toBe(true);

    // Drain: every submission reaches reply_pending (completed + queued for delivery).
    await waitFor(() => ledger.inState("reply_pending").length === 100, 30_000);

    // One-to-one: 100 distinct turns, each cumid seen exactly once.
    expect(app.turnLog).toHaveLength(100);
    const cumids = app.turnLog.map((t) => t.cumid);
    expect(new Set(cumids).size).toBe(100);

    // Each task's reply is ITS OWN echo — no cross-wiring anywhere.
    for (let i = 0; i < 100; i++) {
      const row = ledger.get(`task_${i}`)!;
      expect(row.state).toBe("reply_pending");
      expect(row.replyText).toBe(`echo:anet:msg_${i}`);
      expect(row.turnId).not.toBeNull();
    }
    // 100 distinct turnIds on the ledger side too.
    const turnIds = Array.from({ length: 100 }, (_, i) => ledger.get(`task_${i}`)!.turnId);
    expect(new Set(turnIds).size).toBe(100);

    // The fake server never saw a concurrent turn/start (no busy errors →
    // reservation held): every turn/start got a turnId, count matches.
    const busyErrors = app.sent.filter(
      (m) => (m as { error?: { code?: number } }).error?.code === -32010,
    );
    expect(busyErrors).toHaveLength(0);

    await client.close();
    await app.stop();
  }, 60_000);

  test("idempotency under the same race: duplicate messageIds do not double-enqueue", async () => {
    const app = await startFakeApp({ turnDurationMs: 1 });
    const { client, ledger, scheduler } = await buildGateway(app);

    // 50 unique messages, each submitted twice concurrently.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        scheduler.enqueueTask({
          taskId: asTaskId(`task_${i % 50}`),
          messageId: asMessageId(`msg_${i % 50}`),
          authenticatedSender: FIXTURE_SENDER,
          text: `payload ${i % 50}`,
        }),
      ),
    );
    const accepted = results.filter((r) => r.outcome === "accepted");
    expect(accepted).toHaveLength(100);
    const dupes = accepted.filter((r) => r.outcome === "accepted" && r.duplicate);
    expect(dupes.length).toBe(50);

    await waitFor(() => ledger.inState("reply_pending").length === 50, 30_000);
    expect(app.turnLog).toHaveLength(50); // one turn per unique message

    await client.close();
    await app.stop();
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────
// CHECKPOINT 2 — request-id collision + out-of-order, no cross-wiring
// ────────────────────────────────────────────────────────────────────────

describe("CHECKPOINT — request-id collision / out-of-order", () => {
  test("out-of-order responses resolve to their own requests (no swap)", async () => {
    // Delay policy: odd request ids answer slower than even ones →
    // responses systematically arrive out of order.
    const app = await startFakeApp({
      turnDurationMs: 1,
      delayFor: (method, id) => (method === "turn/start" && id % 2 === 1 ? 25 : 0),
    });
    const { client, ledger, scheduler } = await buildGateway(app);

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        scheduler.enqueueTask({
          taskId: asTaskId(`task_${i}`),
          messageId: asMessageId(`msg_${i}`),
          authenticatedSender: FIXTURE_SENDER,
          text: `p${i}`,
        }),
      ),
    );
    await waitFor(() => ledger.inState("reply_pending").length === 30, 30_000);
    for (let i = 0; i < 30; i++) {
      expect(ledger.get(`task_${i}`)!.replyText).toBe(`echo:anet:msg_${i}`);
    }
    await client.close();
    await app.stop();
  }, 60_000);

  test("duplicate (collision) responses on the same id do not corrupt later requests", async () => {
    const app = await startFakeApp({ turnDurationMs: 1, duplicateResponses: true });
    const { client, ledger, scheduler } = await buildGateway(app);

    const orphanEvents: unknown[] = [];
    client.on("orphan_response", (m) => orphanEvents.push(m));

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        scheduler.enqueueTask({
          taskId: asTaskId(`task_${i}`),
          messageId: asMessageId(`msg_${i}`),
          authenticatedSender: FIXTURE_SENDER,
          text: `p${i}`,
        }),
      ),
    );
    await waitFor(() => ledger.inState("reply_pending").length === 20, 30_000);

    // Every duplicate response surfaced as orphan (pending entry already
    // consumed) — never resolved a different request.
    expect(orphanEvents.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(ledger.get(`task_${i}`)!.replyText).toBe(`echo:anet:msg_${i}`);
    }
    await client.close();
    await app.stop();
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────
// CHECKPOINT 3 — Agent approval-response forgery all rejected
// ────────────────────────────────────────────────────────────────────────

describe("CHECKPOINT — approval forgery rejection", () => {
  test("policy denies every approval/user-input response surface", async () => {
    const { evaluateUpstreamCall } = await import("./policy");
    const forgeryAttempts = [
      "serverRequest/respond",
      "item/tool/requestApproval",
      "item/tool/requestApproval/respond",
      "item/tool/requestUserInput",
      "execCommandApproval",
      "applyPatchApproval",
      "permissionsRequestApproval",
    ];
    for (const method of forgeryAttempts) {
      const d = evaluateUpstreamCall(method, { threadId: THREAD }, THREAD);
      expect(d.allowed).toBe(false);
    }
  });

  test("reverse request under approval=never: adapter answers NOTHING (wire-level proof)", async () => {
    const app = await startFakeApp({ turnDurationMs: 30 });
    const { client, scheduler, adapter, ledger } = await buildGateway(app);

    const anomalies: unknown[] = [];
    adapter.on("reverse_request_anomaly", (rr) => anomalies.push(rr));

    await scheduler.enqueueTask({
      taskId: asTaskId("task_appr"),
      messageId: asMessageId("msg_appr"),
      authenticatedSender: FIXTURE_SENDER,
      text: "do a thing",
    });
    // While the turn is in flight, the server fires an approval reverse
    // request at every subscriber (multi-subscription broadcast).
    await waitFor(() => app.turnLog.length === 1, 10_000);
    app.broadcast({
      jsonrpc: "2.0",
      id: 90001,
      method: "execCommandApproval",
      params: { command: "rm -rf /", threadId: THREAD },
    });
    await waitFor(() => anomalies.length === 1, 5_000);

    // The forgery-detector on the fake server: NO client response ever
    // arrived for a server-initiated request id.
    await new Promise((r) => setTimeout(r, 50));
    expect(app.reverseRequestResponses).toHaveLength(0);

    // And the task still completes normally (approval=never means the
    // server wouldn't actually block on it — fake continues the turn).
    await waitFor(() => ledger.inState("reply_pending").length === 1, 10_000);

    await client.close();
    await app.stop();
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────
// Fail-closed sender principal (no bypass)
// ────────────────────────────────────────────────────────────────────────

describe("sender principal — fail closed, no bypass", () => {
  test("inbox row without server-stamped principal yields null (forged alias insufficient)", () => {
    // Forged alias, no stamp → refuse.
    expect(
      senderFromInboxRow({ id: "m1", from_session: "admin-会长", network_id: "net_default" }),
    ).toBeNull();
    // Stamp but bogus role → refuse.
    expect(
      senderFromInboxRow({
        id: "m2",
        from_session: "x",
        network_id: "net_default",
        sender_token_id: "tok_1",
        sender_role: "superadmin",
      }),
    ).toBeNull();
    // Missing network → refuse.
    expect(
      senderFromInboxRow({
        id: "m3",
        from_session: "x",
        sender_token_id: "tok_1",
        sender_role: "member",
      }),
    ).toBeNull();
    // Fully stamped → accepted, alias carried for display only.
    const ok = senderFromInboxRow({
      id: "m4",
      from_session: "reviewer",
      network_id: "net_default",
      sender_token_id: "tok_1",
      sender_role: "member",
    });
    expect(ok).not.toBeNull();
    expect(ok!.tokenId).toBe("tok_1");
  });

  test("no unverified-sender env bypass exists in the gateway source", async () => {
    // 协调 owner decision: the unverified-sender env bypass must never
    // ship. Fail this test if anyone adds it. (Literal is constructed by
    // concatenation everywhere in this file to avoid self-tripping.)
    const fs = await import("fs");
    const path = await import("path");
    const dir = import.meta.dir;
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".ts"));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // The literal is split here so THIS test file doesn't trip itself.
      expect(src.includes("ALLOW_UNVERIFIED_" + "SENDER")).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// FIFO ordering under contention
// ────────────────────────────────────────────────────────────────────────

describe("scheduler FIFO", () => {
  test("turns run strictly in enqueue order", async () => {
    const app = await startFakeApp({ turnDurationMs: 2 });
    const { client, ledger, scheduler } = await buildGateway(app);
    for (let i = 0; i < 10; i++) {
      await scheduler.enqueueTask({
        taskId: asTaskId(`task_${i}`),
        messageId: asMessageId(`msg_${i}`),
        authenticatedSender: FIXTURE_SENDER,
        text: `p${i}`,
      });
    }
    await waitFor(() => ledger.inState("reply_pending").length === 10, 15_000);
    const order = app.turnLog.map((t) => t.cumid);
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => `anet:msg_${i}`));
    await client.close();
    await app.stop();
  }, 30_000);
});
