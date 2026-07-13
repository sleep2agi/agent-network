// RFC-030 Wave 1A P0.2 Commit 1 corrective round 2 — tui-ws-server.ts
//
// Native Codex TUI WebSocket admission surface + sole upstream frame
// router for reverse requests / responses / notifications.
//
// Corrective (副指挥 3ed5c004):
//   P0-1: subscribes to `upstreamTransport.onFrame` and routes:
//         - request (Codex reverse) -> HumanOwnerCoordinator; Phase 1
//           always writes back `NoOwner+approval_mode_never` on the
//           ORIGINAL codex id, zero TUI forward.
//         - response -> diagnostic (upstream response routing lives
//           in `uds-server`; a proxied-TUI response would be routed
//           back here, but Phase 1 has no proxied-TUI upstream path
//           because Phase 1 authorizer never allows `forward_upstream`)
//         - notification -> explicit diagnostic (never silent).
//         - malformed -> explicit diagnostic.
//   P0-2: preauth ledger stays populated across the Upgrade dispatch;
//         only cleared when the WebSocket handshake FULLY succeeds.
//         `writeGenericReject` (in admission.ts) arms a bounded destroy
//         so allowHalfOpen clients cannot pin the ledger.
//   P0-3: bearer + secret storage moved out of the server too — every
//         private field lives on `this`; the secret is held by
//         `TuiBearer` (WeakMap-backed).
//   P1-1: singleton Host header enforced upstream in admission.ts.
//   P1-2: no `ws.close(1006)` calls anywhere (`1006` is reserved and
//         `ws` throws). Rollback uses `socket.destroy()` or `ws.terminate()`.
//   P1-3: `maxPayload`, `headerTimeoutMs`, `maxPreAuthSockets` are HARD
//         CONSTANTS in production. The tests' seam goes through
//         `TuiWsServer._createForTest(opts, testOverrides)` which is
//         `@internal` and not part of the documented option surface.
//   P1-4: no `currentLease()` accessor. `attachTui` returns a typed
//         outcome; lifecycle observes success/failure via that.
//   P1-5: canonical `Sec-WebSocket-Key` — decode + re-encode must be
//         byte-equal to the presented value (rejects non-canonical
//         padding bits).

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
import type { UpstreamTransport } from "./uds-server";
import * as crypto from "node:crypto";

// ────────────────────────────────────────────────────────────────────────
// HARD-PINNED constants (副指挥 3ed5c004 P1-3)
// ────────────────────────────────────────────────────────────────────────

export const TUI_WS_MAX_PAYLOAD = 1 * 1024 * 1024;
export const TUI_HTTP_HEADER_TIMEOUT_MS = 3_000;
export const TUI_MAX_PREAUTH_SOCKETS = 8;

/**
 * @internal Test-only override object. Production callers construct
 * via `new TuiWsServer(opts)` and get the hard-pinned constants.
 * Tests that need tighter timings construct via
 * `TuiWsServer._createForTest(opts, testOverrides)`.
 */
export interface TuiWsServerTestOverrides {
  readonly maxPayload?: number;
  readonly headerTimeoutMs?: number;
  readonly maxPreAuthSockets?: number;
}

// ────────────────────────────────────────────────────────────────────────
// Options — production-facing
// ────────────────────────────────────────────────────────────────────────

export interface TuiWsServerOptions {
  readonly bearer: TuiBearer;
  readonly humanOwner: HumanOwnerCoordinator;
  readonly authorizer: TuiRequestAuthorizer;
  readonly initProvider: TuiInitializeProvider;
  readonly diagnostics: ProtocolDiagnostics;
  /**
   * 副指挥 3ed5c004 P0-1: the WS server is the SOLE upstream frame
   * router for reverse-request handling. It subscribes to
   * `onFrame` in `start()` and unsubscribes in `stop()`.
   */
  readonly upstreamTransport: UpstreamTransport;
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
  private readonly maxPayload: number;
  private readonly headerTimeoutMs: number;
  private readonly maxPreAuthSockets: number;

  private httpServer: http.Server | null = null;
  private wsServer: WsServerType | null = null;
  private boundPort = 0;
  private ownerSlot: OwnerState = { kind: "empty" };
  private readonly preAuthTimers: Map<Socket, NodeJS.Timeout> = new Map();
  private upstreamUnsubs: Array<() => void> = [];
  private running = false;
  private shuttingDown = false;

