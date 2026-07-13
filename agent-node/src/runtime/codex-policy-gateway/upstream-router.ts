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
// upstream transport directly. They surface narrow accept seams the
// router calls into:
//   - Backend UDS: the mux + `sendInternal` semantics (unchanged).
//     Internal-scheduler response bodies are routed here.
//   - TUI WS: `acceptReverseRequestForSend(frame)` and
//     `acceptProxiedResponseForSend(tuiId, frame)`. Boolean return
//     means "accepted into the ws send queue on an OPEN socket" —
//     NOT "reached the wire". Async transport failures surface via
//     the diagnostics sink under `..._send_failed_async` operations
//     (副指挥 db0bbe13 P2 honest naming).
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
import { safeAdoptConsume } from "./safe-adopt";

// ────────────────────────────────────────────────────────────────────────
// Router surface
// ────────────────────────────────────────────────────────────────────────

/**
 * Narrow accept-for-send seam the router uses to hand a Codex reverse request
 * to the TUI face. The router calls this after
 * `HumanOwnerCoordinator.handleUpstreamReverseRequest(frame)` has
 * returned `forward_tui`. Under Phase 1 (`approvalMode="never"`) this
 * never fires — the coordinator produces `reject_upstream` first.
 */
/**
 * 副指挥 db0bbe13 P2: honest naming. The seam's boolean return
 * means "accepted into the outbound ws send queue on an OPEN
 * socket" — NOT that the bytes reached the wire. The ws `send()`
 * callback can still surface an async transport error AFTER the
 * router has already consumed the origin. The router observes
 * such post-hoc failures via the diagnostics sink under stable
 * operation names (`reverse_request_send_failed_async` /
 * `proxied_response_send_failed_async`), so a caller cannot claim
 * "delivered" from the boolean alone.
 */
