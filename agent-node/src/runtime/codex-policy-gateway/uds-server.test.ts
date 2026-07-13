// RFC-030 Wave 1A P0.2 — backend-only UDS server tests.
//
// After the P0.2 split, `uds-server.ts` speaks ONLY the Agent-facing
// UDS. The TUI-facing WebSocket surface has moved to `tui-ws-server.ts`
// and its own test file. These tests exercise:
//   - path setup (0700 dir + 0600 socket + lstat) inherited from Segment A
//   - hard-1 backend cap (previously configurable maxConnectionsPerRole)
//   - hello handshake (existing P0 fix)
//   - Agent request round-trip via real UDS bytes
//   - sendInternal + rejection on upstream close / server.stop

import { describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import {
  BackendUdsServer,
  GATEWAY_HELLO_METHOD,
  MAX_BACKEND_CONNECTIONS,
  type BackendUdsServerOptions,
  type InternalOrigin,
  type UpstreamTransport,
} from "./uds-server";
import {
  UpstreamRequestMux,
  type InternalErrorEntry,
  type JsonRpcNotificationFrame,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type ProtocolBackend,
  type ProtocolDiagnostics,
} from "./protocol";
import { GatewayErrorCode } from "./contract";

const TEST_BACKEND_CAP = "test-backend-capability-32-chars";

class FakeUpstream implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closeCallCount = 0;
  async writeFrame(f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
    this.written.push(f);
  }
  onFrame(h: (raw: unknown) => void): () => void {
    this.frameHandlers.push(h);
    return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
  }
  onClose(h: () => void): () => void {
    this.closeHandlers.push(h);
    return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
  }
  async close(): Promise<void> {
    this.closeCallCount++;
    if (this.closeCallCount === 1) {
      for (const h of [...this.closeHandlers]) { try { h(); } catch { /* silent */ } }
    }
  }
  emitFrame(raw: unknown): void { for (const h of [...this.frameHandlers]) h(raw); }
  emitClose(): void { for (const h of [...this.closeHandlers]) h(); }
}

