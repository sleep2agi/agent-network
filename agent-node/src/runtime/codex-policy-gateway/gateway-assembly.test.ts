// RFC-030 Wave 1B L3-R6 — gateway assembly integration: A's frozen
// orchestration (lifecycle/uds-server/human-owner @ 00d4ea8) composed
// with B's scheduler/ledger/adapter/authorizer/transport over ONE
// upstream socket and THE one UpstreamRequestMux.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assembleCodexGateway, type CodexGatewayHandle } from "./gateway-assembly";
import { asMessageId, asTaskId, type AuthenticatedSender } from "./contract";

const SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_asm_001",
  role: "member",
  networkId: "net_default",
};

// Minimal fake codex app-server: initialize / thread ops / turn/start
// (responds + broadcasts turn/started, then turn/completed after a delay).
async function startFakeApp(turnDurationMs = 15) {
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
            respond({ result: { serverInfo: { name: "codex-fake", version: "0.144.0" } } });
            return;
          case "thread/start":
            respond({ result: { threadId: "th_asm_1" } });
            return;
          case "thread/resume":
            respond({ result: { ok: true } });
            return;
          case "turn/start": {
            const turnId = `turn_${++turnSeq}`;
            const cumid = msg.params?.clientUserMessageId ?? "";
            respond({ result: { turnId } });
            broadcast({
              jsonrpc: "2.0",
              method: "turn/started",
              params: { threadId: "th_asm_1", turnId, clientUserMessageId: cumid },
            });
            setTimeout(() => {
              broadcast({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: { threadId: "th_asm_1", turnId, finalText: `echo:${cumid}` },
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
    tuiSocketPath: join(socketDir, "tui.sock"),
  };
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
    });

    // A's orchestration is live: state running, UDS sockets on disk,
    // thread bootstrapped over the SINGLE mux.
    expect(handle.lifecycle.currentState()).toBe("running");
    expect(existsSync(paths.backendSocketPath)).toBe(true);
    expect(existsSync(paths.tuiSocketPath)).toBe(true);
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

    // Owner attaches (A's coordinator is the single truth).
    handle.lifecycle.humanOwnerCoordinator()!.attachTui();

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
    // turn/start rode the single mux: the fake app saw it as a plain id
    // (allocated by A's mux — no duplicate id namespaces on the socket).
    expect(app.requests.some((r) => r.method === "turn/start")).toBe(true);
    // All internal pendings consumed — nothing dangling on the one mux.
    await waitFor(() => handle!.lifecycle.pendingUpstreamCount() === 0);

    // Owner detaches mid-idle → next enqueue refused again (fail closed,
    // live truth — not a boot-time snapshot).
    handle.lifecycle.humanOwnerCoordinator()!.detachTui();
    const refused2 = await handle.scheduler.enqueueTask({
      taskId: asTaskId("asm_t2"),
      messageId: asMessageId("asm_m2"),
      authenticatedSender: SENDER,
      text: "after detach",
    });
    expect(refused2.outcome).toBe("refused_no_owner");

    // stop(): sockets cleaned from disk.
    await handle.stop();
    expect(existsSync(paths.backendSocketPath)).toBe(false);
    expect(existsSync(paths.tuiSocketPath)).toBe(false);
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
});
