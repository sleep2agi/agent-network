// RFC-030 Wave 1A P0.2 — Backend-only UDS server.
//
// After P0.2 (副指挥 7034c5ce items #6 + #12), this file owns ONLY
// the Agent-facing Unix Domain Socket. The TUI-facing wire is now
// `tui-ws-server.ts` (RFC 6455 WebSocket on 127.0.0.1:<ephemeral>).
//
// Owns the SINGLE frozen `UpstreamRequestMux` shared with the WS TUI
// server for internal-scheduler requests. Message classification and
// dispatch are delegated to the pure protocol layer (contract.ts /
// protocol.ts, frozen at 90d1e58).
//
// Hard requirements retained from the earlier Segment A/P0 pass:
//   - UDS ONLY. No TCP / loopback fallback anywhere.
//   - Socket directory 0700; socket file 0600; lstat verifies neither
//     symlink nor non-owner; shutdown only unlinks paths we created.
//   - Per-frame + per-connection buffered caps. Malformed / oversize
//     emit a structured JSON-RPC error and destroy the connection;
//     raw exception messages / paths / tokens never appear on the wire.
//   - Backend capability handshake preserves the earlier P0 fix:
//     first frame MUST be `gateway.hello` with the correct backend
//     capability; hello timeout destroys the connection.
//   - Hard single-owner: exactly one authenticated backend
//     connection at a time. No configurable ceiling.

import * as net from "node:net";
import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import {
  classifyMessage,
  dispatchAgentRequest,
  UpstreamRequestMux,
  type ProtocolBackend,
  type ProtocolDiagnostics,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcNotificationFrame,
  type JsonRpcRequestId,
} from "./protocol";
import {
  GATEWAY_ERROR_DATA_CODE,
  GatewayErrorCode,
} from "./contract";

// ────────────────────────────────────────────────────────────────────────
// Limits
// ────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_FRAME_BYTES = 200 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
export const DEFAULT_HELLO_TIMEOUT_MS = 3_000;

/** Hard single-owner cap. Non-configurable (副指挥 7034c5ce item #6). */
export const MAX_BACKEND_CONNECTIONS = 1;

/** Method name for the capability handshake first frame. */
export const GATEWAY_HELLO_METHOD = "gateway.hello";

// ────────────────────────────────────────────────────────────────────────
// Upstream transport (shared with tui-ws-server via lifecycle)
// ────────────────────────────────────────────────────────────────────────

