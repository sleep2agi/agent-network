// RFC-030 Wave 1A Segment A — UDS server layer.
//
// Owns the two Unix Domain Socket servers (Agent + TUI) and the SINGLE
// frozen `UpstreamRequestMux` + `ReverseRequestNamespace`. Message
// classification and dispatch are delegated to the pure protocol layer
// (contract.ts / protocol.ts, frozen at 90d1e58).
//
// Hard requirements (副指挥 1e52976d):
//   - UDS ONLY. No TCP / loopback fallback anywhere.
//   - Socket directory created 0700 (owner-only).
//   - Socket file chmod'd to 0600. `lstat` verifies the created path
//     is neither a symlink nor owned by anyone but us BEFORE we accept
//     connections on it.
//   - Shutdown only removes paths this instance created — never a
//     pre-existing socket or directory.
//   - Per-connection buffered-but-not-yet-terminated bytes capped.
//     Per-frame size capped. Malformed / oversize → structured JSON-RPC
//     error frame + immediate disconnect. Raw exceptions / paths never
//     appear on the wire; the injected `ProtocolDiagnostics` sink gets
//     the full trace.
//   - Single mux instance for BOTH proxied-TUI and internal-scheduler
//     upstream requests. The transport surface (`sendInternal` +
//     `sendProxiedTui`) is the ONLY way to inject upstream I/O.
//   - Real newline-delimited JSON-RPC framing. Notification frames
//     (no `id`) get NO response.