  constructor(opts: TuiWsServerOptions);
  /** @internal */
  constructor(opts: TuiWsServerOptions, overrides: TuiWsServerTestOverrides);
  constructor(opts: TuiWsServerOptions, overrides: TuiWsServerTestOverrides = {}) {
    this.opts = opts;
    // Hard-pinned in production; overridable ONLY via the internal
    // test constructor overload.
    this.maxPayload = overrides.maxPayload ?? TUI_WS_MAX_PAYLOAD;
    this.headerTimeoutMs = overrides.headerTimeoutMs ?? TUI_HTTP_HEADER_TIMEOUT_MS;
    this.maxPreAuthSockets = overrides.maxPreAuthSockets ?? TUI_MAX_PREAUTH_SOCKETS;
  }

  /** @internal test-only factory that applies overrides. */
  static _createForTest(opts: TuiWsServerOptions, overrides: TuiWsServerTestOverrides): TuiWsServer {
    return new TuiWsServer(opts, overrides);
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
      maxPayload: this.maxPayload,
      perMessageDeflate: false,
    });

    this.httpServer = httpServer;
    this.wsServer = wsServer;

    // Subscribe to upstream FIRST so a frame arriving during the
    // listen await is captured (or explicitly rejected).
    this.upstreamUnsubs.push(this.opts.upstreamTransport.onFrame((raw) => this.onUpstreamFrame(raw)));
    this.upstreamUnsubs.push(this.opts.upstreamTransport.onClose(() => this.onUpstreamClose()));

    try {
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
    } catch (e) {
      // Rollback subscribers.
      for (const un of this.upstreamUnsubs) { try { un(); } catch { /* silent */ } }
      this.upstreamUnsubs = [];
      throw e;
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running && this.httpServer === null) return;
    this.shuttingDown = true;
    this.running = false;
    for (const un of this.upstreamUnsubs) { try { un(); } catch { /* silent */ } }
    this.upstreamUnsubs = [];
    try { this.opts.bearer.rotate(); } catch { /* silent */ }
    if (this.ownerSlot.kind === "held") {
      const held = this.ownerSlot;
      this.ownerSlot = { kind: "empty" };
      try { held.ws.close(1001, "gateway_stopping"); } catch { /* silent */ }
      try { this.opts.humanOwner.detachTui(held.leaseId); } catch { /* silent */ }
    } else if (this.ownerSlot.kind === "reserved") {
      // Never attached to the coordinator; nothing to detach.
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
  /** Diagnostics: preauth ledger size. Non-security accessor. */
  preAuthCount(): number { return this.preAuthTimers.size; }

  // ─────────── Pre-auth socket tracking ───────────

  private trackPreAuthSocket(socket: Socket): void {
    if (this.preAuthTimers.size >= this.maxPreAuthSockets || this.shuttingDown) {
      try { socket.destroy(); } catch { /* silent */ }
      this.reportInternal("preauth_socket_cap_exceeded", {});
      return;
    }
    const timer = setTimeout(() => {
      if (this.preAuthTimers.has(socket)) {
        this.preAuthTimers.delete(socket);
        try { socket.destroy(); } catch { /* silent */ }
      }
    }, this.headerTimeoutMs);
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
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: "ws_key_empty" };
    }
    if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) {
      return { ok: false, reason: "ws_key_bad_shape" };
    }
    let decoded: Buffer;
    try { decoded = Buffer.from(value, "base64"); }
    catch { return { ok: false, reason: "ws_key_bad_base64" }; }
    if (decoded.length !== 16) return { ok: false, reason: "ws_key_bad_length" };
    // P1-5: canonical round-trip check. Re-encoding the decoded 16
    // bytes MUST match the presented value verbatim. This rejects
    // non-canonical padding bits like `dGVzdF9rZXlfZm9yX2p1c3Q3==`
    // whose last decoded byte doesn't set bits 0-1 to zero.
    const reencoded = decoded.toString("base64");
    if (reencoded !== value) return { ok: false, reason: "ws_key_noncanonical" };
    return { ok: true, key: value };
  }

  // ─────────── Upgrade path ───────────

  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    // 副指挥 3ed5c004 P0-2: DO NOT untrack the preauth ledger here.
    // Untrack only happens (a) when the socket 'close' event fires or
    // (b) when the WS handshake fully succeeds inside handleUpgrade's
    // callback. Any reject path leaves the socket in the preauth
    // ledger; `writeGenericReject`'s bounded destroy will trigger
    // 'close' which unregisters.
    //
    // 1. Admission structural checks.
    const admission = decideAdmission(req, socket, this.boundPort);
    if (admission.kind === "reject") {
      this.reportInternal(`admission_reject_${admission.reason}`, {});
      writeGenericReject(socket, admission.status);
      return;
    }
    // 2. Sec-WebSocket-Key structural + canonical check.
    const keyCheck = this.validateSecWebSocketKey(req);
    if (keyCheck.ok === false) {
      this.reportInternal(`ws_key_reject_${keyCheck.reason}`, {});
      writeGenericReject(socket, 400);
      return;
    }
    // 3. Bearer.
    const bearerOutcome = this.opts.bearer.presentBearer(admission.bearer);
    if (bearerOutcome.kind === "reject") {
      this.reportInternal(`bearer_reject_${bearerOutcome.reason}`, {});
      writeGenericReject(socket, 401);
      return;
    }
    // 4. Owner slot.
    if (this.ownerSlot.kind !== "empty") {
      this.reportInternal("owner_already_attached", {});
      writeGenericReject(socket, 401);
      return;
    }
    // 5. Provisional reserve.
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
        // Typed attach outcome (副指挥 3ed5c004 P1-4). If refused,
        // roll back the WS handshake with terminate() — NOT close(1006).
        const attach = this.opts.humanOwner.attachTui(leaseId);
        if (attach.kind === "refused") {
          try { ws.terminate(); } catch { /* silent */ }
          this.ownerSlot = { kind: "empty" };
          this.reportInternal(`attach_refused_${attach.reason}`, {});
          return;
        }
        this.ownerSlot = { kind: "held", leaseId, ws };
        // Handshake fully succeeded — remove the preauth ledger entry.
        this.untrackPreAuthSocket(socket);
        // Stop the HTTP listener so a second peer can't reach onUpgrade.
        try { this.httpServer?.close(); } catch { /* silent */ }
        this.wireOwnerSocket(ws, leaseId);
      });
    } catch (_e) {
      this.reportInternal("ws_handle_upgrade_throw", {});
      this.rollbackReservation(leaseId);
      try { socket.destroy(); } catch { /* silent */ }
    }
    // Rollback on socket close BEFORE the ws callback fires (e.g.,
    // handshake never completes because peer went away).
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
    // forward_reverse_response: send the rewritten frame upstream. Best-effort;
    // failure is a diagnostic.
    void this.opts.upstreamTransport.writeFrame(outcome.frame).catch(() => {
      this.reportInternal("forward_reverse_response_write_failed", {});
    });
  }

  private onOwnerClose(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind !== "held" || this.ownerSlot.leaseId !== leaseId) return;
    this.ownerSlot = { kind: "empty" };
    this.opts.humanOwner.detachTui(leaseId);
  }

  // ─────────── Upstream ↔ coordinator (副指挥 3ed5c004 P0-1) ───────────

  private onUpstreamFrame(raw: unknown): void {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "request": {
        const decision = this.opts.humanOwner.handleUpstreamReverseRequest(cls.frame);
        if (decision.kind === "reject_upstream") {
          void this.opts.upstreamTransport.writeFrame(decision.upstreamError).catch(() => {
            this.reportInternal("upstream_reject_write_failed", {});
          });
          return;
        }
        // Phase 1 approvalMode="never" never emits forward_tui. If it
        // did, we'd write the frame to the owner socket.
        if (this.ownerSlot.kind === "held") {
          this.writeFrame(this.ownerSlot.ws, decision.tuiFrame);
        } else {
          this.reportInternal("forward_tui_no_incumbent", {});
        }
        return;
      }
      case "response":
        // Upstream response routing lives in `uds-server` (internal
        // scheduler / proxied-TUI). Nothing for the WS server to do
        // here in Phase 1; explicit diagnostic so a real integration
        // notices if this ever fires unexpectedly.
        this.reportInternal("upstream_response_on_ws_face", {});
        return;
      case "notification":
        // Phase 1: Codex event stream is not routed anywhere yet. NOT
        // silent — explicit diagnostic so audit can spot drops.
        this.reportInternal("upstream_notification_dropped_phase1", {});
        return;
      case "malformed":
        this.reportInternal(`upstream_frame_malformed_${cls.reason}`, {});
        return;
    }
  }

  private onUpstreamClose(): void {
    // Upstream tore down. Detach the owner if any.
    if (this.ownerSlot.kind === "held") {
      const held = this.ownerSlot;
      this.ownerSlot = { kind: "empty" };
      try { held.ws.close(1001, "upstream_closed"); } catch { /* silent */ }
      try { this.opts.humanOwner.detachTui(held.leaseId); } catch { /* silent */ }
    }
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