export interface UpstreamTransport {
  writeFrame(frame: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void>;
  onFrame(handler: (raw: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  /**
   * Force-close the upstream transport. B owns the wire connection;
   * lifecycle awaits this during shutdown. Idempotent.
   */
  close(): Promise<void>;
}

export interface InternalOrigin {
  readonly kind: "internal";
  readonly label: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
}

interface InternalPendingEntry {
  readonly upstreamId: number;
  readonly origin: InternalOrigin;
  settled: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────────

export interface BackendUdsServerLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly helloTimeoutMs: number;
}

export interface BackendUdsServerOptions {
  readonly socketPath: string;
  readonly socketDir: string;
  readonly mux: UpstreamRequestMux<InternalOrigin>;
  readonly upstreamTransport: UpstreamTransport;
  readonly diagnostics: ProtocolDiagnostics;
  readonly backend: ProtocolBackend;
  /**
   * Launcher-provisioned high-entropy capability for the backend
   * socket. Length >= 32, distinct per lifecycle. Constructor rejects
   * empty / short strings.
   */
  readonly backendCapability: string;
  readonly limits?: Partial<BackendUdsServerLimits>;
}

// ────────────────────────────────────────────────────────────────────────
// LineFramer + path helpers
// ────────────────────────────────────────────────────────────────────────

type FramerEvent =
  | { kind: "frame"; raw: unknown }
  | { kind: "malformed"; reason: string; data?: Record<string, unknown> }
  | { kind: "oversize"; reason: string; data?: Record<string, unknown> };

class LineFramer {
  private buf: Buffer = Buffer.alloc(0);
  private frameStart = 0;
  constructor(
    private readonly maxFrameBytes: number,
    private readonly maxBufferedBytes: number,
  ) {}

  push(chunk: Buffer): FramerEvent[] {
    const out: FramerEvent[] = [];
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.maxBufferedBytes) {
      out.push({ kind: "oversize", reason: "connection_buffered_bytes_exceeded", data: { limit: this.maxBufferedBytes, seen: this.buf.length } });
      this.buf = Buffer.alloc(0);
      this.frameStart = 0;
      return out;
    }
    while (true) {
      const nl = this.buf.indexOf(0x0a, this.frameStart);
      if (nl === -1) {
        const pending = this.buf.length - this.frameStart;
        if (pending > this.maxFrameBytes) {
          out.push({ kind: "oversize", reason: "frame_bytes_exceeded", data: { limit: this.maxFrameBytes, seen: pending } });
          this.buf = Buffer.alloc(0);
          this.frameStart = 0;
          return out;
        }
        if (this.frameStart > 0) {
          this.buf = this.buf.subarray(this.frameStart);
          this.frameStart = 0;
        }
        return out;
      }
      const frameLen = nl - this.frameStart;
      if (frameLen > this.maxFrameBytes) {
        out.push({ kind: "oversize", reason: "frame_bytes_exceeded", data: { limit: this.maxFrameBytes, seen: frameLen } });
        this.buf = Buffer.alloc(0);
        this.frameStart = 0;
        return out;
      }
      if (frameLen === 0) {
        this.frameStart = nl + 1;
        continue;
      }
      const raw = this.buf.subarray(this.frameStart, nl).toString("utf8");
      this.frameStart = nl + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        out.push({ kind: "malformed", reason: "invalid_json", data: { at: "frame_body" } });
        this.buf = Buffer.alloc(0);
        this.frameStart = 0;
        return out;
      }
      out.push({ kind: "frame", raw: parsed });
    }
  }
}

interface CreatedPath { readonly path: string; readonly kind: "directory" | "socket"; }

function ensureOwnerOnlyDir(dir: string): { created: boolean } {
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dir); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st === null) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return { created: true };
  }
  if (st.isSymbolicLink()) throw new Error("socket dir is a symlink; refusing to use");
  if (!st.isDirectory()) throw new Error("socket dir path exists and is not a directory");
  if (st.uid !== process.getuid?.()) throw new Error("socket dir owner is not the current uid");
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new Error(`socket dir mode is 0${mode.toString(8)}, must be 0700`);
  return { created: false };
}

