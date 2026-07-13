// RFC-030 Wave 1A P0.2 Commit 1 corrective round 5 — upstream-router.ts
//
// The SOLE upstream frame router. Lifecycle owns exactly one instance
// and subscribes it to `upstreamTransport.onFrame` / `onClose` BEFORE
// any preflight or await that could touch the transport. Frames that
// arrive during the pre-activation window are buffered and drained on
// activate. A close during pre-activation puts the router in a terminal
// state which lifecycle observes and short-circuits `start()` cleanly.
//
// Backend UDS server + TUI WS server no longer subscribe to the
// upstream transport directly. They surface narrow delivery seams the
// router calls into:
//   - Backend UDS: the mux + `sendInternal` semantics (unchanged).
//     Internal-scheduler response bodies are routed here.
//   - TUI WS: `deliverReverseRequestToOwner(frame)` and
//     `deliverProxiedResponseToOwner(tuiId, frame)`.
//
// Notification frames go to a single explicit sink (diagnostics).
// Response frames are consumed EXACTLY ONCE via the frozen mux.
// A proxied-TUI response is routed to the owner; an internal-
// scheduler response resolves / rejects the origin Promise. Malformed
// upstream frames go to diagnostics.

import {
  classifyMessage,
  type JsonRpcResponseFrame,
  type ProtocolDiagnostics,
  type UpstreamRequestMux,
  type UpstreamResponseOrigin,
} from "./protocol";
import { HumanOwnerCoordinator } from "./human-owner";
import type { InternalOrigin, UpstreamTransport } from "./uds-server";

// ────────────────────────────────────────────────────────────────────────
// Router surface
// ────────────────────────────────────────────────────────────────────────

/**
 * Narrow delivery seam the router uses to hand a Codex reverse request
 * to the TUI face. The router calls this after
 * `HumanOwnerCoordinator.handleUpstreamReverseRequest(frame)` has
 * returned `forward_tui`. Under Phase 1 (`approvalMode="never"`) this
 * never fires — the coordinator produces `reject_upstream` first.
 */
export interface TuiForwardSeam {
  /**
   * Deliver a reverse request frame to the currently-attached owner.
   * Return true if delivered, false if there is no incumbent (in
   * which case the router logs a diagnostic).
   */
  deliverReverseRequestToOwner(frame: unknown): boolean;
  /**
   * Deliver a proxied-TUI upstream response (already id-rewritten to
   * the owner's TUI id) to the owner socket. Return true if
   * delivered, false if the owner has left.
   */
  deliverProxiedResponseToOwner(tuiId: number | string, frame: JsonRpcResponseFrame): boolean;
}

export interface UpstreamRouterOptions {
  readonly mux: UpstreamRequestMux<InternalOrigin>;
  readonly humanOwner: HumanOwnerCoordinator;
  readonly upstreamTransport: UpstreamTransport;
  readonly diagnostics: ProtocolDiagnostics;
  readonly tuiForward: TuiForwardSeam;
  /**
   * Called when the upstream transport fires its close event. The
   * lifecycle uses this to cascade shutdown. Called AT MOST ONCE.
   */
  readonly onUpstreamClose: () => void;
}

/**
 * Sole upstream router. Lifecycle constructs it, subscribes, runs
 * preflight, then activates.
 *
 * State machine:
 *   subscribed  -> [preflight/await window; frames buffered]
 *   active      -> live routing
 *   terminal    -> post-close; frames ignored
 */
export class UpstreamRouter {
  private readonly opts: UpstreamRouterOptions;
  private frameUnsub: (() => void) | null = null;
  private closeUnsub: (() => void) | null = null;
  private state: "subscribed" | "active" | "terminal" = "subscribed";
  private readonly buffered: unknown[] = [];
  private receivedCloseBeforeActive = false;
  /** Diagnostics inspector: how many pre-activation frames were buffered. */
  private bufferedFramesCounter = 0;
  /**
   * 副指挥 06e92ef7 P1-2: hard cap on pre-active buffered frames.
   * If a hostile upstream floods during preflight, we drop the
   * excess and fail-close the router. Not configurable in production.
   */
  private static readonly PRE_ACTIVE_BUFFER_CAP = 256;
  private bufferOverflowed = false;