async function makeHarness(overrides?: {
  backendEnqueueImpl?: ProtocolBackend["enqueueTask"];
  helloTimeoutMs?: number;
}): Promise<{
  server: BackendUdsServer;
  socketDir: string;
  socketPath: string;
  mux: UpstreamRequestMux<InternalOrigin>;
  upstream: FakeUpstream;
  diagnostics: InternalErrorEntry[];
  cleanup(): Promise<void>;
}> {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rfc030-be-"));
  await fs.promises.rmdir(socketDir);
  const socketPath = path.join(socketDir, "backend.sock");
  const mux = new UpstreamRequestMux<InternalOrigin>();
  const upstream = new FakeUpstream();
  const diagnostics: InternalErrorEntry[] = [];
  let n = 0;
  const diag: ProtocolDiagnostics = {
    newCorrelationId: () => `cid-${++n}`,
    reportInternalError: (e) => { diagnostics.push(e); },
  };
  const backend: ProtocolBackend = {
    async enqueueTask(args) {
      if (overrides?.backendEnqueueImpl) return overrides.backendEnqueueImpl(args);
      return { outcome: "accepted", taskId: args.taskId, queuePosition: 0, duplicate: false };
    },
    async getTaskState() { return { state: "unknown" }; },
    async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
  };
  const opts: BackendUdsServerOptions = {
    socketPath, socketDir, mux, upstreamTransport: upstream,
    diagnostics: diag, backend,
    backendCapability: TEST_BACKEND_CAP,
    limits: { helloTimeoutMs: overrides?.helloTimeoutMs },
  };
  const server = new BackendUdsServer(opts);
  await server.start();
  return {
    server, socketDir, socketPath, mux, upstream, diagnostics,
    async cleanup() {
      try { await server.stop(); } catch {}
      try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

async function connectAndHello(socketPath: string): Promise<net.Socket> {
  const s = await new Promise<net.Socket>((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
  s.write(JSON.stringify({ jsonrpc: "2.0", method: GATEWAY_HELLO_METHOD, params: { capability: TEST_BACKEND_CAP } }) + "\n");
  await new Promise((r) => setTimeout(r, 15));
  return s;
}

function connectRaw(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function collectOneFrame(sock: net.Socket, timeoutMs = 500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(t);
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Path setup + shutdown
// ─────────────────────────────────────────────────────────────────────

describe("BackendUdsServer — path setup", () => {
  test("start creates dir 0700 and socket 0600", async () => {
    const h = await makeHarness();
    try {
      expect(fs.lstatSync(h.socketDir).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(h.socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(h.socketPath).mode & 0o777).toBe(0o600);
    } finally { await h.cleanup(); }
  });

  test("stop unlinks created paths only", async () => {
    const h = await makeHarness();
    await h.server.stop();
    expect(fs.existsSync(h.socketPath)).toBe(false);
    try { fs.rmSync(h.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hard-1 backend cap
// ─────────────────────────────────────────────────────────────────────

describe("BackendUdsServer — MAX_BACKEND_CONNECTIONS is a hard 1", () => {
  test("constant is 1 (no configurable escape hatch)", () => {
    expect(MAX_BACKEND_CONNECTIONS).toBe(1);
  });

  test("second connect refused; first stays intact", async () => {
    const h = await makeHarness();
    try {
      const a = await connectAndHello(h.socketPath);
      // Give the server a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(h.server.connectionCount()).toBe(1);
      const b = await connectRaw(h.socketPath);
      await new Promise((r) => setTimeout(r, 30));
      expect(h.server.connectionCount()).toBe(1);
      // The second socket got destroyed.
      expect(b.destroyed || b.readyState === "closed").toBe(true);
      a.destroy(); b.destroy();
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Capability handshake
// ─────────────────────────────────────────────────────────────────────

describe("BackendUdsServer — gateway.hello capability", () => {
  test("no hello within timeout → handshake_required + close", async () => {
    const h = await makeHarness({ helloTimeoutMs: 80 });
    try {
      const s = await connectRaw(h.socketPath);
      const frame = await collectOneFrame(s);
      expect((frame as { error: { data: { reason: string } } }).error.data.reason).toBe("handshake_required");
    } finally { await h.cleanup(); }
  });

  test("wrong capability → capability_invalid + close (no secret echoed)", async () => {
    const h = await makeHarness();
    try {
      const s = await connectRaw(h.socketPath);
      const bogus = "some-other-secret-of-suitable-length-abcd";
      s.write(JSON.stringify({ jsonrpc: "2.0", method: GATEWAY_HELLO_METHOD, params: { capability: bogus } }) + "\n");
      const frame = await collectOneFrame(s);
      const dump = JSON.stringify(frame);
      expect(dump).not.toContain(bogus);
      expect((frame as { error: { data: { reason: string } } }).error.data.reason).toBe("capability_invalid");
    } finally { await h.cleanup(); }
  });

  test("correct capability → JSON-RPC works, hello has no reply", async () => {
    const h = await makeHarness();
    try {
      const s = await connectAndHello(h.socketPath);
      const req = {
        jsonrpc: "2.0", id: 1, method: "enqueueTask",
        params: {
          taskId: "t_1", messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hi",
        },
      };
      s.write(JSON.stringify(req) + "\n");
      const reply = await collectOneFrame(s);
      expect((reply as { id: number }).id).toBe(1);
      s.destroy();
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// sendInternal + reject-exactly-once
// ─────────────────────────────────────────────────────────────────────

describe("BackendUdsServer — sendInternal + reject once (router-driven)", () => {
  // 副指挥 1b24ae71 P0-1: BackendUdsServer no longer subscribes to
  // the upstream transport directly. Response dispatch flows through
  // the lifecycle-owned UpstreamRouter, which consumes the mux and
  // calls the wrapped resolve/reject on the InternalOrigin. These
  // tests drive that path via `h.server.handleUpstreamClose()` and
  // the frozen `mux.consumeUpstreamResponse` directly.
  test("upstream close mid-pending → Promise rejects with upstream_closed", async () => {
    const h = await makeHarness();
    try {
      const p = h.server.sendInternal("thread/status", { threadId: "t" });
      await new Promise((r) => setTimeout(r, 10));
      // Router's onClose handler calls handleUpstreamClose on the
      // backend server.
      h.server.handleUpstreamClose();
      let reason = "";
      try { await p; } catch (e) { reason = (e as Error).message; }
      expect(reason).toBe("upstream_closed");
    } finally { await h.cleanup(); }
  });

  test("server.stop mid-pending → rejects with gateway_stopping", async () => {
    const h = await makeHarness();
    const p = h.server.sendInternal("thread/status", { threadId: "t" });
    await new Promise((r) => setTimeout(r, 10));
    await h.server.stop();
    let reason = "";
    try { await p; } catch (e) { reason = (e as Error).message; }
    expect(reason).toBe("gateway_stopping");
    try { fs.rmSync(h.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("happy path: response consumed via mux -> Promise resolves", async () => {
    const h = await makeHarness();
    try {
      const p = h.server.sendInternal<{ v: string }>("thread/status", { threadId: "t" });
      await new Promise((r) => setTimeout(r, 10));
      const uid = (h.upstream.written[0] as JsonRpcRequestFrame).id as number;
      // Simulate what the UpstreamRouter does: consume via the mux
      // and call the InternalOrigin resolver.
      const origin = h.mux.consumeUpstreamResponse(uid);
      if (origin === null || origin.kind !== "internal") throw new Error("expected internal origin");
      origin.origin.resolve({ v: "ok" });
      const res = await p;
      expect(res.v).toBe("ok");
    } finally { await h.cleanup(); }
  });
});
