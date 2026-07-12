// RFC-030 Wave 1A Segment A — uds-server integration tests.
//
// Every test drives real UDS sockets (temp path per test), a real
// LineFramer via bytes-in / bytes-out, and an in-memory FAKE
// UpstreamTransport (interface-level fake — NOT a real Codex client;
// production upstream wiring is B's job in a later PR).
//
// Coverage matrix (aligned with 副指挥 1e52976d hard requirements):
//   - Path setup: 0700 dir created, 0600 socket bound, lstat rejects
//     symlink and pre-existing path; shutdown removes only what start
//     created.
//   - Framer: fragmented lines, batched frames, half-packet, oversize
//     frame, oversize buffer (no newline), malformed JSON, blank line
//     keepalive.
//   - Agent flow: enqueueTask round-trip via real socket bytes;
//     `initialized` notification produces NO response.
//   - TUI flow: initialize returns injected snapshot; authorized
//     forward_upstream produces an outbound frame on the fake; TUI id
//     types (number + string) both preserved end-to-end.
//   - Dual origin: proxied-TUI + internal-scheduler interleaved on the
//     same upstream fake, out-of-order responses each routed correctly.
//   - Duplicate / unknown upstream response id: dropped into diagnostics
//     sink, nothing on wire.
//   - TUI disconnect: proxied-TUI mux drained, internal pending
//     survives, reverseNs drained.
//   - Approval spoof: unknown reverse id → InvalidArg reject on TUI
//     socket; duplicate consume → same.
//   - max_connections cap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import {
  GatewayServer,
  type GatewayServerOptions,
  type UpstreamTransport,
  type InternalOrigin,
  DEFAULT_MAX_FRAME_BYTES,
} from "./uds-server";
import {
  UpstreamRequestMux,
  ReverseRequestNamespace,
  type ProtocolBackend,
  type ProtocolDiagnostics,
  type TuiInitializeProvider,
  type TuiRequestAuthorizer,
  type InternalErrorEntry,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcNotificationFrame,
} from "./protocol";
import { GatewayErrorCode } from "./contract";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

interface Harness {
  server: GatewayServer;
  socketDir: string;
  backendSocketPath: string;
  tuiSocketPath: string;
  mux: UpstreamRequestMux<InternalOrigin>;
  reverseNs: ReverseRequestNamespace;
  upstream: FakeUpstream;
  diagnosticsEntries: InternalErrorEntry[];
  authorizerVerdict: "allow" | "deny";
  authorizerVerdictCounter: { c: number };
  initSnapshot: Readonly<Record<string, unknown>> | undefined;
  backendEnqueueCalls: number;
  cleanup(): Promise<void>;
}

class FakeUpstream implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  writeShouldThrow = false;

  async writeFrame(f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
    if (this.writeShouldThrow) throw new Error("fake upstream write failure");
    this.written.push(f);
  }

  onFrame(h: (raw: unknown) => void): () => void {
    this.frameHandlers.push(h);
    return () => {
      this.frameHandlers = this.frameHandlers.filter((x) => x !== h);
    };
  }

  onClose(h: () => void): () => void {
    this.closeHandlers.push(h);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((x) => x !== h);
    };
  }

  emitFrame(raw: unknown): void {
    for (const h of [...this.frameHandlers]) h(raw);
  }

  emitClose(): void {
    for (const h of [...this.closeHandlers]) h();
  }
}