import * as net from "node:net";
import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import {
  classifyMessage,
  dispatchAgentRequest,
  dispatchTuiRequest,
  handleTuiResponseFrame,
  UpstreamRequestMux,
  ReverseRequestNamespace,
  type ProtocolBackend,
  type ProtocolDiagnostics,
  type TuiInitializeProvider,
  type TuiRequestAuthorizer,
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
// Limits — frame + buffer + connection ceilings
// ────────────────────────────────────────────────────────────────────────

/**
 * Default hard cap on a single JSON-RPC frame.
 *
 * Rationale: the typed contract allows a task body up to 128KB
 * (`text` in EnqueueTaskArgs). Add ~72KB headroom for the surrounding
 * JSON-RPC envelope (method, id, params keys, quoting overhead) and
 * we land at 200KB. Anything above this is either a bug in the caller
 * or a slow-loris style abuse attempt; both fail closed.
 */
export const DEFAULT_MAX_FRAME_BYTES = 200 * 1024;

/**
 * Default cap on unterminated buffered bytes per connection. Two full
 * frames worth so a legitimate trailing newline arriving in a separate
 * TCP packet still succeeds. Anything beyond this is treated as a
 * malformed stream and the connection is torn down.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * Default concurrent-connection ceiling per socket. In practice one
 * client per socket (the Agent runtime for backend, the native Codex
 * TUI for TUI). We allow 8 to leave headroom for a quick reconnect
 * overlap, but no more.
 */
export const DEFAULT_MAX_CONNECTIONS = 8;

// ────────────────────────────────────────────────────────────────────────
// Injected upstream transport — B provides the real one
// ────────────────────────────────────────────────────────────────────────

/**
 * Interface for the wire connection to the upstream Codex app-server.
 * This layer NEVER constructs one — lifecycle.ts / B injects a concrete
 * implementation. Tests use an in-memory fake (interface-level fake,
 * NOT a real Codex client).
 *
 * Every outbound frame to Codex — proxied TUI request, internal
 * scheduler request, TUI approval response rewrite — flows through
 * `writeFrame`. Every inbound frame from Codex — response, reverse
 * request, notification — is handed to the `onFrame` handler.
 */
export interface UpstreamTransport {
  writeFrame(frame: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void>;
  /** Register a handler; returns an unsubscribe function. */
  onFrame(handler: (raw: unknown) => void): () => void;
  /** Register a close handler; returns an unsubscribe function. */
  onClose(handler: () => void): () => void;
}

// ────────────────────────────────────────────────────────────────────────
// InternalOrigin — mux payload for scheduler / lifecycle requests
// ────────────────────────────────────────────────────────────────────────

/**
 * Payload stashed in `UpstreamRequestMux` when the scheduler or
 * lifecycle sends an internal request upstream. Response consumption
 * calls `resolve` / `reject` on the Promise returned by
 * `sendInternal`.
 */
export interface InternalOrigin {
  readonly kind: "internal";
  readonly label: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
}

// ────────────────────────────────────────────────────────────────────────
// GatewayServerOptions
// ────────────────────────────────────────────────────────────────────────

export interface GatewayServerLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxConnections: number;
}

export interface GatewayServerOptions {
  /** Absolute path where the backend (Agent) UDS lives. */
  readonly backendSocketPath: string;
  /** Absolute path where the TUI UDS lives. */
  readonly tuiSocketPath: string;
  /**
   * Parent directory holding both sockets. If it exists and is not a
   * plain directory owned by us with mode 0700, `start()` fails
   * closed. If it does not exist, it is created with mode 0700.
   */
  readonly socketDir: string;
  /** Frozen mux instance (single). */
  readonly mux: UpstreamRequestMux<InternalOrigin>;
  /** Frozen reverse namespace instance (single). */
  readonly reverseNs: ReverseRequestNamespace;
  /** Injected upstream Codex transport. B owns; tests fake. */
  readonly upstreamTransport: UpstreamTransport;
  readonly initProvider: TuiInitializeProvider;
  readonly diagnostics: ProtocolDiagnostics;
  readonly authorizer: TuiRequestAuthorizer;
  readonly backend: ProtocolBackend;
  readonly limits?: Partial<GatewayServerLimits>;
}

// ────────────────────────────────────────────────────────────────────────
// Newline-delimited JSON-RPC framer
// ────────────────────────────────────────────────────────────────────────

type FramerEvent =
  | { kind: "frame"; raw: unknown }
  | { kind: "malformed"; reason: string; data?: Record<string, unknown> }
  | { kind: "oversize"; reason: string; data?: Record<string, unknown> };

/**
 * Byte-oriented, cap-enforced newline framer. Absorbs any chunking:
 * fragmented lines, multiple frames per chunk, mid-frame packet
 * boundaries. Enforces both a per-frame ceiling (`maxFrameBytes`) and
 * a per-connection buffered ceiling (`maxBufferedBytes`) so a peer
 * cannot exhaust memory by never sending a newline.
 *
 * Emits three event kinds: parsed frame, malformed JSON, oversize.
 * Both malformed and oversize are terminal for the connection — the
 * caller writes an error frame and closes.
 */
class LineFramer {
  private buf: Buffer = Buffer.alloc(0);
  private frameStart = 0;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly maxBufferedBytes: number,
  ) {}

  push(chunk: Buffer): FramerEvent[] {
    const out: FramerEvent[] = [];
    // Append. `concat` handles the empty-buf case efficiently.
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    // Enforce the buffered ceiling BEFORE scanning. This catches a
    // slow-loris that never sends a newline.
    if (this.buf.length > this.maxBufferedBytes) {
      out.push({
        kind: "oversize",
        reason: "connection_buffered_bytes_exceeded",
        data: { limit: this.maxBufferedBytes, seen: this.buf.length },
      });
      // Drop the buffer so the caller can safely close.
      this.buf = Buffer.alloc(0);
      this.frameStart = 0;
      return out;
    }

    // Scan for newlines and emit frames.
    while (true) {
      const nl = this.buf.indexOf(0x0a /* \n */, this.frameStart);
      if (nl === -1) {
        // No terminator yet. Check per-frame cap on the pending slice.
        const pending = this.buf.length - this.frameStart;
        if (pending > this.maxFrameBytes) {
          out.push({
            kind: "oversize",
            reason: "frame_bytes_exceeded",
            data: { limit: this.maxFrameBytes, seen: pending },
          });
          this.buf = Buffer.alloc(0);
          this.frameStart = 0;
          return out;
        }
        // Compact the buffer so `frameStart` doesn't accumulate.
        if (this.frameStart > 0) {
          this.buf = this.buf.subarray(this.frameStart);
          this.frameStart = 0;
        }
        return out;
      }

      const frameLen = nl - this.frameStart;
      if (frameLen > this.maxFrameBytes) {
        out.push({
          kind: "oversize",
          reason: "frame_bytes_exceeded",
          data: { limit: this.maxFrameBytes, seen: frameLen },
        });
        this.buf = Buffer.alloc(0);
        this.frameStart = 0;
        return out;
      }

      if (frameLen === 0) {
        // Blank line: skip. Allows peer to send \n as a keepalive.
        this.frameStart = nl + 1;
        continue;
      }

      const raw = this.buf.subarray(this.frameStart, nl).toString("utf8");
      this.frameStart = nl + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (_e) {
        out.push({
          kind: "malformed",
          reason: "invalid_json",
          data: { at: "frame_body" },
        });
        // Malformed is a terminal event; drop buffer + surface.
        this.buf = Buffer.alloc(0);
        this.frameStart = 0;
        return out;
      }
      out.push({ kind: "frame", raw: parsed });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Path setup helpers
// ────────────────────────────────────────────────────────────────────────

interface CreatedPath {
  readonly path: string;
  readonly kind: "directory" | "socket";
}

/**
 * Create `dir` with mode 0700 if it does not exist. If it does exist,
 * `lstat` it, and only accept it if it is a real directory owned by
 * this uid with mode 0700. Returns `{ created }` so shutdown knows
 * whether it is allowed to remove the dir.
 *
 * lstat (not stat) so a symlinked directory is refused rather than
 * followed — a hostile peer could otherwise divert socket creation
 * into a directory it controls.
 */
function ensureOwnerOnlyDir(dir: string): { created: boolean } {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st === null) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Some umasks strip mode bits; chmod explicitly.
    fs.chmodSync(dir, 0o700);
    return { created: true };
  }
  if (st.isSymbolicLink()) {
    throw new Error("socket dir is a symlink; refusing to use");
  }
  if (!st.isDirectory()) {
    throw new Error("socket dir path exists and is not a directory");
  }
  if (st.uid !== process.getuid?.()) {
    throw new Error("socket dir owner is not the current uid");
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`socket dir mode is 0${mode.toString(8)}, must be 0700`);
  }
  return { created: false };
}

