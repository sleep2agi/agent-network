// RFC-030 Wave 1A P0.2 Commit 1 corrective round 3 — tui-ws-server.ts
//
// Native Codex TUI WebSocket admission surface. Corrective vs 3e62297
// (副指挥 1b24ae71):
//   - The WS server NO LONGER subscribes to `upstreamTransport`. The
//     lifecycle-owned `UpstreamRouter` is the sole upstream subscriber
//     and delivers reverse requests / proxied responses via the
//     `TuiForwardSeam` methods below.
//   - Hard-pinned constants (`maxPayload`, `headerTimeoutMs`,
//     `maxPreAuthSockets`) are TRULY HARD: no constructor overload,
//     no `_createForTest` factory, no runtime override. Tests use the
//     real production values.
//   - `currentLease()` accessor removed. The typed
//     `HumanOwnerCoordinator.attachTui` return covers what the server
//     needs; no external raw-lease read surface.
//   - HTTP listener stays OPEN after a successful attach. Concurrent
//     hard-1 is enforced by the `ownerSlot` synchronous check; a
//     detached owner can reattach (subject to the bearer being fresh
//     via the launcher — the launcher seam is Wave 2).
//   - `writeGenericReject` (admission.ts) continues to bound-destroy
//     the socket so allowHalfOpen peers can't pin the ledger.

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
// HARD-PINNED constants (副指挥 1b24ae71 P1)
// ────────────────────────────────────────────────────────────────────────

export const TUI_WS_MAX_PAYLOAD = 1 * 1024 * 1024;
export const TUI_HTTP_HEADER_TIMEOUT_MS = 3_000;
export const TUI_MAX_PREAUTH_SOCKETS = 8;

// ────────────────────────────────────────────────────────────────────────
// Options — production-facing (no overrides)
// ────────────────────────────────────────────────────────────────────────

