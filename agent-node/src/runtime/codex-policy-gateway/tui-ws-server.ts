// RFC-030 Wave 1A P0.2 — tui-ws-server.ts
//
// Native Codex TUI WebSocket admission surface. Wraps a `node:http`
// server that only ever accepts a WebSocket Upgrade to `/` (per real
// 0.144.0 loopback captured baseline; 副指挥 967a0010) and only after:
//   - the admission checks in `admission.ts` pass;
//   - the `TuiBearer.presentBearer` returns `ok`;
//   - the owner slot's synchronous reserve succeeds (hard 1).
//
// The frozen `protocol.ts` / `contract.ts` are NOT modified. The
// `TuiBearer` remains the single source of truth for bearer state;
// this file just wires it into the HTTP Upgrade flow. Reverse-request
// routing is delegated to `HumanOwnerCoordinator`; the coordinator's
// lease-aware helper (`handleTuiResponseFrameWithLease`) is used so a
// second connection cannot cross-answer even if it correctly guesses
// a `tuiId`.
//
// This module does not consume the frozen `ReverseRequestNamespace`
// directly — everything reverse-related goes through the coordinator.

import * as http from "node:http";
import type { Socket } from "node:net";
import type { WebSocket, WebSocketServer as WsServerType } from "ws";
import { WebSocketServer } from "ws";

import {
  ALLOWED_LOOPBACK,
  decideAdmission,
  writeGenericReject,
  type AdmissionRejectReason,
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

/** WS payload cap. 128 KiB semantic text worst-case JSON escape ~6x
 *  + envelope headroom = 1 MiB. Semantic gate is enforced separately
 *  after decode. */
export const TUI_WS_MAX_PAYLOAD = 1 * 1024 * 1024;

/** Semantic cap on the decoded text field of an Agent-facing enqueue
 *  request. Frozen contract; documented here for defense-in-depth. */
export const TUI_WS_SEMANTIC_TEXT_CAP = 128 * 1024;

/** Pre-auth header read timeout. If the peer completes TCP connect but
 *  doesn't finish the HTTP request head within this window, we drop
 *  it. Prevents slow-loris exhaustion of accept slots. */
export const TUI_HTTP_HEADER_TIMEOUT_MS = 3_000;

/** Ceiling on outstanding pre-auth raw sockets (TCP connected but no
 *  Upgrade completed yet). Excess connects are destroyed immediately. */
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
  /**
   * The WS payload cap. Defaults to `TUI_WS_MAX_PAYLOAD`. Tests may
   * lower it to exercise oversize behaviour.
   */
  readonly maxPayload?: number;
  /**
   * Header-read timeout for the pre-Upgrade HTTP request. Defaults
   * to `TUI_HTTP_HEADER_TIMEOUT_MS`. Tests may lower it.
   */
  readonly headerTimeoutMs?: number;
  /**
   * Cap on unauthenticated pre-Upgrade sockets in flight. Defaults
   * to `TUI_MAX_PREAUTH_SOCKETS`.
   */
  readonly maxPreAuthSockets?: number;
}

// ────────────────────────────────────────────────────────────────────────
// TuiWsServer
// ────────────────────────────────────────────────────────────────────────

type OwnerState =
  | { readonly kind: "empty" }
  | { readonly kind: "held"; readonly leaseId: OwnerLeaseId; readonly ws: WebSocket };

export class TuiWsServer {
  private readonly opts: TuiWsServerOptions;
  private httpServer: http.Server | null = null;
  private wsServer: WsServerType | null = null;
  private boundPort = 0;
  private ownerSlot: OwnerState = { kind: "empty" };
  private preAuthSockets = new Set<Socket>();
  private running = false;
  private shuttingDown = false;

  constructor(opts: TuiWsServerOptions) {
    this.opts = opts;
  }

  // ─────────── Lifecycle ───────────