  constructor(opts: UpstreamRouterOptions) {
    this.opts = opts;
  }

  /**
   * Subscribe to the upstream transport. Call BEFORE any preflight/
   * await that could touch the transport. Frames received before
   * `activate()` are buffered; a close received before `activate()`
   * puts the router in terminal state and `wasCloseBeforeActive()`
   * returns true.
   */
  subscribe(): void {
    if (this.frameUnsub !== null || this.closeUnsub !== null) {
      throw new Error("UpstreamRouter: subscribe() called twice");
    }
    // 副指挥 06e92ef7 P0-5: atomic subscribe. If the second
    // subscription throws, roll back the first so no dangling
    // handler leaks into the transport.
    let frameUnsub: (() => void) | null = null;
    try {
      frameUnsub = this.opts.upstreamTransport.onFrame((raw) => this.onFrame(raw));
    } catch (e) {
      throw e;
    }
    let closeUnsub: (() => void) | null = null;
    try {
      closeUnsub = this.opts.upstreamTransport.onClose(() => this.onClose());
    } catch (e) {
      // Roll back the frame subscription.
      try { frameUnsub(); } catch { /* silent */ }
      throw e;
    }
    this.frameUnsub = frameUnsub;
    this.closeUnsub = closeUnsub;
  }

  /**
   * Drain any pre-active buffered frames and switch to live routing.
   * If a close was seen before activate, call this AFTER handling
   * `wasCloseBeforeActive()` — activate on terminal is a no-op.
   */
  activate(): void {
    if (this.state === "terminal") return;
    if (this.state === "active") return;
    this.state = "active";
    // Drain buffered frames in order.
    const drained = this.buffered.splice(0);
    for (const f of drained) this.dispatchFrame(f);
    if (this.receivedCloseBeforeActive) {
      this.receivedCloseBeforeActive = false;
      this.doClose();
    }
  }

  wasCloseBeforeActive(): boolean {
    return this.receivedCloseBeforeActive;
  }

  /**
   * Unsubscribe from the transport. Idempotent. Called by lifecycle
   * on stop. Does NOT invoke `onUpstreamClose` (lifecycle already
   * knows it's stopping).
   */
  unsubscribe(): void {
    if (this.frameUnsub !== null) {
      try { this.frameUnsub(); } catch { /* silent */ }
      this.frameUnsub = null;
    }
    if (this.closeUnsub !== null) {
      try { this.closeUnsub(); } catch { /* silent */ }
      this.closeUnsub = null;
    }
    this.state = "terminal";
  }

  // ─────────── Test-only inspectors ───────────

  currentState(): "subscribed" | "active" | "terminal" { return this.state; }
  bufferedCount(): number { return this.buffered.length; }
  totalBuffered(): number { return this.bufferedFramesCounter; }

  // ─────────── Internal ───────────

  private onFrame(raw: unknown): void {
    if (this.state === "terminal") return;
    if (this.state === "subscribed") {
      // 副指挥 e85ade40 P0-2: after `onClose` fires in pre-active
      // state, subsequent frames are DROPPED — activate() never
      // dispatches them. Only pre-close frames stay in the buffer.
      // Previously post-close pre-active frames were still buffered
      // and then delivered on activate → the router produced a
      // NoOwner response for an id that arrived AFTER the transport
      // was gone.
      if (this.receivedCloseBeforeActive) {
        this.report("upstream_frame_dropped_after_pre_active_close");
        return;
      }
      if (this.buffered.length >= UpstreamRouter.PRE_ACTIVE_BUFFER_CAP) {
        // Fail-closed: drop the frame and mark the router terminal
        // so activate() will short-circuit start().
        this.bufferOverflowed = true;
        this.report("pre_active_buffer_overflow");
        this.state = "terminal";
        this.receivedCloseBeforeActive = true; // treat as close-before-active
        return;
      }
      this.buffered.push(raw);
      this.bufferedFramesCounter++;
      return;
    }
    this.dispatchFrame(raw);
  }