export interface TuiWsServerOptions {
  readonly bearer: TuiBearer;
  readonly humanOwner: HumanOwnerCoordinator;
  readonly authorizer: TuiRequestAuthorizer;
  readonly initProvider: TuiInitializeProvider;
  readonly diagnostics: ProtocolDiagnostics;
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
      maxPayload: TUI_WS_MAX_PAYLOAD,
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
          reject(new Error(`bind assertion failed: OS returned '${addr.address}'`));
          return;
        }
        if (addr.family !== "IPv4") {
          reject(new Error(`bind assertion failed: OS returned family '${addr.family}'`));
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
      this.ownerSlot = { kind: "empty" };
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
  preAuthCount(): number { return this.preAuthTimers.size; }

  // ─────────── UpstreamRouter TuiForwardSeam ───────────
  // These two methods are called by the lifecycle-owned router when
  // it receives frames from the upstream transport. They return
  // `true` on successful delivery and `false` if the owner is gone.

  deliverReverseRequestToOwner(frame: unknown): boolean {
    if (this.ownerSlot.kind !== "held") return false;
    // 副指挥 06e92ef7 P1: writeFrame is best-effort under Node/ws.
    // If the send throws we MUST return false so the router logs
    // an orphan diagnostic instead of assuming delivery.
    return this.writeFrameStrict(this.ownerSlot.ws, frame);
  }

  deliverProxiedResponseToOwner(_tuiId: number | string, frame: JsonRpcResponseFrame): boolean {
    if (this.ownerSlot.kind !== "held") return false;
    return this.writeFrameStrict(this.ownerSlot.ws, frame);
  }

  // ─────────── Pre-auth socket tracking ───────────

  private trackPreAuthSocket(socket: Socket): void {
    if (this.preAuthTimers.size >= TUI_MAX_PREAUTH_SOCKETS || this.shuttingDown) {
      try { socket.destroy(); } catch { /* silent */ }
      this.reportInternal("preauth_socket_cap_exceeded");
      return;
    }
    const timer = setTimeout(() => {
      if (this.preAuthTimers.has(socket)) {
        this.preAuthTimers.delete(socket);
        try { socket.destroy(); } catch { /* silent */ }
      }
    }, TUI_HTTP_HEADER_TIMEOUT_MS);
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

  // ─────────── Sec-WebSocket-Key canonical check ───────────

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
    if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "ws_key_empty" };
    if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) return { ok: false, reason: "ws_key_bad_shape" };
    let decoded: Buffer;
    try { decoded = Buffer.from(value, "base64"); }
    catch { return { ok: false, reason: "ws_key_bad_base64" }; }
    if (decoded.length !== 16) return { ok: false, reason: "ws_key_bad_length" };
    const reencoded = decoded.toString("base64");
    if (reencoded !== value) return { ok: false, reason: "ws_key_noncanonical" };
    return { ok: true, key: value };
  }

  // ─────────── Upgrade path ───────────

  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const admission = decideAdmission(req, socket, this.boundPort);
    if (admission.kind === "reject") {
      this.reportInternal(`admission_reject_${admission.reason}`);
      writeGenericReject(socket, admission.status);
      return;
    }
    const keyCheck = this.validateSecWebSocketKey(req);
    if (keyCheck.ok === false) {
      this.reportInternal(`ws_key_reject_${keyCheck.reason}`);
      writeGenericReject(socket, 400);
      return;
    }
    const bearerOutcome = this.opts.bearer.presentBearer(admission.bearer);
    if (bearerOutcome.kind === "reject") {
      this.reportInternal(`bearer_reject_${bearerOutcome.reason}`);
      writeGenericReject(socket, 401);
      return;
    }
    if (this.ownerSlot.kind !== "empty") {
      this.reportInternal("owner_already_attached");
      writeGenericReject(socket, 401);
      return;
    }
    const leaseId = mintOwnerLeaseId();
    this.ownerSlot = { kind: "reserved", leaseId };
    const wsServer = this.wsServer;
    if (wsServer === null) {
      this.rollbackReservation(leaseId);
      try { socket.destroy(); } catch { /* silent */ }
      return;
    }
    try {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        if (this.shuttingDown) {
          try { ws.terminate(); } catch { /* silent */ }
          this.rollbackReservation(leaseId);
          return;
        }
        if (socket.destroyed) {
          try { ws.terminate(); } catch { /* silent */ }
          this.rollbackReservation(leaseId);
          return;
        }
        if (this.ownerSlot.kind !== "reserved" || this.ownerSlot.leaseId !== leaseId) {
          try { ws.terminate(); } catch { /* silent */ }
          return;
        }
        const attach = this.opts.humanOwner.attachTui(leaseId);
        if (attach.kind === "refused") {
          try { ws.terminate(); } catch { /* silent */ }
          this.ownerSlot = { kind: "empty" };
          this.reportInternal(`attach_refused_${attach.reason}`);
          return;
        }
        this.ownerSlot = { kind: "held", leaseId, ws };
        this.untrackPreAuthSocket(socket);
        // 副指挥 1b24ae71 P1: HTTP listener stays OPEN after attach.
        // Concurrent hard-1 is enforced by the ownerSlot check on
        // the next Upgrade — a second peer gets a 401 body but does
        // NOT see ECONNREFUSED. A cleanly-detached owner (or a Wave 2
        // launcher-refreshed bearer) can reattach without a lifecycle
        // restart.
        this.wireOwnerSocket(ws, leaseId);
      });
    } catch (_e) {
      this.reportInternal("ws_handle_upgrade_throw");
      this.rollbackReservation(leaseId);
      try { socket.destroy(); } catch { /* silent */ }
    }
    socket.once("close", () => {
      if (this.ownerSlot.kind === "reserved" && this.ownerSlot.leaseId === leaseId) {
        this.rollbackReservation(leaseId);
      }
    });
  }

  private rollbackReservation(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind === "reserved" && this.ownerSlot.leaseId === leaseId) {
      this.ownerSlot = { kind: "empty" };
    }
  }

  // ─────────── Wire path (post-Upgrade) ───────────

  private wireOwnerSocket(ws: WebSocket, leaseId: OwnerLeaseId): void {
    ws.on("message", (raw, isBinary) => {
      // 副指挥 06e92ef7 P0-4: re-verify the owner slot per frame.
      // A stale socket whose lease no longer matches the incumbent
      // must NOT get initialize / request / response handling.
      if (this.ownerSlot.kind !== "held" || this.ownerSlot.leaseId !== leaseId) {
        this.reportInternal("ws_frame_from_stale_socket");
        try { ws.terminate(); } catch { /* silent */ }
        return;
      }
      if (isBinary) {
        this.reportInternal("ws_binary_refused");
        try { ws.close(1003, "binary_unsupported"); } catch { /* silent */ }
        return;
      }
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.reportInternal("ws_invalid_json");
        try { ws.close(1007, "invalid_json"); } catch { /* silent */ }
        return;
      }
      void this.onFrame(parsed, ws, leaseId);
    });
    // 副指挥 06e92ef7 P0-4: on error the owner socket is TERMINATED
    // (not merely detached). A stale socket that keeps sending
    // frames must have its underlying transport killed.
    ws.on("close", () => this.onOwnerClose(leaseId));
    ws.on("error", () => {
      try { ws.terminate(); } catch { /* silent */ }
      this.onOwnerClose(leaseId);
    });
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
        this.reportInternal(`ws_frame_malformed_${cls.reason}`);
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
    const outcome = this.opts.humanOwner.handleTuiResponseFrameWithLease(frame, leaseId);
    if (outcome.kind === "reject") {
      this.writeFrame(ws, {
        jsonrpc: "2.0",
        id: outcome.tuiId,
        error: { code: outcome.code, message: outcome.message, data: outcome.data },
      });
      return;
    }
    // Forwarding the rewritten approval response back to upstream is
    // the lifecycle-owned upstream router's job, not the WS server's.
    // In Phase 1 approvalMode=never this branch is unreachable.
    this.reportInternal("tui_response_forward_not_wired_in_ws_server");
  }

  private onOwnerClose(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind !== "held" || this.ownerSlot.leaseId !== leaseId) return;
    this.ownerSlot = { kind: "empty" };
    this.opts.humanOwner.detachTui(leaseId);
  }

  // ─────────── Helpers ───────────

  private writeFrame(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); }
    catch { this.reportInternal("ws_write_failed"); }
  }

  /** Like `writeFrame` but returns true only when send() didn't throw. */
  private writeFrameStrict(ws: WebSocket, frame: unknown): boolean {
    try { ws.send(JSON.stringify(frame)); return true; }
    catch { this.reportInternal("ws_write_failed"); return false; }
  }

  private reportInternal(operation: string): void {
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
