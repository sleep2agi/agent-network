// RFC-030 Wave 1B L3-R6 — gateway assembly integration: A's frozen
// orchestration (lifecycle/uds-server/human-owner @ 00d4ea8) composed
// with B's scheduler/ledger/adapter/authorizer/transport over ONE
// upstream socket and THE one UpstreamRequestMux.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "os";
import { join } from "path";
import { assembleCodexGateway, type CodexGatewayHandle } from "./gateway-assembly";
import { asMessageId, asTaskId, type AuthenticatedSender } from "./contract";
import {
  TUI_BEARER_ENV_NAME,
  type LaunchRequest,
  type TuiChildLauncher,
} from "./tui-child-launcher";

const SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_asm_001",
  role: "member",
  networkId: "net_default",
};

// Minimal fake codex app-server: initialize / thread ops / turn/start
// (responds + broadcasts turn/started, then turn/completed after a delay).
async function startFakeApp(
  turnDurationMs = 15,
  initializeError?: string,
  resumeError?: string,
) {
  const connections = new Set<{ send: (s: string) => void }>();
  let turnSeq = 0;
  const requests: Array<{ method: string; id: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("", { status: 400 });
    },
    websocket: {
      open(ws) {
        const h = { send: (s: string) => ws.send(s) };
        connections.add(h);
        (ws as unknown as { data: { h: typeof h } }).data = { h };
      },
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as {
          id?: number;
          method?: string;
          params?: { clientUserMessageId?: string };
        };
        if (msg.method) requests.push({ method: msg.method, id: msg.id });
        if (msg.id === undefined) return; // notification
        const respond = (body: object) =>
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
        const broadcast = (obj: object) => {
          const s = JSON.stringify(obj);
          for (const c of connections) c.send(s);
        };
        switch (msg.method) {
          case "initialize":
            if (initializeError !== undefined) {
              respond({ error: { code: -32_000, message: initializeError } });
            } else {
              respond({ result: { serverInfo: { name: "codex-fake", version: "0.144.0" } } });
            }
            return;
          case "thread/start":
            respond({ result: { thread: { id: "th_asm_1" } } });
            return;
          case "thread/resume":
            if (resumeError !== undefined) {
              respond({ error: { code: -32_000, message: resumeError } });
            } else {
              respond({ result: { ok: true } });
            }
            return;
          case "turn/start": {
            const turnId = `turn_${++turnSeq}`;
            const cumid = msg.params?.clientUserMessageId ?? "";
            respond({ result: { turn: { id: turnId } } });
            broadcast({
              jsonrpc: "2.0",
              method: "turn/started",
              params: {
                threadId: "th_asm_1",
                turn: { id: turnId, status: "inProgress", error: null },
              },
            });
            broadcast({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "th_asm_1",
                turn: { id: turnId },
                delta: `delta:${cumid}`,
              },
            });
            setTimeout(() => {
              broadcast({
                jsonrpc: "2.0",
                method: "item/completed",
                params: {
                  threadId: "th_asm_1",
                  turn: { id: turnId },
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: `echo:${cumid}`,
                  },
                },
              });
              broadcast({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: {
                  threadId: "th_asm_1",
                  turn: { id: turnId, status: "completed", error: null },
                },
              });
            }, turnDurationMs);
            return;
          }
          default:
            respond({ error: { code: -32601, message: `unknown ${msg.method}` } });
        }
      },
      close(ws) {
        const h = (ws as unknown as { data?: { h?: { send: (s: string) => void } } }).data?.h;
        if (h) connections.delete(h);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function tmpPaths() {
  const socketDir = join(mkdtempSync(join(tmpdir(), "rfc030-asm-")), "gw");
  return {
    socketDir,
    backendSocketPath: join(socketDir, "backend.sock"),
  };
}

class DeferredOwnerLauncher implements TuiChildLauncher {
  private socket: Socket | null = null;
  private request: LaunchRequest | null = null;

  async launch(req: LaunchRequest): Promise<{ spawned: true }> {
    this.request = req;
    return { spawned: true };
  }

  async attach(): Promise<void> {
    const req = this.request;
    if (req === null) throw new Error("launcher has no launch request");
    const url = new URL(req.wsUrl);
    const bearer = req.env[TUI_BEARER_ENV_NAME];
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    socket.write([
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${url.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Authorization: Bearer ${bearer}`,
      "",
      "",
    ].join("\r\n"));
  }

  async detach(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket === null || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.destroy();
    });
  }

  async terminate(): Promise<void> {
    await this.detach();
  }
}

const waitFor = (cond: () => boolean, timeoutMs = 10_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(t);
        reject(new Error("waitFor timeout"));
      }
    }, 10);
  });

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      /* best effort */
    }
  }
});

describe("L3-R6 gateway assembly — one socket, one mux, A orchestration + B policy", () => {
  test("full path: assemble → owner gate → enqueue → turn via A-mux → completion via transport notifications → ledger", async () => {
    const app = await startFakeApp();
    const paths = tmpPaths();
    const launcher = new DeferredOwnerLauncher();
    let handle: CodexGatewayHandle | null = null;
    cleanups.push(async () => {
      await handle?.stop();
      app.stop();
      rmSync(join(paths.socketDir, ".."), { recursive: true, force: true });
    });

    handle = await assembleCodexGateway({
      ...paths,
      sqlitePath: ":memory:",
      spawnFactory: async () => ({ url: app.url, shutdown: () => {} }),
      tuiLauncher: launcher,
    });

    // Final A orchestration is live: one backend UDS + strict loopback TUI
    // WS, with the thread bootstrapped over the SINGLE mux.
    expect(handle.lifecycle.currentState()).toBe("running");
    expect(existsSync(paths.backendSocketPath)).toBe(true);
    expect(handle.lifecycle.tuiWsPortActual()).toBeGreaterThan(0);
    expect(handle.threadId).toBe("th_asm_1");
    // bootstrap requests actually flowed upstream:
    expect(app.requests.map((r) => r.method)).toContain("initialize");
    expect(app.requests.map((r) => r.method)).toContain("thread/start");

    // OWNER GATE (fail closed): no TUI attached → refused_no_owner.
    const refused = await handle.scheduler.enqueueTask({
      taskId: asTaskId("asm_t0"),
      messageId: asMessageId("asm_m0"),
      authenticatedSender: SENDER,
      text: "before owner",
    });
    expect(refused.outcome).toBe("refused_no_owner");

    // The test launcher now attaches through final A's real WS admission.
    await launcher.attach();
    await waitFor(() => handle!.lifecycle.humanOwnerAttached());
    expect(handle.lifecycle.humanOwnerAttached()).toBe(true);

    const accepted = await handle.scheduler.enqueueTask({
      taskId: asTaskId("asm_t1"),
      messageId: asMessageId("asm_m1"),
      authenticatedSender: SENDER,
      text: "real work",
    });
    expect(accepted.outcome).toBe("accepted");

    // Turn dispatches through lifecycle.sendInternal (A's mux id), the
    // completion arrives as a transport NOTIFICATION (A drops it,
    // B's fan-out catches it) and the ledger closes the loop.
    await waitFor(() => {
      const st = handle!.ledger.getLatestByTaskId("asm_t1")?.state;
      return st === "reply_pending" || st === "completed";
    });
    expect(handle.ledger.getLatestByTaskId("asm_t1")!.replyText).toBe("echo:anet:asm_m1");
    const delivered = await handle.drainReplies(async (outcome) => {
      expect(outcome).toEqual({
        deliveryId: "asm_m1",
        submissionId: "asm_m1",
        canonicalTaskId: "asm_t1",
        status: "replied",
        code: "completed",
        text: "echo:anet:asm_m1",
      });
      return { kind: "applied" };
    });
    expect(delivered.delivered).toEqual(["asm_m1"]);
    expect(handle.ledger.getLatestByTaskId("asm_t1")!.state).toBe("replied");

    // Corrupt/unknown persisted outcome metadata is quarantined before H1.
    handle.ledger.record({
      submissionId: "asm-corrupt",
      origin: "agent",
      taskId: "asm-corrupt-task",
    });
    handle.ledger.transition("asm-corrupt", "failed", {
      error: "stable local failure",
      outbound: {
        status: "failed",
        code: "turn_failed",
        text: "Gateway could not complete this task.",
      },
    });
    const rawDriver = (handle.ledger as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
    }).db;
    rawDriver.prepare(
      "UPDATE gateway_ledger SET delivery_code = 'corrupt_untrusted_code' WHERE submission_id = ?",
    ).run("asm-corrupt");
    const corruptDrain = await handle.drainReplies(async () => {
      throw new Error("corrupt outbox row must not reach H1");
    });
    expect(corruptDrain.invalid).toEqual(["asm-corrupt"]);
    expect(handle.ledger.get("asm-corrupt")!.outboundDelivery).toBe("quarantined");
    // turn/start rode the single mux: the fake app saw it as a plain id
    // (allocated by A's mux — no duplicate id namespaces on the socket).
    expect(app.requests.some((r) => r.method === "turn/start")).toBe(true);
    // All internal pendings consumed — nothing dangling on the one mux.
    await waitFor(() => handle!.lifecycle.pendingUpstreamCount() === 0);

    // Owner detaches mid-idle → next enqueue refused again (fail closed,
    // live truth — not a boot-time snapshot).
    await launcher.detach();
    await waitFor(() => !handle!.lifecycle.humanOwnerAttached());
    const refused2 = await handle.scheduler.enqueueTask({
      taskId: asTaskId("asm_t2"),
      messageId: asMessageId("asm_m2"),
      authenticatedSender: SENDER,
      text: "after detach",
    });
    expect(refused2.outcome).toBe("refused_no_owner");

    // stop(): socket cleaned. A stopped scheduler refuses before it can
    // inspect any stale owner snapshot.
    await handle.stop();
    const stopped = await handle.scheduler.enqueueTask({
      taskId: asTaskId("asm_t3"),
      messageId: asMessageId("asm_m3"),
      authenticatedSender: SENDER,
      text: "after stop",
    });
    expect(stopped.outcome).toBe("refused_shutting_down");
    expect(existsSync(paths.backendSocketPath)).toBe(false);
    expect(handle.lifecycle.currentState()).toBe("stopped");
    handle = null;
    app.stop();
  }, 30_000);

  test("sqlite gate fails closed BEFORE any spawn/socket", async () => {
    const paths = tmpPaths();
    let spawned = 0;
    // Force the unsupported-runtime path via an obviously invalid driver
    // request: a directory path can't be opened as a database file.
    await expect(
      assembleCodexGateway({
        ...paths,
        sqlitePath: join(tmpdir(), "definitely", "missing", "dir", "x.db"),
        spawnFactory: async () => {
          spawned++;
          return { url: "ws://127.0.0.1:1", shutdown: () => {} };
        },
      }),
    ).rejects.toThrow();
    expect(spawned).toBe(0); // gate fired before the spawn
    expect(existsSync(paths.backendSocketPath)).toBe(false);
  });

  test("R2: bootstrap upstream error.message is redacted before the assembly boundary", async () => {
    const sentinel = "R2_BOOTSTRAP_SECRET_MUST_NOT_ESCAPE";
    const app = await startFakeApp(15, sentinel);
    const paths = tmpPaths();
    const logs: string[] = [];
    let caught: unknown;
    try {
      await assembleCodexGateway({
        ...paths,
        sqlitePath: ":memory:",
        spawnFactory: async () => ({ url: app.url, shutdown: () => {} }),
        tuiLauncher: false,
        log: (line) => logs.push(line),
      });
    } catch (error) {
      caught = error;
    } finally {
      app.stop();
      rmSync(join(paths.socketDir, ".."), { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(Error);
    const visible = JSON.stringify({
      message: (caught as Error).message,
      stack: (caught as Error).stack,
      logs,
    });
    expect(visible).not.toContain(sentinel);
    expect((caught as Error & { code?: string }).code).toBe("ERR_UPSTREAM_REQUEST_FAILED");
    expect((caught as Error).message).toBe("gateway upstream request failed");
    expect(existsSync(paths.backendSocketPath)).toBe(false);
  });

  test("persisted thread resume failure is fail-closed and never creates/rebinds a fresh thread", async () => {
    const sentinel = "R2_RESUME_DETAIL_MUST_NOT_ESCAPE";
    const app = await startFakeApp(15, undefined, sentinel);
    const paths = tmpPaths();
    const logs: string[] = [];
    const rebound: string[] = [];
    let caught: unknown;
    try {
      await assembleCodexGateway({
        ...paths,
        sqlitePath: ":memory:",
        threadId: "persisted-thread",
        spawnFactory: async () => ({ url: app.url, shutdown: () => {} }),
        tuiLauncher: false,
        onThread: (id) => rebound.push(id),
        log: (line) => logs.push(line),
      });
    } catch (error) {
      caught = error;
    } finally {
      app.stop();
      rmSync(join(paths.socketDir, ".."), { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("gateway upstream request failed");
    expect(JSON.stringify({ caught, logs })).not.toContain(sentinel);
    expect(rebound).toEqual([]);
    expect(app.requests.some((request) => request.method === "thread/start")).toBe(false);
  });
});