export interface TuiForwardSeam {
  /**
   * Accept a reverse request frame into the owner ws send queue.
   * Return `true` if the socket was OPEN and the send call did not
   * throw. Async transport errors after acceptance surface via the
   * diagnostics sink as `reverse_request_send_failed_async`.
   *
   * Return `false` if the socket was not OPEN or no incumbent
   * exists — the router logs `forward_tui_no_incumbent`.
   */
  acceptReverseRequestForSend(frame: unknown): boolean;
  /**
   * Accept a proxied-TUI upstream response (already id-rewritten
   * to the owner's TUI id) into the owner ws send queue. Same
   * accept-not-delivered semantics as above; async failures surface
   * as `proxied_response_send_failed_async`.
   */
  acceptProxiedResponseForSend(tuiId: number | string, frame: JsonRpcResponseFrame): boolean;
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
  /**
   * 副指挥 ef331a80 Round 8: called when the transport fires
   * close DURING the pre-active `subscribed` state (before
   * `activate()`). Prior behaviour only set an internal
   * `receivedCloseBeforeActive` flag that lifecycle polled via
   * `throwIfAbortedAfterAwait` after each preflight/bind await —
   * a never-resolving preflight never reached the poll, so a
   * pre-active close could not wake the shutdown race.
   *
   * Lifecycle wires this to fire its shutdown signal so the
   * `Promise.race([preflight, shutdownSignal])` unblocks
   * immediately. Called AT MOST ONCE per router instance.
   */
  readonly onPreActiveClose?: () => void;
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
      if (this.receivedCloseBeforeActive) {
        this.report("upstream_frame_dropped_after_pre_active_close");
        return;
      }
      if (this.buffered.length >= UpstreamRouter.PRE_ACTIVE_BUFFER_CAP) {
        // 副指挥 7d061fcd Round 9: overflow now goes through the
        // SAME once-only pre-active-terminal helper as close, so
        // the lifecycle shutdown signal fires here too. Previously
        // overflow set `receivedCloseBeforeActive` locally but did
        // NOT invoke `onPreActiveClose` → a never-resolving
        // preflight left `Promise.race([preflight, signal])`
        // unresolvable.
        this.bufferOverflowed = true;
        this.report("pre_active_buffer_overflow");
        this.state = "terminal";
        this.firePreActiveTerminal();
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
  // 副指挥 9a9a198d Round 10: removed unused public
  // `preActiveTerminalFiredForTest()` accessor. Overflow-ordering
  // tests use the caller-provided `onPreActiveClose` callback
  // counter instead.

  /**
   * 副指挥 7d061fcd Round 9: single once-only helper that BOTH
   * the close path AND the buffer-overflow path funnel through.
   * Sets `receivedCloseBeforeActive`, invokes the lifecycle
   * `onPreActiveClose` callback (which fires the shutdown
   * signal + bumps the epoch). Exactly-one invariant enforced
   * by `preActiveTerminalFired` guard.
   */
  private preActiveTerminalFired = false;
  private firePreActiveTerminal(): void {
    if (this.preActiveTerminalFired) return;
    this.preActiveTerminalFired = true;
    this.receivedCloseBeforeActive = true;
    try { this.opts.onPreActiveClose?.(); } catch { /* silent */ }
  }

  private onClose(): void {
    if (this.state === "terminal") return;
    if (this.state === "subscribed") {
      // Same once-only helper — close and overflow are unified.
      if (!this.preActiveTerminalFired) {
        this.firePreActiveTerminal();
      } else {
        // Helper already fired (e.g. by overflow); still record
        // that close was observed.
        this.receivedCloseBeforeActive = true;
      }
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
    // 副指挥 db0bbe13 P2: `accepted` is TRUE only when the ws is
    // OPEN and `send()` did not throw. It does NOT prove the bytes
    // reached the wire — a callback error after this returns will
    // surface as `proxied_response_send_failed_async` via the WS
    // server's own diagnostics. That post-hoc failure is
    // observable but this router has already consumed the origin,
    // so a lost proxied response cannot be replayed here.
    const accepted = this.opts.tuiForward.acceptProxiedResponseForSend(
      origin.tuiId as number | string,
      rewritten,
    );
    if (!accepted) {
      this.report("proxied_response_no_owner");
    }
  }

  private dispatchReverseRequest(frame: import("./protocol").JsonRpcRequestFrame): void {
    const decision = this.opts.humanOwner.handleUpstreamReverseRequest(frame);
    if (decision.kind === "reject_upstream") {
      // 副指挥 ff8edc19 Round 9: transport is caller-provided; a
      // non-async implementation may return a real Promise with
      // an OWN poisoned `.then/.catch` getter. Wrap the
      // writeFrame result via `safeAdoptConsume` so the getter
      // is read inside a protected scope and the (fresh) adopted
      // promise's rejection is consumed via an intrinsic-safe
      // attach — no unhandled rejection, no synchronous escape.
      // A single "upstream_reject_write_failed" diagnostic fires
      // regardless of failure mode.
      let writeResult: unknown;
      try {
        writeResult = this.opts.upstreamTransport.writeFrame(decision.upstreamError);
      } catch {
        this.report("upstream_reject_write_failed");
        return;
      }
      // 副指挥 9a9a198d Round 10: production callsite passes
      // diagnostics via `onCallbackError` so a callback-error
      // (e.g. `this.report` self-throw in some refactor) is
      // still observable via the sink rather than absorbed.
      safeAdoptConsume(
        writeResult,
        undefined,
        (_reason: unknown): undefined => {
          try { this.report("upstream_reject_write_failed"); }
          catch { /* absorbed */ }
          return undefined;
        },
        (_cbErr: unknown): undefined => {
          try { this.report("upstream_reject_callback_error"); }
          catch { /* absorbed */ }
          return undefined;
        },
      );
      return;
    }
    // Phase 1 approvalMode="never" never emits forward_tui, but if
    // it did we'd hand the frame to the TUI seam. Same accept-not-
    // delivered semantics as the proxied response path above.
    const accepted = this.opts.tuiForward.acceptReverseRequestForSend(decision.tuiFrame);
    if (!accepted) {
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
