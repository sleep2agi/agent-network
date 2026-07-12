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
import * as crypto from "node:crypto";
import {
  classifyMessage,
  dispatchAgentRequest,
  dispatchTuiRequest,
  UpstreamRequestMux,
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
import { HumanOwnerCoordinator } from "./human-owner";

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
 * Hard cap on concurrent connections PER role. Phase 1 is single-
 * owner: one Agent client + one TUI owner. A second connection on
 * the same role is refused at accept time — the incumbent stays
 * untouched (previously a second TUI could hijack findTui and drain
 * the incumbent's pending on disconnect).
 */
export const DEFAULT_MAX_CONNECTIONS_PER_ROLE = 1;

/**
 * Default handshake timeout. A newly-accepted connection has this
 * long to send its first frame (`gateway.hello` with the launcher-
 * provisioned capability) before the connection is destroyed with a
 * structured `handshake_required` reject. 3s is comfortably long for
 * any local launcher hand-off and short enough to reject slow-loris.
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 3_000;

/**
 * The method name for the capability handshake frame. Chosen so that
 * a stray client that skips the handshake and jumps straight into
 * JSON-RPC will see the frame classified against `AGENT_ALLOWED_
 * METHODS` and land on `UnknownMethod` — not silently accepted.
 */
export const GATEWAY_HELLO_METHOD = "gateway.hello";

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
  /**
   * Force-close the upstream transport. B owns the wire connection
   * (Codex app-server WS/UDS) and is responsible for terminating its
   * end. Called by `GatewayServer.stop()` / `GatewayLifecycle.stop()`
   * so shutdown is deterministic. MUST be idempotent — repeated
   * calls after the first resolve without error. After `close()`
   * resolves, any subsequent `writeFrame` is expected to reject.
   *
   * The transport SHOULD fire its `onClose` subscribers as part of
   * close (server internals rely on that hook to reject internal
   * pending); a transport that omits the notification will still
   * see server-side pending drained on `stop()` via belt-and-braces
   * settlement, but production transports should propagate the
   * signal properly.
   */
  close(): Promise<void>;
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

/**
 * Internal-pending bookkeeping entry. GatewayServer keeps a Map of
 * these keyed on upstream id so `stop()` and `onUpstreamClose()` can
 * reject any un-settled sendInternal Promises with a stable reason
 * BEFORE calling `mux.drainAll()`. The `settled` flag makes the
 * response-vs-close race terminate exactly once.
 */
interface InternalPendingEntry {
  readonly upstreamId: number;
  readonly origin: InternalOrigin;
  settled: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// GatewayServerOptions
// ────────────────────────────────────────────────────────────────────────

export interface GatewayServerLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  /** Hard cap on concurrent connections PER role (backend and TUI
   *  each). Default 1 — Phase 1 is single-owner. */
  readonly maxConnectionsPerRole: number;
  /** Handshake timeout in ms — a new connection must present its
   *  capability within this window or be destroyed. */
  readonly helloTimeoutMs: number;
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
  /**
   * SOLE holder of the reverse-request namespace + TUI attach/detach
   * lifecycle. GatewayServer no longer touches ReverseRequestNamespace
   * directly — all reverse-request routing, TUI attach on successful
   * hello, and TUI detach on close now go through this coordinator.
   * This is what makes `approvalMode="never"` actually enforced on
   * the wire (previously the server bypassed it and forwarded
   * approvals to the TUI regardless).
   */
  readonly humanOwner: HumanOwnerCoordinator;
  /** Injected upstream Codex transport. B owns; tests fake. */
  readonly upstreamTransport: UpstreamTransport;
  readonly initProvider: TuiInitializeProvider;
  readonly diagnostics: ProtocolDiagnostics;
  readonly authorizer: TuiRequestAuthorizer;
  readonly backend: ProtocolBackend;
  /**
   * Launcher-provisioned high-entropy capability for the BACKEND
   * (Agent) socket. Any client connecting to the backend UDS MUST
   * present this exact string in a `gateway.hello` first frame; a
   * missing / wrong / cross-role capability is refused with a
   * structured error and the connection is destroyed. Constant-time
   * compare via SHA-256 digest so the reject path leaks no timing
   * information. NEVER echo the received value into diagnostics or
   * onto the wire.
   */
  readonly backendCapability: string;
  /** Same as `backendCapability` for the TUI socket. Distinct high-
   *  entropy string so a compromised Agent capability cannot be
   *  presented on the TUI socket to impersonate a human owner. */
  readonly tuiCapability: string;
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

type ConnectionPhase = "awaiting_hello" | "authenticated";

interface ConnectionState {
  readonly role: SocketRole;
  readonly socket: net.Socket;
  readonly framer: LineFramer;
  phase: ConnectionPhase;
  /** Set on accept, cleared once hello succeeds or connection closes. */
  helloTimer: NodeJS.Timeout | null;
  closed: boolean;
}

/** Precomputed SHA-256 digest of the expected capability, so constant-
 *  time compare doesn't operate on the plaintext secret. Length-normalised
 *  32-byte buffer either way; timingSafeEqual works on equal-length
 *  buffers by definition. */
function digestCapability(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export class GatewayServer {
  private readonly opts: GatewayServerOptions;
  private readonly limits: GatewayServerLimits;
  private readonly backendCapabilityDigest: Buffer;
  private readonly tuiCapabilityDigest: Buffer;

  private backendServer: net.Server | null = null;
  private tuiServer: net.Server | null = null;

  private readonly connections = new Set<ConnectionState>();
  private readonly connectionsByRole = new Map<SocketRole, number>();
  private readonly createdPaths: CreatedPath[] = [];
  private upstreamUnsubs: Array<() => void> = [];
  private running = false;
  private shuttingDown = false;

  /**
   * Live sendInternal Promises keyed on upstream id. Used to reject
   * exactly once on stop / upstream-close / write-fail, then release.
   * A response-arrival that races the close terminates the entry
   * first via the `settled` flag; the drain pass observes `settled`
   * and skips.
   */
  private readonly internalPending = new Map<number, InternalPendingEntry>();

  constructor(opts: GatewayServerOptions) {
    this.opts = opts;
    this.limits = {
      maxFrameBytes: opts.limits?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxBufferedBytes: opts.limits?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      maxConnectionsPerRole: opts.limits?.maxConnectionsPerRole ?? DEFAULT_MAX_CONNECTIONS_PER_ROLE,
      helloTimeoutMs: opts.limits?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    };
    // Refuse empty / low-entropy capabilities at construction time —
    // an unset launcher secret is a fail-closed situation and we
    // shouldn't even reach start().
    if (typeof opts.backendCapability !== "string" || opts.backendCapability.length < 32) {
      throw new Error("backendCapability must be a non-empty string of at least 32 chars");
    }
    if (typeof opts.tuiCapability !== "string" || opts.tuiCapability.length < 32) {
      throw new Error("tuiCapability must be a non-empty string of at least 32 chars");
    }
    if (opts.backendCapability === opts.tuiCapability) {
      throw new Error("backendCapability and tuiCapability MUST be distinct");
    }
    this.backendCapabilityDigest = digestCapability(opts.backendCapability);
    this.tuiCapabilityDigest = digestCapability(opts.tuiCapability);
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
      // P0 fix (副指挥 9936fe24 item #7): upstream subscribe is
      // inside the try. If the transport throws during subscribe
      // (bad handler, weird state), rollback closes the already-
      // bound UDS servers instead of leaving them accepting.
      this.upstreamUnsubs.push(this.opts.upstreamTransport.onFrame((raw) => this.onUpstreamFrame(raw)));
      this.upstreamUnsubs.push(this.opts.upstreamTransport.onClose(() => this.onUpstreamClose()));
    } catch (e) {
      // Roll back: close any listening servers, unlink anything we
      // made, revoke any subscriptions that landed before the throw.
      await this.rollbackStart();
      throw e;
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.shuttingDown = true;

    for (const un of this.upstreamUnsubs) {
      try { un(); } catch { /* no-op */ }
    }
    this.upstreamUnsubs = [];

    // P0 fix (副指挥 9936fe24 item #4): reject un-settled internal
    // sendInternal Promises exactly once with a stable reason BEFORE
    // draining the mux. drainAll would otherwise erase the entries
    // without ever notifying callers.
    this.rejectAllInternalPending("gateway_stopping");

    for (const c of this.connections) {
      if (!c.closed) {
        c.closed = true;
        if (c.helloTimer !== null) { clearTimeout(c.helloTimer); }
        try { c.socket.destroy(); } catch { /* no-op */ }
      }
    }
    this.connections.clear();
    this.connectionsByRole.clear();

    await this.closeServer(this.backendServer);
    this.backendServer = null;
    await this.closeServer(this.tuiServer);
    this.tuiServer = null;

    // Belt-and-braces — any origin still lingering (should be none
    // after rejectAllInternalPending) is cleared here so the mux is
    // fresh for a subsequent instance.
    this.opts.mux.drainAll();
    // Detach delegates the reverseNs drain via the coordinator, so
    // A layer stays the sole caller of that surface.
    this.opts.humanOwner.detachTui();

    this.cleanupCreatedPaths();
  }

  private async rollbackStart(): Promise<void> {
    // Revoke any upstream subscriptions that made it in before the
    // throw. If none are present the loop is a no-op.
    for (const un of this.upstreamUnsubs) {
      try { un(); } catch { /* no-op */ }
    }
    this.upstreamUnsubs = [];
    await this.closeServer(this.backendServer);
    this.backendServer = null;
    await this.closeServer(this.tuiServer);
    this.tuiServer = null;
    this.cleanupCreatedPaths();
  }

  /**
   * P0 fix (副指挥 9936fe24 item #4). Iterate the pending map,
   * reject each Promise exactly once (guarded by `settled`), remove
   * it from the map. The mux is drained by the caller after.
   */
  private rejectAllInternalPending(reason: string): void {
    for (const [, entry] of this.internalPending) {
      if (entry.settled) continue;
      entry.settled = true;
      try {
        entry.origin.reject(new Error(reason));
      } catch (e: unknown) {
        // Even the caller's reject shouldn't throw, but if it does
        // we absorb it — one bad Promise resolver can't cascade.
        try {
          this.opts.diagnostics.reportInternalError({
            correlationId: this.opts.diagnostics.newCorrelationId(),
            operation: "reject_internal_pending",
            error: e,
          });
        } catch { /* silent */ }
      }
    }
    this.internalPending.clear();
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
    // P0 fix (副指挥 9936fe24 item #2): per-role hard cap enforced
    // BEFORE we allocate any state. Phase 1 default is one owner per
    // role — a second connection is destroyed without touching the
    // incumbent. Previously the aggregate cap of 8 let a second TUI
    // land, race findTui, and drain the incumbent's proxied pending
    // on disconnect.
    const currentInRole = this.connectionsByRole.get(role) ?? 0;
    if (currentInRole >= this.limits.maxConnectionsPerRole || this.shuttingDown) {
      socket.destroy();
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "accept_connection",
          error: new Error(
            this.shuttingDown
              ? `refused new connection on role=${role}: server shutting down`
              : `role=${role} max_connections_per_role=${this.limits.maxConnectionsPerRole} exceeded`,
          ),
        });
      } catch { /* silent */ }
      return;
    }

    const framer = new LineFramer(this.limits.maxFrameBytes, this.limits.maxBufferedBytes);
    const state: ConnectionState = {
      role, socket, framer,
      phase: "awaiting_hello",
      helloTimer: null,
      closed: false,
    };

    // P0 fix (副指挥 9936fe24 item #1): before we register a data
    // handler that dispatches JSON-RPC, arm a hello timeout. A peer
    // that never sends the capability frame is destroyed with a
    // structured `handshake_required` reject.
    state.helloTimer = setTimeout(() => {
      if (state.closed || state.phase !== "awaiting_hello") return;
      this.writeStructuredError(state, "handshake_required", {
        limitMs: this.limits.helloTimeoutMs,
      });
      this.closeConnection(state);
    }, this.limits.helloTimeoutMs);
    // Never keep the process alive just for the handshake timer.
    state.helloTimer.unref?.();

    this.connections.add(state);
    this.connectionsByRole.set(role, currentInRole + 1);

    socket.on("data", (chunk: Buffer) => this.onData(state, chunk));
    socket.on("close", () => this.closeConnection(state));
    socket.on("error", () => {
      // Errors during the connection life are terminal; close.
      // The raw error message is NEVER surfaced — sent to diagnostics.
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: `socket_error_${role}`,
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
    const cur = this.connectionsByRole.get(state.role) ?? 0;
    this.connectionsByRole.set(state.role, Math.max(0, cur - 1));
    if (state.helloTimer !== null) {
      clearTimeout(state.helloTimer);
      state.helloTimer = null;
    }
    try { state.socket.destroy(); } catch { /* no-op */ }

    // P0 fix (副指挥 9936fe24 item #3): TUI drain goes THROUGH the
    // coordinator, not the raw reverse namespace. Coordinator owns
    // reverseNs + does drainProxiedTui + drainAll on reverseNs
    // atomically. Only fire on a connection that had actually
    // authenticated as TUI — otherwise a spurious handshake failure
    // could detach an unrelated incumbent (which shouldn't be
    // possible under per-role cap of 1, but belt-and-braces).
    if (state.role === "tui" && state.phase === "authenticated") {
      this.opts.humanOwner.detachTui();
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
      if (state.phase === "awaiting_hello") {
        this.handleHelloFrame(state, ev.raw);
        continue;
      }
      void this.onFrame(state, ev.raw);
    }
  }

  /**
   * P0 fix (副指挥 9936fe24 item #1): the very first frame on a new
   * connection must be a `gateway.hello` bearing the launcher-
   * provisioned capability for the connection's role. Anything else
   * — wrong shape, missing capability, wrong-role capability, second
   * hello — is a structured refusal + disconnect.
   *
   * `crypto.timingSafeEqual` operates on equal-length buffers (SHA-
   * 256 digests are always 32 bytes) so the reject path leaks no
   * timing information about the received value.
   *
   * The received capability is NEVER echoed to diagnostics or the
   * wire; only stable reason strings + connection role.
   */
  private handleHelloFrame(state: ConnectionState, raw: unknown): void {
    // Shape guard: must be a JSON object with `method === "gateway.hello"`
    // and `params.capability: string`.
    let capability: string | null = null;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.method === GATEWAY_HELLO_METHOD && typeof obj.params === "object" && obj.params !== null) {
        const p = obj.params as Record<string, unknown>;
        if (typeof p.capability === "string") {
          capability = p.capability;
        }
      }
    }
    if (capability === null) {
      this.writeStructuredError(state, "handshake_required", { role: state.role });
      this.closeConnection(state);
      return;
    }
    // Compare against the expected digest for THIS role. Wrong-role
    // capability (backend cap presented on TUI socket, or vice
    // versa) lands here too.
    const receivedDigest = digestCapability(capability);
    const expectedDigest = state.role === "backend"
      ? this.backendCapabilityDigest
      : this.tuiCapabilityDigest;
    // timingSafeEqual on 32-byte SHA-256 digests is constant-time.
    let ok = false;
    try {
      ok = crypto.timingSafeEqual(receivedDigest, expectedDigest);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.writeStructuredError(state, "capability_invalid", { role: state.role });
      this.closeConnection(state);
      return;
    }

    // Success. Clear the hello timer, mark authenticated, and if
    // this is a TUI socket, attach the human owner. The Agent
    // (backend) side has no attach semantics — the backend
    // connection is a stateless RPC channel from the coordinator's
    // point of view.
    if (state.helloTimer !== null) {
      clearTimeout(state.helloTimer);
      state.helloTimer = null;
    }
    state.phase = "authenticated";
    if (state.role === "tui") {
      this.opts.humanOwner.attachTui();
    }
    // No wire reply — hello is a one-shot handshake, silence-means-
    // accepted. A reply would let a probe distinguish "accepted"
    // from "closed with reject frame" via wire semantics; keeping it
    // silent narrows the differential.
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
    // P0 fix (副指挥 9936fe24 item #3): delegate to coordinator so
    // the reverse namespace is only consumed through the sole owner.
    const outcome = this.opts.humanOwner.handleTuiResponseFrame(frame);
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
      try {
        const correlationId = this.opts.diagnostics.newCorrelationId();
        this.opts.diagnostics.reportInternalError({
          correlationId,
          operation: "forward_reverse_response",
          error: e,
        });
      } catch { /* silent */ }
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
          // P0 fix (副指挥 9936fe24 item #4): the `settled` flag
          // guarantees a response arriving concurrently with a
          // stop / upstream-close only terminates the Promise once.
          const upstreamNumericId = typeof cls.frame.id === "number" ? cls.frame.id : -1;
          const entry = upstreamNumericId >= 0 ? this.internalPending.get(upstreamNumericId) : undefined;
          if (entry === undefined || entry.settled) {
            // Already settled by close-path; drop.
            return;
          }
          entry.settled = true;
          this.internalPending.delete(upstreamNumericId);
          if ("error" in cls.frame) {
            origin.origin.reject(new Error(cls.frame.error.message));
          } else {
            origin.origin.resolve(cls.frame.result);
          }
        }
        return;
      }
      case "request": {
        // P0 fix (副指挥 9936fe24 item #3): all reverse-request
        // decisions flow through the coordinator. Phase 1
        // (approvalMode="never") therefore ALWAYS produces a
        // reject_upstream frame with reason=approval_mode_never —
        // even if a TUI happens to be attached. Previously we
        // bypassed the coordinator and passed the request straight
        // to the TUI regardless of approval mode.
        const decision = this.opts.humanOwner.handleUpstreamReverseRequest(cls.frame);
        if (decision.kind === "reject_upstream") {
          void this.opts.upstreamTransport.writeFrame(decision.upstreamError).catch((e: unknown) => {
            try {
              this.opts.diagnostics.reportInternalError({
                correlationId: this.opts.diagnostics.newCorrelationId(),
                operation: "upstream_reject_write",
                error: e,
              });
            } catch { /* silent */ }
          });
          return;
        }
        // forward_tui — coordinator already allocated the TUI-side
        // id via its own reverseNs; we just write the frame.
        const tui = this.findTui();
        if (tui === null) {
          // Shouldn't happen: coordinator only produces forward_tui
          // when TUI is attached. Belt-and-braces: log + drop; the
          // reverseNs entry will be leaked until drainAll, which is
          // acceptable because attachTui/detachTui are the only
          // callers here.
          try {
            this.opts.diagnostics.reportInternalError({
              correlationId: this.opts.diagnostics.newCorrelationId(),
              operation: "forward_tui_no_incumbent",
              error: new Error("coordinator produced forward_tui but no TUI connection is authenticated"),
            });
          } catch { /* silent */ }
          return;
        }
        this.writeFrame(tui, decision.tuiFrame);
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
    // P0 fix (副指挥 9936fe24 item #4): reject un-settled internal
    // sendInternal Promises exactly once with a stable reason BEFORE
    // draining the mux. drainAll would erase the entries without
    // ever notifying callers.
    this.rejectAllInternalPending("upstream_closed");
    this.opts.mux.drainAll();
    // Reverse namespace is owned by the coordinator; detachTui does
    // the drain there too.
    this.opts.humanOwner.detachTui();
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
      if (this.shuttingDown || !this.running) {
        reject(new Error("gateway_stopping"));
        return;
      }
      const origin: InternalOrigin = {
        kind: "internal",
        label,
        resolve: (v) => resolve(v as T),
        reject,
      };
      const alloc = this.opts.mux.allocateForInternalScheduler(origin);
      // P0 fix (副指挥 9936fe24 item #4): record the pending entry so
      // stop() / upstream-close can reject once. `settled` guards the
      // response-vs-close race.
      const entry: InternalPendingEntry = {
        upstreamId: alloc.upstreamId,
        origin,
        settled: false,
      };
      this.internalPending.set(alloc.upstreamId, entry);
      const frame: JsonRpcRequestFrame = {
        jsonrpc: "2.0",
        id: alloc.upstreamId,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.opts.upstreamTransport.writeFrame(frame).catch((e: unknown) => {
        // Write-fail: release the mux slot AND reject exactly once
        // through the settled-flag guard.
        this.opts.mux.consumeUpstreamResponse(alloc.upstreamId);
        if (!entry.settled) {
          entry.settled = true;
          this.internalPending.delete(alloc.upstreamId);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
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