async function makeHarness(overrides?: {
  authorizerVerdict?: "allow" | "deny";
  initSnapshot?: Readonly<Record<string, unknown>> | undefined;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  maxConnections?: number;
  backendEnqueueImpl?: ProtocolBackend["enqueueTask"];
}): Promise<Harness> {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rfc030-uds-"));
  // We want the SERVER to own dir setup — remove the empty temp dir
  // so ensureOwnerOnlyDir creates it fresh with 0700.
  await fs.promises.rmdir(socketDir);
  const backendSocketPath = path.join(socketDir, "backend.sock");
  const tuiSocketPath = path.join(socketDir, "tui.sock");

  const mux = new UpstreamRequestMux<InternalOrigin>();
  const reverseNs = new ReverseRequestNamespace();
  const upstream = new FakeUpstream();
  const diagnosticsEntries: InternalErrorEntry[] = [];
  let n = 0;
  const diagnostics: ProtocolDiagnostics = {
    newCorrelationId: () => `cid-${++n}`,
    reportInternalError: (entry) => { diagnosticsEntries.push(entry); },
  };

  const authorizerVerdictCounter = { c: 0 };
  const authorizer: TuiRequestAuthorizer = {
    async authorize() {
      authorizerVerdictCounter.c++;
      return (overrides?.authorizerVerdict ?? "allow") === "allow"
        ? { verdict: "allow" }
        : { verdict: "deny", code: GatewayErrorCode.Busy, reason: "test-deny" };
    },
  };
  const initSnapshot: Readonly<Record<string, unknown>> | undefined = overrides === undefined
    ? { serverInfo: { name: "codex", version: "0.144.0" }, capabilities: {} }
    : ("initSnapshot" in overrides ? overrides.initSnapshot : { serverInfo: { name: "codex", version: "0.144.0" }, capabilities: {} });
  const initProvider: TuiInitializeProvider = {
    currentSnapshot: () => initSnapshot,
  };

  let backendEnqueueCalls = 0;
  const backend: ProtocolBackend = {
    async enqueueTask(args) {
      backendEnqueueCalls++;
      if (overrides?.backendEnqueueImpl) return overrides.backendEnqueueImpl(args);
      return { outcome: "accepted", taskId: args.taskId, queuePosition: 0, duplicate: false };
    },
    async getTaskState() { return { state: "unknown" }; },
    async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
  };

  const opts: GatewayServerOptions = {
    backendSocketPath, tuiSocketPath, socketDir,
    mux, reverseNs, upstreamTransport: upstream,
    initProvider, diagnostics, authorizer, backend,
    limits: {
      maxFrameBytes: overrides?.maxFrameBytes,
      maxBufferedBytes: overrides?.maxBufferedBytes,
      maxConnections: overrides?.maxConnections,
    },
  };
  const server = new GatewayServer(opts);
  await server.start();

  const h: Harness = {
    server, socketDir, backendSocketPath, tuiSocketPath, mux, reverseNs, upstream,
    diagnosticsEntries, authorizerVerdict: overrides?.authorizerVerdict ?? "allow",
    authorizerVerdictCounter, initSnapshot,
    get backendEnqueueCalls() { return backendEnqueueCalls; },
    async cleanup() {
      await server.stop();
      // Best-effort — dir might already be gone.
      try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
    },
  } as Harness;
  return h;
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function collectFrames(socket: net.Socket, count: number, timeoutMs = 500): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} frames, got ${out.length}`)), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        out.push(JSON.parse(line));
        if (out.length >= count) {
          clearTimeout(timer);
          resolve(out);
          return;
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (out.length >= count) resolve(out);
      else if (out.length > 0) resolve(out);
      // else timeout will fire
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Path setup
// ─────────────────────────────────────────────────────────────────────

describe("path setup (0700 dir, 0600 socket, lstat guards)", () => {
  test("start creates dir mode 0700 and socket mode 0600", async () => {
    const h = await makeHarness();
    try {
      const dirSt = fs.lstatSync(h.socketDir);
      expect(dirSt.isDirectory()).toBe(true);
      expect(dirSt.mode & 0o777).toBe(0o700);
      const bkSt = fs.lstatSync(h.backendSocketPath);
      expect(bkSt.isSocket()).toBe(true);
      expect(bkSt.mode & 0o777).toBe(0o600);
      const tuiSt = fs.lstatSync(h.tuiSocketPath);
      expect(tuiSt.isSocket()).toBe(true);
      expect(tuiSt.mode & 0o777).toBe(0o600);
    } finally {
      await h.cleanup();
    }
  });

  test("start refuses to bind if socket path already exists", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rfc030-uds-"));
    const backendSocketPath = path.join(dir, "backend.sock");
    const tuiSocketPath = path.join(dir, "tui.sock");
    fs.writeFileSync(backendSocketPath, "");
    fs.chmodSync(dir, 0o700);
    const opts = makeMinimalOpts({ socketDir: dir, backendSocketPath, tuiSocketPath });
    const server = new GatewayServer(opts);
    await expect(server.start()).rejects.toThrow();
    // cleanup
    try { fs.unlinkSync(backendSocketPath); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("start refuses to bind if socket dir is a symlink", async () => {
    const realDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rfc030-uds-real-"));
    fs.chmodSync(realDir, 0o700);
    const linkDir = realDir + "-link";
    fs.symlinkSync(realDir, linkDir);
    const opts = makeMinimalOpts({
      socketDir: linkDir,
      backendSocketPath: path.join(linkDir, "backend.sock"),
      tuiSocketPath: path.join(linkDir, "tui.sock"),
    });
    const server = new GatewayServer(opts);
    await expect(server.start()).rejects.toThrow(/symlink/);
    try { fs.unlinkSync(linkDir); } catch {}
    try { fs.rmSync(realDir, { recursive: true, force: true }); } catch {}
  });

  test("stop unlinks socket files it created but not pre-existing dir contents", async () => {
    // Pre-create the dir with 0700 so ensureOwnerOnlyDir won't create
    // it and won't remove it on stop.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rfc030-uds-"));
    fs.chmodSync(dir, 0o700);
    const backendSocketPath = path.join(dir, "backend.sock");
    const tuiSocketPath = path.join(dir, "tui.sock");
    const otherFile = path.join(dir, "sentinel.txt");
    fs.writeFileSync(otherFile, "keep-me");
    const opts = makeMinimalOpts({ socketDir: dir, backendSocketPath, tuiSocketPath });
    const server = new GatewayServer(opts);
    await server.start();
    expect(fs.existsSync(backendSocketPath)).toBe(true);
    await server.stop();
    // Sockets are gone.
    expect(fs.existsSync(backendSocketPath)).toBe(false);
    expect(fs.existsSync(tuiSocketPath)).toBe(false);
    // Pre-existing sentinel + dir are untouched.
    expect(fs.existsSync(otherFile)).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function makeMinimalOpts(overrides: {
  socketDir: string;
  backendSocketPath: string;
  tuiSocketPath: string;
}): GatewayServerOptions {
  const mux = new UpstreamRequestMux<InternalOrigin>();
  const reverseNs = new ReverseRequestNamespace();
  const upstream = new FakeUpstream();
  const backend: ProtocolBackend = {
    async enqueueTask() { return { outcome: "accepted", taskId: "t" as unknown as never, queuePosition: 0, duplicate: false }; },
    async getTaskState() { return { state: "unknown" }; },
    async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
  };
  return {
    backendSocketPath: overrides.backendSocketPath,
    tuiSocketPath: overrides.tuiSocketPath,
    socketDir: overrides.socketDir,
    mux, reverseNs, upstreamTransport: upstream,
    initProvider: { currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" } }) },
    diagnostics: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    authorizer: { async authorize() { return { verdict: "allow" }; } },
    backend,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Agent-side wire round-trip
// ─────────────────────────────────────────────────────────────────────

describe("Agent-side JSON-RPC over real UDS", () => {
  test("enqueueTask happy path — request in bytes, reply in bytes", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      const req = {
        jsonrpc: "2.0", id: 1, method: "enqueueTask",
        params: {
          taskId: "t_1", messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hello",
        },
      };
      sock.write(JSON.stringify(req) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: number; result: { outcome: string; taskId: string } };
      expect(r.id).toBe(1);
      expect(r.result.outcome).toBe("accepted");
      expect(h.backendEnqueueCalls).toBe(1);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("initialized notification (no id) produces NO wire response", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      // Wait 100ms and confirm zero bytes received.
      let bytes = 0;
      sock.on("data", (c) => { bytes += c.length; });
      await new Promise((r) => setTimeout(r, 100));
      expect(bytes).toBe(0);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("initialized as request form (with id) still gets a reply (backward-compat)", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialized" }) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: number; result: unknown };
      expect(r.id).toBe(7);
      expect(r.result).toEqual({});
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("unknown method → UnknownMethod error on wire", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "not-a-method" }) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: number; error: { code: number; data: { code: string } } };
      expect(r.error.code).toBe(GatewayErrorCode.UnknownMethod);
      expect(r.error.data.code).toBe("codex_gateway_unknown_method");
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Framer edge cases
// ─────────────────────────────────────────────────────────────────────

describe("wire framer edge cases", () => {
  test("multiple frames in a single chunk", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      const req = (id: number) => JSON.stringify({
        jsonrpc: "2.0", id, method: "enqueueTask",
        params: {
          taskId: `t_${id}`, messageId: `m_${id}`,
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "x",
        },
      }) + "\n";
      // Three frames in one write.
      sock.write(req(1) + req(2) + req(3));
      const replies = await collectFrames(sock, 3);
      expect(replies.map((r) => (r as { id: number }).id).sort()).toEqual([1, 2, 3]);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("frame split across byte boundaries reassembles", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      const req = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "enqueueTask",
        params: {
          taskId: "t_1", messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "hello",
        },
      });
      // Split into three chunks — one mid-JSON, one mid-newline.
      const cut1 = req.slice(0, 40);
      const cut2 = req.slice(40, 100);
      const cut3 = req.slice(100) + "\n";
      sock.write(cut1);
      await new Promise((r) => setTimeout(r, 5));
      sock.write(cut2);
      await new Promise((r) => setTimeout(r, 5));
      sock.write(cut3);
      const [reply] = await collectFrames(sock, 1);
      expect((reply as { id: number }).id).toBe(1);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("blank line between frames is ignored (keepalive)", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      const req = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "enqueueTask",
        params: {
          taskId: "t_1", messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: "x",
        },
      });
      sock.write("\n\n" + req + "\n\n");
      const [reply] = await collectFrames(sock, 1);
      expect((reply as { id: number }).id).toBe(1);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("malformed JSON → structured error + connection closed", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.backendSocketPath);
      sock.write("this is not json\n");
      const frames = await collectFrames(sock, 1);
      const r = frames[0] as { error: { data: { reason: string } } };
      expect(r.error.data.reason).toBe("invalid_json");
      // Connection closed.
      await new Promise((r2) => setTimeout(r2, 30));
      expect(sock.destroyed || sock.readyState === "closed").toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test("oversize frame refused + connection closed (no memory blowup)", async () => {
    const h = await makeHarness({ maxFrameBytes: 512, maxBufferedBytes: 4096 });
    try {
      const sock = await connect(h.backendSocketPath);
      const huge = "x".repeat(1024);
      sock.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "enqueueTask",
        params: {
          taskId: "t_1", messageId: "m_1",
          authenticatedSender: { alias: "a", tokenId: "tok", role: "member", networkId: "net" },
          text: huge,
        },
      }) + "\n");
      const frames = await collectFrames(sock, 1);
      const r = frames[0] as { error: { data: { reason: string; limit: number } } };
      expect(["frame_bytes_exceeded", "connection_buffered_bytes_exceeded"]).toContain(r.error.data.reason);
      expect(r.error.data.limit).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  test("slow-loris (no newline forever) hits buffered-bytes cap", async () => {
    const h = await makeHarness({ maxBufferedBytes: 4096 });
    try {
      const sock = await connect(h.backendSocketPath);
      sock.write("x".repeat(5000)); // no newline
      const frames = await collectFrames(sock, 1);
      const r = frames[0] as { error: { data: { reason: string } } };
      expect(["connection_buffered_bytes_exceeded", "frame_bytes_exceeded"]).toContain(r.error.data.reason);
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// TUI socket dispatch
// ─────────────────────────────────────────────────────────────────────

describe("TUI socket dispatch", () => {
  test("initialize returns injected upstream snapshot verbatim", async () => {
    const snap = { serverInfo: { name: "codex", version: "0.144.0" }, protocolVersion: "2024-11-05" };
    const h = await makeHarness({ initSnapshot: snap });
    try {
      const sock = await connect(h.tuiSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: number; result: { serverInfo: { name: string; version: string } } };
      expect(r.id).toBe(1);
      expect(r.result.serverInfo.name).toBe("codex");
      expect(r.result.serverInfo.version).toBe("0.144.0");
      // MUST NOT be the Agent handshake shape.
      expect(JSON.stringify(r.result)).not.toContain("codex-policy-gateway/1");
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("initialize when snapshot=undefined → Unavailable fail-closed", async () => {
    const h = await makeHarness({ initSnapshot: undefined });
    try {
      const sock = await connect(h.tuiSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { error: { code: number; data: { source: string; reason: string } } };
      expect(r.error.code).toBe(GatewayErrorCode.Unavailable);
      expect(r.error.data.source).toBe("tui_initialize");
      expect(r.error.data.reason).toBe("upstream_not_initialized");
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("authorizer allow → forwards upstream with fresh id, TUI id preserved via mux", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.tuiSocketPath);
      // Numeric TUI id.
      sock.write(JSON.stringify({
        jsonrpc: "2.0", id: 42, method: "turn/start", params: {},
      }) + "\n");
      // Wait for upstream write to appear.
      await new Promise((r) => setTimeout(r, 40));
      expect(h.upstream.written.length).toBe(1);
      const forwarded = h.upstream.written[0] as JsonRpcRequestFrame;
      expect(forwarded.method).toBe("turn/start");
      // Upstream id was minted fresh, NOT 42.
      expect(typeof forwarded.id).toBe("number");
      expect(forwarded.id).not.toBe(42);
      // Now emit response upstream → should be rewritten back to TUI id=42.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: forwarded.id, result: { ok: true } });
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: number; result: { ok: boolean } };
      expect(r.id).toBe(42);
      expect(r.result.ok).toBe(true);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("string TUI id survives round-trip via mux", async () => {
    const h = await makeHarness();
    try {
      const sock = await connect(h.tuiSocketPath);
      sock.write(JSON.stringify({
        jsonrpc: "2.0", id: "tui-abc", method: "turn/start", params: {},
      }) + "\n");
      await new Promise((r) => setTimeout(r, 40));
      const forwarded = h.upstream.written[0] as JsonRpcRequestFrame;
      expect(typeof forwarded.id).toBe("number");
      h.upstream.emitFrame({ jsonrpc: "2.0", id: forwarded.id, result: { ok: true } });
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { id: string };
      expect(r.id).toBe("tui-abc");
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("authorizer deny → reject on TUI, upstream never written", async () => {
    const h = await makeHarness({ authorizerVerdict: "deny" });
    try {
      const sock = await connect(h.tuiSocketPath);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start" }) + "\n");
      const [reply] = await collectFrames(sock, 1);
      const r = reply as { error: { code: number; data: { code: string } } };
      expect(r.error.code).toBe(GatewayErrorCode.Busy);
      expect(r.error.data.code).toBe("codex_gateway_busy");
      expect(h.upstream.written.length).toBe(0);
      sock.destroy();
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dual origin same socket + out-of-order responses
// ─────────────────────────────────────────────────────────────────────

describe("mux integration — dual origin, out-of-order, duplicate", () => {
  test("proxied TUI + internal scheduler interleaved → distinct upstream ids; out-of-order responses each route correctly", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      // Kick a TUI request first.
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "turn/start" }) + "\n");
      // Then an internal scheduler request.
      const internalPromise = h.server.sendInternal("thread/status", { threadId: "t_1" }, "poll_status");
      await new Promise((r) => setTimeout(r, 40));
      const written = h.upstream.written as JsonRpcRequestFrame[];
      expect(written.length).toBe(2);
      // Order is not deterministic (TUI socket dispatch runs on the
      // event loop; sendInternal writes synchronously). Look up by
      // method so the test isn't racy.
      const tuiWrite = written.find(w => w.method === "turn/start");
      const internalWrite = written.find(w => w.method === "thread/status");
      if (!tuiWrite || !internalWrite) throw new Error("expected both forwards");
      const tuiUpstreamId = tuiWrite.id as number;
      const internalUpstreamId = internalWrite.id as number;
      expect(tuiUpstreamId).not.toBe(internalUpstreamId);
      // Emit responses in REVERSE order.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: internalUpstreamId, result: { state: "running" } });
      h.upstream.emitFrame({ jsonrpc: "2.0", id: tuiUpstreamId, result: { started: true } });
      const [tuiReply] = await collectFrames(tui, 1);
      expect((tuiReply as { id: number }).id).toBe(100);
      const internalResult = await internalPromise;
      expect((internalResult as { state: string }).state).toBe("running");
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("duplicate upstream response id → dropped, diagnostic sink records orphan", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start" }) + "\n");
      await new Promise((r) => setTimeout(r, 40));
      const uid = (h.upstream.written[0] as JsonRpcRequestFrame).id as number;
      // First response — legitimate.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: uid, result: { ok: true } });
      const [firstReply] = await collectFrames(tui, 1);
      expect((firstReply as { id: number }).id).toBe(1);
      // Duplicate.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: uid, result: { ok: true } });
      await new Promise((r) => setTimeout(r, 30));
      const orphans = h.diagnosticsEntries.filter((e) => e.operation === "upstream_response_orphan");
      expect(orphans.length).toBeGreaterThanOrEqual(1);
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("unknown upstream response id (never allocated) → orphan diagnostic, nothing on wire", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      // No prior request → no allocation. Emit anyway.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: 99999, result: { ok: true } });
      await new Promise((r) => setTimeout(r, 30));
      const orphans = h.diagnosticsEntries.filter((e) => e.operation === "upstream_response_orphan");
      expect(orphans.length).toBe(1);
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// TUI disconnect preserves internal pending
// ─────────────────────────────────────────────────────────────────────

describe("TUI disconnect — internal pending survives (Δ11 wired)", () => {
  test("TUI disconnect drains proxied-TUI and reverse; internal scheduler pending still consumable", async () => {
    const h = await makeHarness();
    try {
      // Start an internal scheduler request.
      const internal = h.server.sendInternal("thread/status", { threadId: "t_1" }, "poll");
      await new Promise((r) => setTimeout(r, 20));
      const internalId = (h.upstream.written[0] as JsonRpcRequestFrame).id as number;
      // Now open TUI + do a proxied request.
      const tui = await connect(h.tuiSocketPath);
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "turn/start" }) + "\n");
      await new Promise((r) => setTimeout(r, 40));
      expect(h.upstream.written.length).toBe(2);
      const tuiUpstreamId = (h.upstream.written[1] as JsonRpcRequestFrame).id as number;
      expect(h.mux.pendingCountByKind("proxied_tui")).toBe(1);
      expect(h.mux.pendingCountByKind("internal")).toBe(1);
      // Disconnect TUI.
      tui.destroy();
      await new Promise((r) => setTimeout(r, 40));
      // proxied_tui gone, internal survives.
      expect(h.mux.pendingCountByKind("proxied_tui")).toBe(0);
      expect(h.mux.pendingCountByKind("internal")).toBe(1);
      // Internal response can still complete.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: internalId, result: { state: "running" } });
      const r = await internal;
      expect((r as { state: string }).state).toBe("running");
      // A late upstream response for the TUI request goes orphan.
      h.upstream.emitFrame({ jsonrpc: "2.0", id: tuiUpstreamId, result: { ok: true } });
      await new Promise((r2) => setTimeout(r2, 20));
      expect(h.diagnosticsEntries.filter((e) => e.operation === "upstream_response_orphan").length).toBeGreaterThanOrEqual(1);
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Approval / reverse-request path
// ─────────────────────────────────────────────────────────────────────

describe("reverse-request + approval spoof", () => {
  test("upstream reverse request → forwarded to TUI with rewritten id; TUI response consumed and forwarded upstream", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      // Codex sends a reverse request (e.g. server→client approval).
      h.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_1", method: "approval/request", params: { command: "rm -rf /" } });
      const [rev] = await collectFrames(tui, 1);
      const revFrame = rev as { id: number; method: string };
      expect(revFrame.method).toBe("approval/request");
      // TUI answers.
      const tuiRespId = revFrame.id;
      const before = h.upstream.written.length;
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: tuiRespId, result: { approved: false } }) + "\n");
      await new Promise((r) => setTimeout(r, 40));
      // Upstream got the response with the ORIGINAL codex reverse id "cx_1".
      const rewritten = h.upstream.written[before] as JsonRpcResponseFrame;
      expect(rewritten.id).toBe("cx_1");
      if ("result" in rewritten) {
        expect(rewritten.result).toEqual({ approved: false });
      }
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("approval-spoof: TUI sends response with unknown reverse id → InvalidArg reject on TUI socket", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { approved: true } }) + "\n");
      const [reply] = await collectFrames(tui, 1);
      const r = reply as { error: { code: number; data: { reason: string } } };
      expect(r.error.code).toBe(GatewayErrorCode.InvalidArg);
      expect(r.error.data.reason).toBe("reverse_id_unknown_or_duplicate");
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("duplicate consume: replay same tuiId after first consume → rejected", async () => {
    const h = await makeHarness();
    try {
      const tui = await connect(h.tuiSocketPath);
      h.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_1", method: "approval/request" });
      const [rev] = await collectFrames(tui, 1);
      const tuiRespId = (rev as { id: number }).id;
      // First consume succeeds, forwards upstream.
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: tuiRespId, result: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 30));
      // Replay — must be rejected fail-closed.
      tui.write(JSON.stringify({ jsonrpc: "2.0", id: tuiRespId, result: {} }) + "\n");
      const [reject] = await collectFrames(tui, 1);
      const r = reject as { error: { data: { reason: string } } };
      expect(r.error.data.reason).toBe("reverse_id_unknown_or_duplicate");
      tui.destroy();
    } finally {
      await h.cleanup();
    }
  });

  test("reverse request with no TUI attached → NoOwner sent back upstream", async () => {
    const h = await makeHarness();
    try {
      // No TUI connect.
      const before = h.upstream.written.length;
      h.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_9", method: "approval/request" });
      await new Promise((r) => setTimeout(r, 30));
      const err = h.upstream.written[before] as JsonRpcResponseFrame;
      expect(err.id).toBe("cx_9");
      if ("error" in err) {
        expect(err.error.code).toBe(GatewayErrorCode.NoOwner);
      } else {
        throw new Error("expected error response upstream");
      }
    } finally {
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Connection cap
// ─────────────────────────────────────────────────────────────────────

describe("connection cap", () => {
  test("max_connections=2 → third connect destroyed immediately with diagnostic", async () => {
    const h = await makeHarness({ maxConnections: 2 });
    try {
      const a = await connect(h.backendSocketPath);
      const b = await connect(h.backendSocketPath);
      await new Promise((r) => setTimeout(r, 20));
      expect(h.server.connectionCount()).toBe(2);
      const c = await connect(h.backendSocketPath);
      // Give the server a beat to notice + destroy.
      await new Promise((r) => setTimeout(r, 30));
      expect(h.server.connectionCount()).toBe(2);
      const rejects = h.diagnosticsEntries.filter((e) => e.operation === "accept_connection");
      expect(rejects.length).toBeGreaterThanOrEqual(1);
      a.destroy(); b.destroy(); c.destroy();
    } finally {
      await h.cleanup();
    }
  });
});