  /**
   * Start binds `127.0.0.1:0`; after the `listening` event we assert
   * that the OS gave us a strict IPv4 loopback address and read the
   * assigned ephemeral port.
   */
  async start(): Promise<void> {
    if (this.running) throw new Error("TuiWsServer already running");
    const httpServer = http.createServer((req, res) => {
      // Any non-upgrade HTTP request lands here. Uniform 404 —
      // the surface exists ONLY to accept a WebSocket Upgrade.
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not_found");
    });
    httpServer.on("connection", (socket: Socket) => this.trackPreAuthSocket(socket));
    httpServer.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));

    // Reject any header body-length past ws-server maxPayload; ws will
    // apply this via handleUpgrade.
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
    // Rotate the bearer so no further Upgrade can consume it.
    try { this.opts.bearer.rotate(); } catch { /* silent */ }
    // Close the owner socket if any.
    if (this.ownerSlot.kind === "held") {
      const held = this.ownerSlot;
      this.ownerSlot = { kind: "empty" };
      try { held.ws.close(1001, "gateway_stopping"); } catch { /* silent */ }
      try { this.opts.humanOwner.detachTui(held.leaseId); } catch { /* silent */ }
    }
    // Close pre-auth raw sockets.
    for (const s of this.preAuthSockets) {
      try { s.destroy(); } catch { /* silent */ }
    }
    this.preAuthSockets.clear();
    if (this.wsServer !== null) {
      try { this.wsServer.close(); } catch { /* silent */ }
      this.wsServer = null;
    }
    if (this.httpServer !== null) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  boundPortActual(): number {
    return this.boundPort;
  }

  ownerSlotState(): "empty" | "held" {
    return this.ownerSlot.kind;
  }

  currentLease(): OwnerLeaseId | null {
    return this.ownerSlot.kind === "held" ? this.ownerSlot.leaseId : null;
  }

  // ─────────── Pre-auth socket tracking ───────────

  private trackPreAuthSocket(socket: Socket): void {
    const maxPre = this.opts.maxPreAuthSockets ?? TUI_MAX_PREAUTH_SOCKETS;
    if (this.preAuthSockets.size >= maxPre || this.shuttingDown) {
      try { socket.destroy(); } catch { /* silent */ }
      this.reportInternal("preauth_socket_cap_exceeded", {});
      return;
    }
    this.preAuthSockets.add(socket);
    // Timeout: if a full HTTP request head doesn't arrive in the
    // header-read window, drop the raw socket. This does NOT touch
    // the owner slot — pre-auth sockets never hold a lease.
    const headerTimeoutMs = this.opts.headerTimeoutMs ?? TUI_HTTP_HEADER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!socket.destroyed) {
        try { socket.destroy(); } catch { /* silent */ }
      }
    }, headerTimeoutMs);
    timer.unref?.();
    const untrack = () => {
      clearTimeout(timer);
      this.preAuthSockets.delete(socket);
    };
    socket.once("close", untrack);
    socket.once("upgrade", untrack);
  }

  // ─────────── Upgrade path ───────────

  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    // 1. Admission structural checks + bearer extraction. This is
    //    intentionally done BEFORE any owner-slot look. An unauth
    //    peer cannot distinguish "owner_already_attached" from
    //    "wrong bearer" — both fall into a uniform 401 wire response.
    const admission = decideAdmission(req, socket, this.boundPort);
    if (admission.kind === "reject") {
      this.reportInternal(`admission_reject_${admission.reason}`, {});
      writeGenericReject(socket, admission.status);
      return;
    }
    // 2. Bearer presentation against the single-use holder.
    const bearerOutcome = this.opts.bearer.presentBearer(admission.bearer);
    if (bearerOutcome.kind === "reject") {
      this.reportInternal(`bearer_reject_${bearerOutcome.reason}`, {});
      // Uniform 401 regardless of internal reason.
      writeGenericReject(socket, 401);
      return;
    }
    // 3. Owner slot reserve — SYNCHRONOUS. If already held, uniform
    //    401 wire body (same as bearer reject). The internal reason
    //    goes to diagnostics only.
    if (this.ownerSlot.kind === "held") {
      this.reportInternal("owner_already_attached", {});
      writeGenericReject(socket, 401);
      // NB: the bearer was already consumed by presentBearer. That
      // is intentional — a bearer is single-use per lifecycle even
      // when the owner slot happens to be full; a supervisor must
      // restart the lifecycle to get a fresh bearer.
      return;
    }
    // 4. Reserve the slot and complete the WS handshake.
    const leaseId = mintOwnerLeaseId();
    this.ownerSlot = { kind: "held", leaseId, ws: null as unknown as WebSocket };
    const wsServer = this.wsServer;
    if (wsServer === null) {
      // Race: server shutting down between admission and handshake.
      this.ownerSlot = { kind: "empty" };
      try { socket.destroy(); } catch { /* silent */ }
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      // Ensure a race did not consume us mid-way.
      if (this.shuttingDown) {
        try { ws.close(1001, "gateway_stopping"); } catch { /* silent */ }
        this.ownerSlot = { kind: "empty" };
        return;
      }
      this.ownerSlot = { kind: "held", leaseId, ws };
      // Attach to coordinator. Frozen mux/reverseNs untouched — the
      // coordinator side map is the only new state.
      this.opts.humanOwner.attachTui(leaseId);
      // Stop accepting new HTTP connections while we have an owner.
      // A real hard-1 semantic — new peers cannot even reach the
      // Upgrade handler after this point.
      try { this.httpServer?.close(); } catch { /* silent */ }
      this.wireOwnerSocket(ws, leaseId);
    });
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
      // Semantic size gate (defense in depth beyond WS maxPayload).
      if (text.length > TUI_WS_SEMANTIC_TEXT_CAP * 8) {
        // Non-tight upper bound (1MB): the ws lib already enforces
        // maxPayload; this is here so a payload that squeezed under
        // WS cap but is nonsensically large as text still fails.
        this.reportInternal("ws_semantic_oversize", { len: text.length });
        try { ws.close(1009, "oversize"); } catch { /* silent */ }
        return;
      }
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
    // Delegate to frozen classifier. `jsonrpc` is optional there so a
    // real 0.144.0 initialize frame passes through untouched.
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "request":
        await this.dispatchTuiRequest(cls.frame, ws, leaseId);
        return;
      case "notification":
        return; // TUI notifications (like `initialized`) get no reply.
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
        this.writeFrame(ws, {
          jsonrpc: "2.0",
          id: outcome.tuiId,
          result: outcome.result,
        });
        return;
      case "forward_upstream":
        // Reverse-request forwarding is Wave 2 material and is
        // gated by `approvalMode` at the coordinator. In Phase 1
        // we never expect to reach here on the TUI socket for a
        // policy-delegate method — the default-deny fake refuses
        // everything not in the read allowlist.
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
          error: {
            code: outcome.code,
            message: outcome.message,
            data: outcome.data,
          },
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
        error: {
          code: outcome.code,
          message: outcome.message,
          data: outcome.data,
        },
      });
    }
    // On forward_reverse_response the frame is meant for upstream Codex;
    // Wave 1A P0.2 has no upstream transport in scope for this file.
    // The coordinator has already consumed the reverseNs entry; the
    // response frame is dropped (Phase 1 approval=never never emits
    // reverse requests so this branch is unreachable in production).
  }

  private onOwnerClose(leaseId: OwnerLeaseId): void {
    if (this.ownerSlot.kind !== "held" || this.ownerSlot.leaseId !== leaseId) {
      // Stale close from a lease that no longer owns the slot; ignore.
      return;
    }
    this.ownerSlot = { kind: "empty" };
    this.opts.humanOwner.detachTui(leaseId);
  }

  // ─────────── Helpers ───────────

  private writeFrame(ws: WebSocket, frame: unknown): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (e: unknown) {
      this.reportInternal("ws_write_failed", {});
    }
  }

  private reportInternal(operation: string, extra: Record<string, unknown>): void {
    try {
      this.opts.diagnostics.reportInternalError({
        correlationId: this.opts.diagnostics.newCorrelationId(),
        operation,
        error: new Error(operation),
        ...extra,
      });
    } catch { /* silent */ }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Lease minting
// ────────────────────────────────────────────────────────────────────────

/**
 * Mint a fresh opaque `OwnerLeaseId`. 32 bytes CSPRNG, base64url.
 * Uses the frozen `asOwnerLeaseId` brander so we don't leak a
 * duplicate brand.
 */
export function mintOwnerLeaseId(): OwnerLeaseId {
  const bytes = crypto.randomBytes(32);
  const value = bytes.toString("base64url");
  bytes.fill(0);
  return asOwnerLeaseId(value);
}
