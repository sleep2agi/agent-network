// RFC-030 Wave 1A P0.2 Commit 1 corrective round 3 — upstream-router.ts
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
    if (this.frameUnsub !== null) {
      throw new Error("UpstreamRouter: subscribe() called twice");
    }
    this.frameUnsub = this.opts.upstreamTransport.onFrame((raw) => this.onFrame(raw));
    this.closeUnsub = this.opts.upstreamTransport.onClose(() => this.onClose());
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
      this.buffered.push(raw);
      this.bufferedFramesCounter++;
      return;
    }
    this.dispatchFrame(raw);
  }

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
