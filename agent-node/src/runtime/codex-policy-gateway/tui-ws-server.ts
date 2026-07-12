// RFC-030 Wave 1A P0.2 Commit 1 corrective — tui-ws-server.ts
//
// Native Codex TUI WebSocket admission surface. Wraps a `node:http`
// server that accepts ONE WebSocket Upgrade to `/` (per real 0.144.0
// captured baseline; 副指挥 967a0010) after:
//   - the admission checks in `admission.ts` pass;
//   - `Sec-WebSocket-Key` is validated as a real RFC 6455 nonce
//     (exactly one raw header, decodes to exactly 16 bytes);
//   - the `TuiBearer.presentBearer` returns `ok`;
//   - the owner slot's synchronous PROVISIONAL reserve succeeds; and
//   - `wsServer.handleUpgrade` completes the WS handshake.
//
// Corrective fixes vs 9e6706c (副指挥 a1ed1589):
//   - Pre-auth raw sockets are tracked in an explicit `Map<Socket,
//     Timeout>` and untracked synchronously from the http.Server's
//     'upgrade' event — NOT from a nonexistent `socket.on("upgrade")`.
//     A successful owner is never left in the preauth set, so the
//     3s timer can never destroy an active WS.
//   - `Sec-WebSocket-Key` is checked upfront (uniform 400 body).
//     Missing / duplicate / bad-length key: 0 bearer consume, owner
//     empty, human unattached.
//   - Owner reservation is provisional. Any post-reserve failure
//     (handleUpgrade throw, socket close before callback, WS error
//     inside callback) rolls back to `empty` for THAT lease only.
//     No `held + ws=null` state exists.
//   - Sole upstream frame router: `Codex reverse request` -> always
//     goes through the `HumanOwnerCoordinator`. Under Phase 1
//     approvalMode=never it writes back the original codex id with
//     `NoOwner + reason=approval_mode_never` (0 TUI forward).
//   - Removed the `text.length > TUI_WS_SEMANTIC_TEXT_CAP * 8`
//     junk gate (副指挥 a1ed1589 self-check reply). The frozen
//     Agent-side 128 KiB semantic cap is NOT applied at the TUI WS
//     face; TUI wire size is bounded by `maxPayload` = 1 MiB only.

import * as http from "node:http";
import type { Socket } from "node:net";
import type { WebSocket, WebSocketServer as WsServerType } from "ws";
import { WebSocketServer } from "ws";

import {
  ALLOWED_LOOPBACK,
  decideAdmission,
  writeGenericReject,
} from "./admission";
import { TuiBearer } from "./bearer";
import {
  asOwnerLeaseId,
  GATEWAY_ERROR_DATA_CODE,
  GatewayErrorCode,
  type OwnerLeaseId,
} from "./contract";
import {
  classifyMessage,
  dispatchTuiRequest,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type ProtocolDiagnostics,
  type TuiInitializeProvider,
  type TuiRequestAuthorizer,
} from "./protocol";
import { HumanOwnerCoordinator } from "./human-owner";
import * as crypto from "node:crypto";

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

export const TUI_WS_MAX_PAYLOAD = 1 * 1024 * 1024;
export const TUI_HTTP_HEADER_TIMEOUT_MS = 3_000;
export const TUI_MAX_PREAUTH_SOCKETS = 8;

// ────────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────────

export interface TuiWsServerOptions {
  readonly bearer: TuiBearer;
  readonly humanOwner: HumanOwnerCoordinator;
  readonly authorizer: TuiRequestAuthorizer;
  readonly initProvider: TuiInitializeProvider;
  readonly diagnostics: ProtocolDiagnostics;
  readonly maxPayload?: number;
  readonly headerTimeoutMs?: number;
  readonly maxPreAuthSockets?: number;
}

// ────────────────────────────────────────────────────────────────────────
// TuiWsServer
// ────────────────────────────────────────────────────────────────────────

type OwnerState =
  | { readonly kind: "empty" }
  | { readonly kind: "reserved"; readonly leaseId: OwnerLeaseId }
  | { readonly kind: "held"; readonly leaseId: OwnerLeaseId; readonly ws: WebSocket };

export class TuiWsServer {
  private readonly opts: TuiWsServerOptions;
  private httpServer: http.Server | null = null;
  private wsServer: WsServerType | null = null;
  private boundPort = 0;
  private ownerSlot: OwnerState = { kind: "empty" };
  /**
   * Explicit map of preauth raw sockets -> their header timeout timer.
   * A socket is added on http.Server 'connection' and REMOVED
   * synchronously on the http.Server 'upgrade' event (via
   * `untrackPreAuthSocket`). Never listen to a non-existent
   * `socket.on("upgrade")` — that's the 9e6706c bug.
   */
  private readonly preAuthTimers: Map<Socket, NodeJS.Timeout> = new Map();
  private running = false;
  private shuttingDown = false;