function bindOwnerOnlySocket(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let existed = false;
    try { fs.lstatSync(socketPath); existed = true; }
    catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return reject(e as Error); }
    if (existed) return reject(new Error("socket path already exists; refusing to bind"));
    const onError = (err: Error) => { server.off("listening", onListening); reject(err); };
    const onListening = () => {
      server.off("error", onError);
      try {
        fs.chmodSync(socketPath, 0o600);
        const st = fs.lstatSync(socketPath);
        if (st.isSymbolicLink()) throw new Error("bound socket path is a symlink");
        if (!st.isSocket()) throw new Error("bound path is not a socket inode");
        if (st.uid !== process.getuid?.()) throw new Error("bound socket owner is not current uid");
        const mode = st.mode & 0o777;
        if (mode !== 0o600) throw new Error(`bound socket mode is 0${mode.toString(8)}`);
      } catch (e: unknown) { return reject(e as Error); }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function digestCapability(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

// ────────────────────────────────────────────────────────────────────────
// BackendUdsServer
// ────────────────────────────────────────────────────────────────────────

type ConnectionPhase = "awaiting_hello" | "authenticated";

interface ConnectionState {
  readonly socket: net.Socket;
  readonly framer: LineFramer;
  phase: ConnectionPhase;
  helloTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export class BackendUdsServer {
  private readonly opts: BackendUdsServerOptions;
  private readonly limits: BackendUdsServerLimits;
  private readonly backendCapabilityDigest: Buffer;

  private server: net.Server | null = null;
  private readonly connections = new Set<ConnectionState>();
  private readonly createdPaths: CreatedPath[] = [];
  private upstreamUnsubs: Array<() => void> = [];
  private running = false;
  private shuttingDown = false;

  private readonly internalPending = new Map<number, InternalPendingEntry>();

  constructor(opts: BackendUdsServerOptions) {
    this.opts = opts;
    this.limits = {
      maxFrameBytes: opts.limits?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxBufferedBytes: opts.limits?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      helloTimeoutMs: opts.limits?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    };
    if (typeof opts.backendCapability !== "string" || opts.backendCapability.length < 32) {
      throw new Error("backendCapability must be a non-empty string of at least 32 chars");
    }
    this.backendCapabilityDigest = digestCapability(opts.backendCapability);
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("BackendUdsServer already running");
    const dirRes = ensureOwnerOnlyDir(this.opts.socketDir);
    if (dirRes.created) this.createdPaths.push({ path: this.opts.socketDir, kind: "directory" });

    this.server = net.createServer((socket) => this.acceptConnection(socket));
    try {
      await bindOwnerOnlySocket(this.server, this.opts.socketPath);
      this.createdPaths.push({ path: this.opts.socketPath, kind: "socket" });
      // 副指挥 1b24ae71 P0-1: Backend does NOT subscribe to the
      // upstream transport. The lifecycle-owned `UpstreamRouter` is
      // the SOLE subscriber; it calls into this instance via the
      // mux'd `InternalOrigin.resolve/reject` closures returned from
      // `sendInternal`.
    } catch (e) {
      await this.closeServer();
      this.cleanupCreatedPaths();
      throw e;
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.shuttingDown = true;

    this.rejectAllInternalPending("gateway_stopping");

    for (const c of this.connections) {
      if (!c.closed) {
        c.closed = true;
        if (c.helloTimer !== null) clearTimeout(c.helloTimer);
        try { c.socket.destroy(); } catch { /* silent */ }
      }
    }
    this.connections.clear();

    await this.closeServer();
    this.opts.mux.drainAll();
    this.cleanupCreatedPaths();
  }

  private async closeServer(): Promise<void> {
    if (this.server === null) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private cleanupCreatedPaths(): void {
    for (const p of [...this.createdPaths].reverse()) {
      try {
        if (p.kind === "socket") fs.unlinkSync(p.path);
        else if (p.kind === "directory") fs.rmdirSync(p.path);
      } catch { /* silent */ }
    }
    this.createdPaths.length = 0;
  }

  private rejectAllInternalPending(reason: string): void {
    // Snapshot entries first — the wrapper's reject callback mutates
    // `internalPending` during iteration.
    const snapshot = Array.from(this.internalPending.values());
    for (const entry of snapshot) {
      if (entry.settled) continue;
      // Let the wrapped reject do the settled flip + outerReject; we
      // do NOT mutate entry.settled here (that would short-circuit the
      // wrapper's guard).
      try { entry.origin.reject(new Error(reason)); }
      catch (e: unknown) {
        try {
          this.opts.diagnostics.reportInternalError({
            correlationId: this.opts.diagnostics.newCorrelationId(),
            operation: "reject_internal_pending",
            error: e,
          });
        } catch { /* silent */ }
      }
    }
    // Any lingering entries (e.g. wrapper deleted its own key during
    // the iteration) are cleared for the next lifecycle.
    this.internalPending.clear();
  }

  // ─────────── Connection accept ───────────

  private acceptConnection(socket: net.Socket): void {
    if (this.connections.size >= MAX_BACKEND_CONNECTIONS || this.shuttingDown) {
      try { socket.destroy(); } catch { /* silent */ }
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "accept_connection",
          error: new Error(
            this.shuttingDown
              ? "refused new backend connection: server shutting down"
              : `backend hard-1 cap exceeded (${MAX_BACKEND_CONNECTIONS})`,
          ),
        });
      } catch { /* silent */ }
      return;
    }
    const framer = new LineFramer(this.limits.maxFrameBytes, this.limits.maxBufferedBytes);
    const state: ConnectionState = { socket, framer, phase: "awaiting_hello", helloTimer: null, closed: false };
    state.helloTimer = setTimeout(() => {
      if (state.closed || state.phase !== "awaiting_hello") return;
      this.writeStructuredError(state, "handshake_required", { limitMs: this.limits.helloTimeoutMs });
      this.closeConnection(state);
    }, this.limits.helloTimeoutMs);
    state.helloTimer.unref?.();
    this.connections.add(state);
    socket.on("data", (chunk: Buffer) => this.onData(state, chunk));
    socket.on("close", () => this.closeConnection(state));
    socket.on("error", () => {
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "socket_error_backend",
          error: new Error("socket_error"),
        });
      } catch { /* silent */ }
      this.closeConnection(state);
    });
  }

  private closeConnection(state: ConnectionState): void {
    if (state.closed) return;
    state.closed = true;
    this.connections.delete(state);
    if (state.helloTimer !== null) { clearTimeout(state.helloTimer); state.helloTimer = null; }
    try { state.socket.destroy(); } catch { /* silent */ }
  }

  // ─────────── Inbound data / hello ───────────

  private onData(state: ConnectionState, chunk: Buffer): void {
    const events = state.framer.push(chunk);
    for (const ev of events) {
      if (state.closed) return;
      if (ev.kind === "malformed" || ev.kind === "oversize") {
        this.writeStructuredError(state, ev.reason, ev.data ?? {});
        this.closeConnection(state);
        return;
      }
      if (state.phase === "awaiting_hello") { this.handleHelloFrame(state, ev.raw); continue; }
      void this.onFrame(state, ev.raw);
    }
  }

  private handleHelloFrame(state: ConnectionState, raw: unknown): void {
    let capability: string | null = null;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.method === GATEWAY_HELLO_METHOD && typeof obj.params === "object" && obj.params !== null) {
        const p = obj.params as Record<string, unknown>;
        if (typeof p.capability === "string") capability = p.capability;
      }
    }
    if (capability === null) {
      this.writeStructuredError(state, "handshake_required", { role: "backend" });
      this.closeConnection(state);
      return;
    }
    const receivedDigest = digestCapability(capability);
    let ok = false;
    try { ok = crypto.timingSafeEqual(receivedDigest, this.backendCapabilityDigest); }
    catch { ok = false; }
    if (!ok) {
      this.writeStructuredError(state, "capability_invalid", { role: "backend" });
      this.closeConnection(state);
      return;
    }
    if (state.helloTimer !== null) { clearTimeout(state.helloTimer); state.helloTimer = null; }
    state.phase = "authenticated";
    // No wire reply — silence is acceptance.
  }

  private writeStructuredError(state: ConnectionState, reason: string, data: Record<string, unknown>): void {
    if (state.closed) return;
    const frame: JsonRpcResponseFrame = {
      jsonrpc: "2.0",
      id: null as unknown as JsonRpcRequestId,
      error: {
        code: GatewayErrorCode.InvalidArg,
        message: "malformed frame",
        data: { code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.InvalidArg], reason, ...data },
      },
    };
    try { state.socket.write(JSON.stringify(frame) + "\n"); } catch { /* silent */ }
  }

  // ─────────── Post-auth frame dispatch ───────────

  private async onFrame(state: ConnectionState, raw: unknown): Promise<void> {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "request":
        await this.dispatchAgentFrame(state, cls.frame);
        return;
      case "response":
        this.writeStructuredError(state, "unexpected_response_on_backend", {});
        this.closeConnection(state);
        return;
      case "notification":
        return;
      case "malformed":
        this.writeStructuredError(state, cls.reason, {});
        this.closeConnection(state);
        return;
    }
  }

  private async dispatchAgentFrame(state: ConnectionState, frame: JsonRpcRequestFrame): Promise<void> {
    const outcome = await dispatchAgentRequest(frame, this.opts.backend, this.opts.diagnostics);
    if (state.closed) return;
    if (outcome.kind === "reply") {
      this.writeFrame(state, { jsonrpc: "2.0", id: outcome.agentId, result: outcome.result });
    } else if (outcome.kind === "error") {
      this.writeFrame(state, {
        jsonrpc: "2.0",
        id: outcome.agentId,
        error: { code: outcome.code, message: outcome.message, data: outcome.data },
      });
    }
  }

  // ─────────── sendInternal + upstream-close hook ───────────

  /**
   * P0.2 round 3 (副指挥 1b24ae71): called by the sole UpstreamRouter
   * when the upstream transport closes. Rejects pending internal
   * Promises exactly once and drains the mux. NOT wired to the
   * transport directly — the router owns that subscription.
   */
  handleUpstreamClose(): void {
    this.rejectAllInternalPending("upstream_closed");
    this.opts.mux.drainAll();
  }

  /**
   * Wrap the raw `InternalOrigin` so that the router's response
   * dispatch settles the pending Promise exactly once. Uses
   * `entry.upstreamId` (mutable box) so the cleanup path deletes
   * the REAL id after allocation, not the placeholder that was
   * present at closure-capture time.
   *
   * 副指挥 06e92ef7 P1-1: prior version captured `upstreamId=0` in
   * the closure and always called `delete(0)`. Response bookkeeping
   * accumulated map entries under real ids that never got cleaned.
   */
  private buildInternalPendingEntry(
    outerResolve: (v: unknown) => void,
    outerReject: (e: Error) => void,
    label: string,
  ): { origin: InternalOrigin; entry: InternalPendingEntry } {
    const entry: InternalPendingEntry = { upstreamId: -1, origin: null as unknown as InternalOrigin, settled: false };
    const origin: InternalOrigin = {
      kind: "internal",
      label,
      resolve: (v) => {
        if (entry.settled) return;
        entry.settled = true;
        this.internalPending.delete(entry.upstreamId);
        outerResolve(v);
      },
      reject: (e) => {
        if (entry.settled) return;
        entry.settled = true;
        this.internalPending.delete(entry.upstreamId);
        outerReject(e);
      },
    };
    entry.origin = origin;
    return { origin, entry };
  }


  sendInternal<T = unknown>(method: string, params: unknown | undefined, label = method): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.shuttingDown || !this.running) {
        reject(new Error("gateway_stopping"));
        return;
      }
      // Allocate a placeholder id via the mux; the origin registered
      // there routes response dispatch through the wrapped
      // resolve/reject so the internal pending entry is settled
      // exactly once.
      const { origin, entry } = this.buildInternalPendingEntry(
        (v) => resolve(v as T),
        (e) => reject(e),
        label,
      );
      const alloc = this.opts.mux.allocateForInternalScheduler(origin);
      // Write the REAL id into the entry box so the wrapper's
      // resolve/reject deletes the correct pending map key.
      entry.upstreamId = alloc.upstreamId;
      this.internalPending.set(alloc.upstreamId, entry);
      const frame: JsonRpcRequestFrame = {
        jsonrpc: "2.0", id: alloc.upstreamId, method,
        ...(params !== undefined ? { params } : {}),
      };
      this.opts.upstreamTransport.writeFrame(frame).catch((e: unknown) => {
        // 副指挥 06e92ef7 P1-1: release the mux slot AND settle the
        // outer Promise via the wrapped origin.reject so the pending
        // map (keyed on the real upstream id) is cleaned up
        // atomically. The mux consume here is a no-op if the router
        // has already consumed the id, but calling it explicitly
        // guarantees the mux frees the slot on write-fail.
        this.opts.mux.consumeUpstreamResponse(alloc.upstreamId);
        origin.reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // ─────────── Helpers ───────────

  private writeFrame(state: ConnectionState, frame: JsonRpcResponseFrame | JsonRpcRequestFrame): void {
    if (state.closed) return;
    try {
      state.socket.write(JSON.stringify(frame) + "\n");
    } catch (e: unknown) {
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "write_frame_backend",
          error: e,
        });
      } catch { /* silent */ }
      this.closeConnection(state);
    }
  }

  connectionCount(): number { return this.connections.size; }
}