  /** Test-only: was the pre-active buffer cap hit? */
  bufferOverflowedFlag(): boolean { return this.bufferOverflowed; }

  private onClose(): void {
    if (this.state === "terminal") return;
    if (this.state === "subscribed") {
      this.receivedCloseBeforeActive = true;
      return;
    }
    this.doClose();
  }

  private doClose(): void {
    this.state = "terminal";
    try { this.opts.onUpstreamClose(); } catch { /* silent */ }
  }

  private dispatchFrame(raw: unknown): void {
    const cls = classifyMessage(raw);
    switch (cls.kind) {
      case "response":
        this.dispatchResponse(cls.frame);
        return;
      case "request":
        this.dispatchReverseRequest(cls.frame);
        return;
      case "notification":
        this.report("upstream_notification_dropped_phase1");
        return;
      case "malformed":
        this.report(`upstream_frame_malformed_${cls.reason}`);
        return;
    }
  }

  private dispatchResponse(frame: JsonRpcResponseFrame): void {
    const origin = this.opts.mux.consumeUpstreamResponse(frame.id);
    if (origin === null) {
      this.report("upstream_response_orphan");
      return;
    }
    if (origin.kind === "internal") {
      this.dispatchInternalResponse(origin, frame);
    } else {
      this.dispatchProxiedResponse(origin, frame);
    }
  }

  private dispatchInternalResponse(
    origin: Extract<UpstreamResponseOrigin<InternalOrigin>, { kind: "internal" }>,
    frame: JsonRpcResponseFrame,
  ): void {
    try {
      if ("error" in frame) {
        origin.origin.reject(new Error(frame.error.message));
      } else {
        origin.origin.resolve(frame.result);
      }
    } catch {
      this.report("internal_response_dispatch_throw");
    }
  }

  private dispatchProxiedResponse(
    origin: Extract<UpstreamResponseOrigin<InternalOrigin>, { kind: "proxied_tui" }>,
    frame: JsonRpcResponseFrame,
  ): void {
    const rewritten: JsonRpcResponseFrame = "error" in frame
      ? { jsonrpc: "2.0", id: origin.tuiId, error: frame.error }
      : { jsonrpc: "2.0", id: origin.tuiId, result: frame.result };
    const delivered = this.opts.tuiForward.deliverProxiedResponseToOwner(
      origin.tuiId as number | string,
      rewritten,
    );
    if (!delivered) {
      this.report("proxied_response_no_owner");
    }
  }

  private dispatchReverseRequest(frame: import("./protocol").JsonRpcRequestFrame): void {
    const decision = this.opts.humanOwner.handleUpstreamReverseRequest(frame);
    if (decision.kind === "reject_upstream") {
      void this.opts.upstreamTransport.writeFrame(decision.upstreamError).catch(() => {
        this.report("upstream_reject_write_failed");
      });
      return;
    }
    // Phase 1 approvalMode="never" never emits forward_tui, but if it
    // did we'd deliver via the TUI seam.
    const delivered = this.opts.tuiForward.deliverReverseRequestToOwner(decision.tuiFrame);
    if (!delivered) {
      this.report("forward_tui_no_incumbent");
    }
  }

  private report(operation: string): void {
    try {
      this.opts.diagnostics.reportInternalError({
        correlationId: this.opts.diagnostics.newCorrelationId(),
        operation,
        error: new Error(operation),
      });
    } catch { /* silent */ }
  }
}