  constructor(opts: TuiWsServerOptions) {
    this.opts = opts;
  }

  // ─────────── Lifecycle ───────────

  async start(): Promise<void> {
    if (this.running) throw new Error("TuiWsServer already running");
    const httpServer = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not_found");
    });
    httpServer.on("connection", (socket: Socket) => this.trackPreAuthSocket(socket));
    httpServer.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as Socket, head));

    const wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.opts.maxPayload ?? TUI_WS_MAX_PAYLOAD,
      perMessageDeflate: false,
    });

    this.httpServer = httpServer;
    this.wsServer = wsServer;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        httpServer.off("error", onError);
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("http.Server.address() returned unexpected shape"));
          return;
        }
        if (addr.address !== ALLOWED_LOOPBACK) {
          reject(new Error(`bind assertion failed: OS returned '${addr.address}', expected ${ALLOWED_LOOPBACK}`));
          return;
        }
        if (addr.family !== "IPv4") {
          reject(new Error(`bind assertion failed: OS returned family '${addr.family}', expected IPv4`));
          return;
        }
        this.boundPort = addr.port;
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListen);
      httpServer.listen({ host: ALLOWED_LOOPBACK, port: 0 });
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running && this.httpServer === null) return;
    this.shuttingDown = true;
    this.running = false;
    try { this.opts.bearer.rotate(); } catch { /* silent */ }
    if (this.ownerSlot.kind === "held") {
      const held = this.ownerSlot;
      this.ownerSlot = { kind: "empty" };
      try { held.ws.close(1001, "gateway_stopping"); } catch { /* silent */ }
      try { this.opts.humanOwner.detachTui(held.leaseId); } catch { /* silent */ }
    } else if (this.ownerSlot.kind === "reserved") {
      // Reserved but not yet held — release the coordinator side as
      // well, defensively, and empty the slot.
      const leaseId = this.ownerSlot.leaseId;
      this.ownerSlot = { kind: "empty" };
      try { this.opts.humanOwner.detachTui(leaseId); } catch { /* silent */ }
    }
    for (const [s, t] of this.preAuthTimers) {
      try { clearTimeout(t); } catch { /* silent */ }
      try { s.destroy(); } catch { /* silent */ }
    }
    this.preAuthTimers.clear();
    if (this.wsServer !== null) {
      try { this.wsServer.close(); } catch { /* silent */ }
      this.wsServer = null;
    }
    if (this.httpServer !== null) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  boundPortActual(): number { return this.boundPort; }
  ownerSlotState(): "empty" | "reserved" | "held" { return this.ownerSlot.kind; }
  currentLease(): OwnerLeaseId | null {
    return this.ownerSlot.kind === "held" || this.ownerSlot.kind === "reserved"
      ? this.ownerSlot.leaseId : null;
  }

  /** Diagnostics inspector — how many raw sockets are waiting for
   *  Upgrade completion right now. */
  preAuthCount(): number { return this.preAuthTimers.size; }

  // ─────────── Pre-auth socket tracking ───────────

  private trackPreAuthSocket(socket: Socket): void {
    const maxPre = this.opts.maxPreAuthSockets ?? TUI_MAX_PREAUTH_SOCKETS;
    if (this.preAuthTimers.size >= maxPre || this.shuttingDown) {
      try { socket.destroy(); } catch { /* silent */ }
      this.reportInternal("preauth_socket_cap_exceeded", {});
      return;
    }
    const headerTimeoutMs = this.opts.headerTimeoutMs ?? TUI_HTTP_HEADER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // Only fires if the socket is still preauth. Once we call
      // `untrackPreAuthSocket` in `onUpgrade`, the entry is gone and
      // this callback never runs for an authenticated socket.
      if (this.preAuthTimers.has(socket)) {
        this.preAuthTimers.delete(socket);
        try { socket.destroy(); } catch { /* silent */ }
      }
    }, headerTimeoutMs);
    timer.unref?.();
    this.preAuthTimers.set(socket, timer);
    socket.once("close", () => this.untrackPreAuthSocket(socket));
  }

  private untrackPreAuthSocket(socket: Socket): void {
    const timer = this.preAuthTimers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.preAuthTimers.delete(socket);
    }
  }

  // ─────────── Sec-WebSocket-Key validation ───────────

  private validateSecWebSocketKey(req: http.IncomingMessage): { ok: true; key: string } | { ok: false; reason: string } {
    const raw = req.rawHeaders;
    let count = 0;
    let value: string | undefined;
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]?.toLowerCase() === "sec-websocket-key") {
        count++;
        value = raw[i + 1];
      }
    }
    if (count === 0) return { ok: false, reason: "ws_key_absent" };
    if (count > 1) return { ok: false, reason: "ws_key_multi_header" };
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: "ws_key_empty" };
    }
    // RFC 6455 §4.1: value is base64 of 16 random bytes. Node's
    // Buffer.from(..., "base64") is permissive; enforce the strict
    // shape ourselves.
    if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) {
      return { ok: false, reason: "ws_key_bad_shape" };
    }
    let decoded: Buffer;
    try { decoded = Buffer.from(value, "base64"); }
    catch { return { ok: false, reason: "ws_key_bad_base64" }; }
    if (decoded.length !== 16) return { ok: false, reason: "ws_key_bad_length" };
    return { ok: true, key: value };
  }

  // ─────────── Upgrade path ───────────

  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    // Item #1: synchronous untrack of the preauth timer. Any code path
    // that runs after this MUST NOT rely on the preauth timer.
    this.untrackPreAuthSocket(socket);

    // 1. Admission structural checks + bearer extraction.
    const admission = decideAdmission(req, socket, this.boundPort);
    if (admission.kind === "reject") {
      this.reportInternal(`admission_reject_${admission.reason}`, {});
      writeGenericReject(socket, admission.status);
      return;
    }
    // 1b. Item #2: Sec-WebSocket-Key validation BEFORE bearer.
    //     Missing / duplicate / bad-length key -> 0 bearer consume,
    //     0 owner-slot touch. Uniform 400 on the wire.
    const keyCheck = this.validateSecWebSocketKey(req);
    if (keyCheck.ok === false) {
      this.reportInternal(`ws_key_reject_${keyCheck.reason}`, {});
      writeGenericReject(socket, 400);
      return;
    }
    // 2. Bearer presentation.
    const bearerOutcome = this.opts.bearer.presentBearer(admission.bearer);
    if (bearerOutcome.kind === "reject") {
      this.reportInternal(`bearer_reject_${bearerOutcome.reason}`, {});
      writeGenericReject(socket, 401);
      return;
    }
    // 3. Owner slot check — uniform 401 wire body when full.
    if (this.ownerSlot.kind !== "empty") {
      this.reportInternal("owner_already_attached", {});
      writeGenericReject(socket, 401);
      return;
    }
    // 4. Provisional reserve BEFORE handleUpgrade. If anything past
    //    this point fails, we roll back to `empty` for THIS lease
    //    only (item #3: no `held+ws=null` state possible).
    const leaseId = mintOwnerLeaseId();
    this.ownerSlot = { kind: "reserved", leaseId };
    const wsServer = this.wsServer;
    if (wsServer === null) {
      this.rollbackReservation(leaseId);
      try { socket.destroy(); } catch { /* silent */ }
      return;
    }

    let handleUpgradeThrew = false;
    try {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        // If shutdown raced us, roll back.
        if (this.shuttingDown) {
          try { ws.close(1001, "gateway_stopping"); } catch { /* silent */ }
          this.rollbackReservation(leaseId);
          return;
        }
        // If the socket was already destroyed before the WS callback
        // fired, roll back.
        if (socket.destroyed) {
          try { ws.close(1006, "connection_lost_prehandshake"); } catch { /* silent */ }
          this.rollbackReservation(leaseId);
          return;
        }
        // If our reservation was torn down by another path (e.g. an
        // 'error' handler), we do NOT re-attach.
        if (this.ownerSlot.kind !== "reserved" || this.ownerSlot.leaseId !== leaseId) {
          try { ws.close(1006, "reservation_gone"); } catch { /* silent */ }
          return;
        }
        // Promote reserved -> held. Attach the coordinator via the
        // lease-aware attach. If the coordinator refuses (e.g. a
        // stale lease still held), we surface as diagnostics; but
        // in the current implementation attachTui with an already-
        // active lease is a no-op that logs — so we assert our own
        // state instead of trusting a caller-observable success signal.
        this.ownerSlot = { kind: "held", leaseId, ws };
        this.opts.humanOwner.attachTui(leaseId);
        if (this.opts.humanOwner.currentLease() !== leaseId) {
          // The coordinator refused our lease — treat as attach
          // failure and roll back.
          try { ws.close(1011, "attach_refused"); } catch { /* silent */ }
          this.ownerSlot = { kind: "empty" };
          return;
        }
        // Stop accepting new HTTP connections so a second peer can't
        // reach the Upgrade handler.
        try { this.httpServer?.close(); } catch { /* silent */ }
        this.wireOwnerSocket(ws, leaseId);
      });
    } catch (e) {
      handleUpgradeThrew = true;
      this.reportInternal("ws_handle_upgrade_throw", {});
      this.rollbackReservation(leaseId);
      try { socket.destroy(); } catch { /* silent */ }
    }
    // If handleUpgrade did NOT throw but never invoked the callback
    // (some ws versions silently drop malformed handshakes), we rely
    // on socket 'close' -> nothing to do here; the reserved slot
    // remains until the socket closes. But we should have a safety
    // net: destroy on close.
    if (!handleUpgradeThrew) {
      socket.once("close", () => {
        if (this.ownerSlot.kind === "reserved" && this.ownerSlot.leaseId === leaseId) {
          this.rollbackReservation(leaseId);
        }
      });
    }
  }

  private rollbackReservation(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind === "reserved" && this.ownerSlot.leaseId === leaseId) {
      this.ownerSlot = { kind: "empty" };
    }
    // Never call detachTui here — coordinator was not attachTui'd yet.
  }

  // ─────────── Wire path (post-Upgrade) ───────────

  private wireOwnerSocket(ws: WebSocket, leaseId: OwnerLeaseId): void {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        this.reportInternal("ws_binary_refused", {});
        try { ws.close(1003, "binary_unsupported"); } catch { /* silent */ }
        return;
      }
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.reportInternal("ws_invalid_json", {});
        try { ws.close(1007, "invalid_json"); } catch { /* silent */ }
        return;
      }
      void this.onFrame(parsed, ws, leaseId);
    });
    ws.on("close", () => this.onOwnerClose(leaseId));
    ws.on("error", () => this.onOwnerClose(leaseId));
  }

  private async onFrame(raw: unknown, ws: WebSocket, leaseId: OwnerLeaseId): Promise<void> {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "request":
        await this.dispatchTuiRequest(cls.frame, ws, leaseId);
        return;
      case "notification":
        return;
      case "response":
        this.dispatchTuiResponseFrame(cls.frame, ws, leaseId);
        return;
      case "malformed":
        try { ws.close(1008, "bad_shape"); } catch { /* silent */ }
        this.reportInternal(`ws_frame_malformed_${cls.reason}`, {});
        return;
    }
  }

  private async dispatchTuiRequest(
    frame: JsonRpcRequestFrame,
    ws: WebSocket,
    _leaseId: OwnerLeaseId,
  ): Promise<void> {
    const outcome = await dispatchTuiRequest(
      frame,
      this.opts.authorizer,
      this.opts.initProvider,
      this.opts.diagnostics,
    );
    switch (outcome.kind) {
      case "bootstrap_reply":
        this.writeFrame(ws, { jsonrpc: "2.0", id: outcome.tuiId, result: outcome.result });
        return;
      case "forward_upstream":
        // Wave 1A P0.2: no upstream TUI forward wired in this commit.
        this.writeFrame(ws, {
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: GatewayErrorCode.Unavailable,
            message: "tui forward_upstream not implemented in Wave 1A P0.2",
            data: {
              code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.Unavailable],
              reason: "wave1a_no_tui_forward",
            },
          },
        });
        return;
      case "reject":
        this.writeFrame(ws, {
          jsonrpc: "2.0",
          id: outcome.tuiId,
          error: { code: outcome.code, message: outcome.message, data: outcome.data },
        });
        return;
    }
  }

  private dispatchTuiResponseFrame(
    frame: JsonRpcResponseFrame,
    ws: WebSocket,
    leaseId: OwnerLeaseId,
  ): void {
    // Item #11: sole consume path is the lease-aware method.
    const outcome = this.opts.humanOwner.handleTuiResponseFrameWithLease(frame, leaseId);
    if (outcome.kind === "reject") {
      this.writeFrame(ws, {
        jsonrpc: "2.0",
        id: outcome.tuiId,
        error: { code: outcome.code, message: outcome.message, data: outcome.data },
      });
    }
    // On forward_reverse_response the frame is meant for upstream Codex;
    // Wave 1A P0.2 has no upstream transport in scope for this file.
    // The coordinator has already consumed the reverseNs entry.
  }

  private onOwnerClose(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind !== "held" || this.ownerSlot.leaseId !== leaseId) {
      return;
    }
    this.ownerSlot = { kind: "empty" };
    this.opts.humanOwner.detachTui(leaseId);
  }

  // ─────────── Helpers ───────────

  private writeFrame(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); }
    catch { this.reportInternal("ws_write_failed", {}); }
  }

  private reportInternal(operation: string, _extra: Record<string, unknown>): void {
    try {
      this.opts.diagnostics.reportInternalError({
        correlationId: this.opts.diagnostics.newCorrelationId(),
        operation,
        error: new Error(operation),
      });
    } catch { /* silent */ }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Lease minting — reuse frozen `asOwnerLeaseId` brand
// ────────────────────────────────────────────────────────────────────────

export function mintOwnerLeaseId(): OwnerLeaseId {
  const bytes = crypto.randomBytes(32);
  const value = bytes.toString("base64url");
  bytes.fill(0);
  return asOwnerLeaseId(value);
}