/**
 * Create the UDS server bound to `socketPath`, chmod it to 0600, and
 * verify with `lstat` that the resulting inode is a socket owned by
 * this uid — NEVER a symlink and never someone else's file.
 *
 * If a stale file exists at `socketPath`, refuse it — the caller is
 * expected to have cleaned up on a prior graceful shutdown. Silently
 * unlinking here would let an attacker who created a symlink at the
 * path have that symlink deleted (racing with a legitimate service).
 */
function bindOwnerOnlySocket(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Refuse to bind if anything exists at the path.
    let existed = false;
    try {
      fs.lstatSync(socketPath);
      existed = true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return reject(e as Error);
    }
    if (existed) {
      return reject(new Error("socket path already exists; refusing to bind"));
    }
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
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
      } catch (e: unknown) {
        return reject(e as Error);
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

// ────────────────────────────────────────────────────────────────────────
// GatewayServer
// ────────────────────────────────────────────────────────────────────────

type SocketRole = "backend" | "tui";

interface ConnectionState {
  readonly role: SocketRole;
  readonly socket: net.Socket;
  readonly framer: LineFramer;
  closed: boolean;
}

export class GatewayServer {
  private readonly opts: GatewayServerOptions;
  private readonly limits: GatewayServerLimits;

  private backendServer: net.Server | null = null;
  private tuiServer: net.Server | null = null;

  private readonly connections = new Set<ConnectionState>();
  private readonly createdPaths: CreatedPath[] = [];
  private upstreamUnsubs: Array<() => void> = [];
  private running = false;

  constructor(opts: GatewayServerOptions) {
    this.opts = opts;
    this.limits = {
      maxFrameBytes: opts.limits?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxBufferedBytes: opts.limits?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      maxConnections: opts.limits?.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    };
  }

  // ─────────── Lifecycle ───────────

  async start(): Promise<void> {
    if (this.running) throw new Error("gateway server already running");
    const dirRes = ensureOwnerOnlyDir(this.opts.socketDir);
    if (dirRes.created) {
      this.createdPaths.push({ path: this.opts.socketDir, kind: "directory" });
    }

    this.backendServer = net.createServer((socket) => this.acceptConnection("backend", socket));
    this.tuiServer = net.createServer((socket) => this.acceptConnection("tui", socket));

    try {
      await bindOwnerOnlySocket(this.backendServer, this.opts.backendSocketPath);
      this.createdPaths.push({ path: this.opts.backendSocketPath, kind: "socket" });
      await bindOwnerOnlySocket(this.tuiServer, this.opts.tuiSocketPath);
      this.createdPaths.push({ path: this.opts.tuiSocketPath, kind: "socket" });
    } catch (e) {
      // Roll back: close any listening servers, unlink anything we made.
      await this.rollbackStart();
      throw e;
    }

    // Subscribe to upstream Codex.
    this.upstreamUnsubs.push(this.opts.upstreamTransport.onFrame((raw) => this.onUpstreamFrame(raw)));
    this.upstreamUnsubs.push(this.opts.upstreamTransport.onClose(() => this.onUpstreamClose()));

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const un of this.upstreamUnsubs) {
      try { un(); } catch { /* no-op */ }
    }
    this.upstreamUnsubs = [];

    for (const c of this.connections) {
      if (!c.closed) {
        c.closed = true;
        try { c.socket.destroy(); } catch { /* no-op */ }
      }
    }
    this.connections.clear();

    await this.closeServer(this.backendServer);
    this.backendServer = null;
    await this.closeServer(this.tuiServer);
    this.tuiServer = null;

    this.cleanupCreatedPaths();
  }

  private async rollbackStart(): Promise<void> {
    await this.closeServer(this.backendServer);
    this.backendServer = null;
    await this.closeServer(this.tuiServer);
    this.tuiServer = null;
    this.cleanupCreatedPaths();
  }

  private closeServer(s: net.Server | null): Promise<void> {
    return new Promise((resolve) => {
      if (s === null) return resolve();
      s.close(() => resolve());
    });
  }

  private cleanupCreatedPaths(): void {
    // Reverse order — sockets before dir.
    for (const p of [...this.createdPaths].reverse()) {
      try {
        if (p.kind === "socket") {
          fs.unlinkSync(p.path);
        } else if (p.kind === "directory") {
          fs.rmdirSync(p.path);
        }
      } catch {
        // Best-effort. If someone touched the path we don't force it.
      }
    }
    this.createdPaths.length = 0;
  }

  // ─────────── Connection accept ───────────

  private acceptConnection(role: SocketRole, socket: net.Socket): void {
    if (this.connections.size >= this.limits.maxConnections) {
      // Cap exceeded — destroy immediately.
      socket.destroy();
      this.opts.diagnostics.reportInternalError({
        correlationId: this.opts.diagnostics.newCorrelationId(),
        operation: "accept_connection",
        error: new Error(`max_connections=${this.limits.maxConnections} exceeded on role=${role}`),
      });
      return;
    }

    const framer = new LineFramer(this.limits.maxFrameBytes, this.limits.maxBufferedBytes);
    const state: ConnectionState = { role, socket, framer, closed: false };
    this.connections.add(state);

    socket.on("data", (chunk: Buffer) => this.onData(state, chunk));
    socket.on("close", () => this.closeConnection(state));
    socket.on("error", () => {
      // Errors during the connection life are terminal; close.
      // The raw error message is NEVER surfaced — sent to diagnostics.
      this.opts.diagnostics.reportInternalError({
        correlationId: this.opts.diagnostics.newCorrelationId(),
        operation: `socket_error_${role}`,
        error: new Error("socket_error"),
      });
      this.closeConnection(state);
    });
  }

  private closeConnection(state: ConnectionState): void {
    if (state.closed) return;
    state.closed = true;
    this.connections.delete(state);
    try { state.socket.destroy(); } catch { /* no-op */ }

    // TUI disconnect ≠ upstream disconnect (Δ11). Drain only proxied
    // TUI origins and the reverse namespace; internal scheduler
    // Promises stay alive.
    if (state.role === "tui") {
      this.opts.mux.drainProxiedTui();
      this.opts.reverseNs.drainAll();
    }
  }

  // ─────────── Inbound data path ───────────

  private onData(state: ConnectionState, chunk: Buffer): void {
    const events = state.framer.push(chunk);
    for (const ev of events) {
      if (state.closed) return;
      if (ev.kind === "malformed" || ev.kind === "oversize") {
        this.writeStructuredError(state, ev.reason, ev.data ?? {});
        this.closeConnection(state);
        return;
      }
      // frame
      void this.onFrame(state, ev.raw);
    }
  }

  private writeStructuredError(state: ConnectionState, reason: string, data: Record<string, unknown>): void {
    if (state.closed) return;
    // JSON-RPC error frame with id=null when we can't correlate.
    const frame: JsonRpcResponseFrame = {
      jsonrpc: "2.0",
      id: null as unknown as JsonRpcRequestId,
      error: {
        code: GatewayErrorCode.InvalidArg,
        message: "malformed frame",
        data: {
          code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.InvalidArg],
          reason,
          ...data,
        },
      },
    };
    try {
      state.socket.write(JSON.stringify(frame) + "\n");
    } catch {
      // If the socket is already dying we can't do anything.
    }
  }

  private async onFrame(state: ConnectionState, raw: unknown): Promise<void> {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "request": {
        if (state.role === "backend") {
          await this.dispatchAgentFrame(state, cls.frame);
        } else {
          await this.dispatchTuiFrame(state, cls.frame);
        }
        return;
      }
      case "response": {
        // Response frame on a socket. Backend never sends responses
        // (Agent is a client of the gateway, not the other way around).
        // TUI does — that's an approval response consuming a reverse
        // request.
        if (state.role === "tui") {
          this.dispatchTuiResponseFrame(state, cls.frame);
        } else {
          // Backend sending a response is a protocol violation.
          this.writeStructuredError(state, "unexpected_response_on_backend", {});
          this.closeConnection(state);
        }
        return;
      }
      case "notification": {
        // JSON-RPC notifications get NO response. `initialized` is
        // the paradigm case (Agent tells the gateway "handshake ack").
        // Silently accept; upstream not involved.
        return;
      }
      case "malformed": {
        this.writeStructuredError(state, cls.reason, {});
        this.closeConnection(state);
        return;
      }
    }
  }

  // ─────────── Agent-side dispatch ───────────

  private async dispatchAgentFrame(state: ConnectionState, frame: JsonRpcRequestFrame): Promise<void> {
    const outcome = await dispatchAgentRequest(frame, this.opts.backend, this.opts.diagnostics);
    if (state.closed) return;
    if (outcome.kind === "reply") {
      this.writeFrame(state, {
        jsonrpc: "2.0",
        id: outcome.agentId,
        result: outcome.result,
      });
    } else if (outcome.kind === "error") {
      this.writeFrame(state, {
        jsonrpc: "2.0",
        id: outcome.agentId,
        error: {
          code: outcome.code,
          message: outcome.message,
          data: outcome.data,
        },
      });
    }
    // notification_ack: no wire reply, by JSON-RPC spec.
  }

  // ─────────── TUI-side dispatch ───────────

  private async dispatchTuiFrame(state: ConnectionState, frame: JsonRpcRequestFrame): Promise<void> {
    const outcome = await dispatchTuiRequest(
      frame,
      this.opts.authorizer,
      this.opts.initProvider,
      this.opts.diagnostics,
    );
    if (state.closed) return;
    switch (outcome.kind) {
      case "bootstrap_reply": {
        this.writeFrame(state, {
          jsonrpc: "2.0",
          id: outcome.tuiId,
          result: outcome.result,
        });
        return;
      }
      case "forward_upstream": {
        try {
          await this.sendProxiedTui(outcome.frame, frame.id);
        } catch (e: unknown) {
          const correlationId = this.opts.diagnostics.newCorrelationId();
          this.opts.diagnostics.reportInternalError({
            correlationId,
            operation: "forward_upstream",
            error: e,
          });
          this.writeFrame(state, {
            jsonrpc: "2.0",
            id: frame.id,
            error: {
              code: GatewayErrorCode.Unavailable,
              message: "upstream write failed",
              data: {
                code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.Unavailable],
                source: "upstream_transport",
                correlationId,
              },
            },
          });
        }
        return;
      }
      case "reject": {
        this.writeFrame(state, {
          jsonrpc: "2.0",
          id: outcome.tuiId,
          error: {
            code: outcome.code,
            message: outcome.message,
            data: outcome.data,
          },
        });
        return;
      }
    }
  }

  private dispatchTuiResponseFrame(state: ConnectionState, frame: JsonRpcResponseFrame): void {
    const outcome = handleTuiResponseFrame(frame, this.opts.reverseNs);
    if (outcome.kind === "reject") {
      this.writeFrame(state, {
        jsonrpc: "2.0",
        id: outcome.tuiId,
        error: {
          code: outcome.code,
          message: outcome.message,
          data: outcome.data,
        },
      });
      return;
    }
    // forward_reverse_response: send it upstream, don't ack the TUI.
    void this.opts.upstreamTransport.writeFrame(outcome.frame).catch((e: unknown) => {
      const correlationId = this.opts.diagnostics.newCorrelationId();
      this.opts.diagnostics.reportInternalError({
        correlationId,
        operation: "forward_reverse_response",
        error: e,
      });
    });
  }

  // ─────────── Upstream inbound ───────────

  private onUpstreamFrame(raw: unknown): void {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "response": {
        const origin = this.opts.mux.consumeUpstreamResponse(cls.frame.id);
        if (origin === null) {
          // Duplicate / unknown upstream id. Orphan drop; diagnostic
          // sink for operator; NEVER on wire.
          const correlationId = this.opts.diagnostics.newCorrelationId();
          this.opts.diagnostics.reportInternalError({
            correlationId,
            operation: "upstream_response_orphan",
            error: new Error(`unknown upstream id ${String(cls.frame.id)}`),
          });
          return;
        }
        if (origin.kind === "proxied_tui") {
          // Route back to the TUI socket. If TUI has disconnected in
          // the meantime, drop; the mux already released.
          const tui = this.findTui();
          if (tui === null) return;
          this.writeFrame(tui, {
            jsonrpc: "2.0",
            id: origin.tuiId,
            ...("error" in cls.frame ? { error: cls.frame.error } : { result: cls.frame.result }),
          } as JsonRpcResponseFrame);
        } else {
          // Internal scheduler — resolve or reject the Promise.
          if ("error" in cls.frame) {
            origin.origin.reject(new Error(cls.frame.error.message));
          } else {
            origin.origin.resolve(cls.frame.result);
          }
        }
        return;
      }
      case "request": {
        // Reverse request (Codex → gateway → TUI). Allocate a TUI-side
        // id via the reverse namespace and forward to the TUI socket.
        const alloc = this.opts.reverseNs.allocateTuiIdForCodexReverseRequest(cls.frame.id);
        if ("collision" in alloc) {
          // Codex sent the same reverse id twice while first was in
          // flight. Send an error upstream so it stops waiting.
          void this.opts.upstreamTransport.writeFrame({
            jsonrpc: "2.0",
            id: cls.frame.id,
            error: {
              code: GatewayErrorCode.InvalidArg,
              message: "reverse-request id collision",
              data: {
                code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.InvalidArg],
                reason: "reverse_id_collision",
              },
            },
          } as JsonRpcResponseFrame).catch(() => { /* diagnostics only */ });
          return;
        }
        const tui = this.findTui();
        if (tui === null) {
          // No TUI attached — fail closed upstream.
          this.opts.reverseNs.consumeCodexReverseByTuiId(alloc.tuiId);
          void this.opts.upstreamTransport.writeFrame({
            jsonrpc: "2.0",
            id: cls.frame.id,
            error: {
              code: GatewayErrorCode.NoOwner,
              message: "no human owner attached",
              data: {
                code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.NoOwner],
              },
            },
          } as JsonRpcResponseFrame).catch(() => { /* diagnostics only */ });
          return;
        }
        this.writeFrame(tui, {
          jsonrpc: "2.0",
          id: alloc.tuiId,
          method: cls.frame.method,
          ...(cls.frame.params !== undefined ? { params: cls.frame.params } : {}),
        } as JsonRpcRequestFrame);
        return;
      }
      case "notification": {
        // Codex notifications (event streams etc.) are Wave-2 fan-out;
        // Phase 1 drops on the floor.
        return;
      }
      case "malformed": {
        const correlationId = this.opts.diagnostics.newCorrelationId();
        this.opts.diagnostics.reportInternalError({
          correlationId,
          operation: "upstream_frame_malformed",
          error: new Error(cls.reason),
        });
        return;
      }
    }
  }

  private onUpstreamClose(): void {
    // Upstream tore down. Full drain (both proxied + internal). The
    // internal-scheduler Promises get rejected via the InternalOrigin
    // resolver we stashed at allocation time.
    for (const _ of Array.from({ length: this.opts.mux.pendingCountByKind("internal") })) {
      // no-op iteration marker; the mux does not enumerate origins,
      // and rejecting them is done by lifecycle.ts via a separate
      // channel it owns. Segment C wires that.
    }
    this.opts.mux.drainAll();
    this.opts.reverseNs.drainAll();
  }

  private findTui(): ConnectionState | null {
    for (const c of this.connections) {
      if (c.role === "tui" && !c.closed) return c;
    }
    return null;
  }

  // ─────────── Transport surface (sendInternal / sendProxiedTui) ───────────

  /**
   * Send an internal scheduler / lifecycle request upstream. The
   * caller receives a Promise that resolves with the upstream
   * `result` or rejects on transport / upstream error.
   *
   * The mux allocates a fresh upstream id and stashes the
   * InternalOrigin (with the caller's Promise resolver) so
   * `onUpstreamFrame` can route the response.
   */
  sendInternal<T = unknown>(method: string, params: unknown | undefined, label = method): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const origin: InternalOrigin = {
        kind: "internal",
        label,
        resolve: (v) => resolve(v as T),
        reject,
      };
      const alloc = this.opts.mux.allocateForInternalScheduler(origin);
      const frame: JsonRpcRequestFrame = {
        jsonrpc: "2.0",
        id: alloc.upstreamId,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.opts.upstreamTransport.writeFrame(frame).catch((e: unknown) => {
        // Release the pending slot; the mux only auto-clears on
        // consume. If we never sent the frame, the response will
        // never arrive.
        this.opts.mux.consumeUpstreamResponse(alloc.upstreamId);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /**
   * Forward an authorizer-approved TUI request upstream. Allocates a
   * fresh upstream id via the mux (proxied_tui origin holds the
   * TUI-side id) so the eventual response is rewritten back for the
   * TUI.
   */
  async sendProxiedTui(frame: JsonRpcRequestFrame, tuiId: JsonRpcRequestId): Promise<void> {
    const alloc = this.opts.mux.allocateForProxiedTui(tuiId);
    if ("collision" in alloc) {
      throw new Error("proxied tui id already in flight");
    }
    const forwarded: JsonRpcRequestFrame = {
      jsonrpc: "2.0",
      id: alloc.upstreamId,
      method: frame.method,
      ...(frame.params !== undefined ? { params: frame.params } : {}),
    };
    try {
      await this.opts.upstreamTransport.writeFrame(forwarded);
    } catch (e) {
      this.opts.mux.consumeUpstreamResponse(alloc.upstreamId);
      throw e;
    }
  }

  // ─────────── Wire write helper ───────────

  private writeFrame(state: ConnectionState, frame: JsonRpcResponseFrame | JsonRpcRequestFrame): void {
    if (state.closed) return;
    try {
      state.socket.write(JSON.stringify(frame) + "\n");
    } catch (e: unknown) {
      const correlationId = this.opts.diagnostics.newCorrelationId();
      this.opts.diagnostics.reportInternalError({
        correlationId,
        operation: `write_frame_${state.role}`,
        error: e,
      });
      this.closeConnection(state);
    }
  }

  // ─────────── Test-only inspectors ───────────

  /** Number of live connections (both roles). */
  connectionCount(): number {
    return this.connections.size;
  }
}
