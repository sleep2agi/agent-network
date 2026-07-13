// RFC-030 Wave 1A Segment C — lifecycle.ts
//
// Orchestration + injection layer. Does NOT own any queue, scheduler,
// ledger, owner-reservation policy, baseline / schema / SQLite gate,
// or upstream client — those all belong to B (per 副指挥 1e52976d /
// 2b40d91e Segment C narrowing). This module ONLY:
//
//   1. Owns a narrow `PreflightRunner` injection point. `start()`
//      awaits preflight BEFORE the UDS server begins accepting; a
//      failing preflight leaves NO socket path on disk.
//   2. Provides no-throw helper wrappers for `TuiInitializeProvider`
//      and `ProtocolDiagnostics`. Any self-throw inside the wrapped
//      source is degraded to a `undefined` snapshot / silent drop
//      respectively, and the sink self-report is swallowed.
//   3. Ships a Phase-1 `defaultDenyTuiAuthorizer` fake for use until
//      B's real bound-thread / reservation authorizer is wired in.
//      EVERY method is denied with `Busy` + explicit reason; the
//      allowlist is empty.
//   4. Provides `sendInternal` + `sendProxiedTui` pass-throughs to
//      the underlying GatewayServer so callers get one API surface.
//   5. Shutdown ordering: mark shutting_down → let injected
//      upstream transport tear itself down (which drains internal
//      Promise resolvers by rejecting them via the mux's origin
//      handles) → then stop the UDS server (which cleans sockets
//      and drainAll's the mux).
//
// The lifecycle does NOT reject internal Promises itself — it doesn't
// have their state. Segment C's contract with B: on `upstreamTransport
// .onClose()`, B's transport MUST call `resolve/reject` on every
// internal-scheduler origin it dispatched; lifecycle then drainAll's
// the mux to release any origins the transport didn't clean.

import {
  UpstreamRequestMux,
  ReverseRequestNamespace,
  type ProtocolBackend,
  type ProtocolDiagnostics,
  type TuiInitializeProvider,
  type TuiRequestAuthorizer,
  type JsonRpcRequestFrame,
  type JsonRpcRequestId,
  type TuiPolicyDecision,
  type InternalErrorEntry,
} from "./protocol";
import { GatewayErrorCode } from "./contract";
import {
  BackendUdsServer,
  type BackendUdsServerLimits,
  type InternalOrigin,
  type UpstreamTransport,
} from "./uds-server";
import { HumanOwnerCoordinator } from "./human-owner";
import { TuiWsServer } from "./tui-ws-server";
import { TuiBearer } from "./bearer";
import { UpstreamRouter, type TuiForwardSeam } from "./upstream-router";

// ────────────────────────────────────────────────────────────────────────
// PreflightRunner — narrow injection point
// ────────────────────────────────────────────────────────────────────────

/**
 * Narrow interface for the boot-time checks B is responsible for.
 *
 * A layer does NOT re-implement baseline / schema / SQLite gate /
 * upstream reconnect / backoff — those are B's L3 responsibilities.
 * This interface just gives lifecycle a way to await B's readiness
 * without knowing what "readiness" means (Codex version pin, digest
 * match, SQLite migration state, etc.).
 *
 * Called EXACTLY ONCE per `GatewayLifecycle.start()`. If the runner
 * rejects, `start()` rejects with the same error and NEVER opens
 * either UDS socket. If it resolves, the servers are bound + accept
 * connections.
 */
export interface PreflightRunner {
  run(): Promise<void>;
}

/** Convenience — trivial always-ok runner. Tests use it directly;
 *  production wires B's real preflight. */
export const NOOP_PREFLIGHT: PreflightRunner = { async run() { /* no-op */ } };

// ────────────────────────────────────────────────────────────────────────
// No-throw helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Wrap a `TuiInitializeProvider` so that a throw inside
 * `currentSnapshot()` degrades to `undefined` instead of propagating.
 * The dispatch layer then fails the TUI initialize with `Unavailable`
 * (Δ9 wiring) — same fail-closed treatment as "upstream not yet
 * initialised". Any thrown value is reported to the diagnostics sink.
 */
export function makeNoThrowInitializeProvider(
  source: TuiInitializeProvider,
  diagnostics: ProtocolDiagnostics,
): TuiInitializeProvider {
  return {
    currentSnapshot(): Readonly<Record<string, unknown>> | undefined {
      try {
        return source.currentSnapshot();
      } catch (e: unknown) {
        // Silent degrade, log to sink. Never propagate — a throw
        // here would hang a TUI initialize request.
        try {
          diagnostics.reportInternalError({
            correlationId: diagnostics.newCorrelationId(),
            operation: "tui_initialize_provider",
            error: e,
          });
        } catch { /* sink throw is also silent (see helper below) */ }
        return undefined;
      }
    },
  };
}

/**
 * Wrap a `ProtocolDiagnostics` so that both `newCorrelationId` and
 * `reportInternalError` are guaranteed no-throw. A throw from either
 * would deadlock a request (dispatch layers hold a `try/catch` that
 * calls the sink; a throw inside the sink escapes the catch). Fallback:
 *
 *   - newCorrelationId throw → return a stable fallback string
 *   - reportInternalError throw → swallow silently
 *
 * The wrapper does NOT chain to a secondary sink — that would
 * regress the invariant that a self-throwing sink can't cascade.
 */
export function makeNoThrowDiagnostics(source: ProtocolDiagnostics): ProtocolDiagnostics {
  return {
    newCorrelationId(): string {
      try {
        const id = source.newCorrelationId();
        // Extra guard: even a returned non-string is unsafe on the wire.
        return typeof id === "string" ? id : "cid-fallback";
      } catch {
        return "cid-fallback";
      }
    },
    reportInternalError(entry: InternalErrorEntry): void {
      try { source.reportInternalError(entry); } catch { /* silent */ }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Phase 1 default-deny fake authorizer
// ────────────────────────────────────────────────────────────────────────

/**
 * Phase 1 stand-in for B's real `TuiRequestAuthorizer`. The allowlist
 * is EXPLICITLY EMPTY: every method the TUI socket delivers to
 * `dispatchTuiRequest` classified as `policy_delegate` is denied with
 * `Busy` + a stable reason. Bootstrap methods (`initialize`,
 * `initialized`) are answered by `dispatchTuiRequest` before this
 * authorizer is consulted; `enqueueTask` etc. are refused at
 * `classifyTuiRequest` as reserved-agent-method.
 *
 * This authorizer NEVER default-allows — even Phase 2 turn-on must
 * swap in B's real authorizer, not tweak this fake. The allowlist
 * shape (empty set) makes silent regressions loud: any test that
 * relies on a specific method going through will fail visibly.
 */
export const defaultDenyTuiAuthorizer: TuiRequestAuthorizer = {
  async authorize(frame: JsonRpcRequestFrame): Promise<TuiPolicyDecision> {
    return {
      verdict: "deny",
      code: GatewayErrorCode.Busy,
      reason: "Phase 1 default-deny: B's authorizer not yet wired in",
      extra: {
        source: "default_deny_fake_authorizer",
        method: frame.method,
      },
    };
  },
};

/** Explicit empty allowlist accessor — asserts intent at code-review
 *  sites. Reads as `DEFAULT_DENY_ALLOWLIST.size === 0`, so grepping
 *  for a widened allowlist is a one-liner. */
export const DEFAULT_DENY_ALLOWLIST: ReadonlySet<string> = new Set<string>();

// ────────────────────────────────────────────────────────────────────────
// GatewayLifecycle
// ────────────────────────────────────────────────────────────────────────

export interface GatewayLifecycleOptions {
  readonly backendSocketPath: string;
  readonly socketDir: string;
  readonly preflight: PreflightRunner;
  /** Injected concrete backend (B / lifecycle-owned queue etc.). */
  readonly backend: ProtocolBackend;
  /** Injected upstream Codex transport (B). */
  readonly upstreamTransport: UpstreamTransport;
  /** Injected upstream initialize snapshot source. Wrapped in
   *  `makeNoThrowInitializeProvider` before use. */
  readonly initSnapshotSource: TuiInitializeProvider;
  /** Injected sink for internal error reports. Wrapped in
   *  `makeNoThrowDiagnostics` before use. */
  readonly diagnosticsSink: ProtocolDiagnostics;
  /**
   * TUI authorizer. If omitted, Phase 1 `defaultDenyTuiAuthorizer`
   * is used. Production wires B's real authorizer here.
   */
  readonly authorizer?: TuiRequestAuthorizer;
  /**
   * P0.2 Commit 1 corrective (副指挥 a1ed1589 item #13): production
   * has NO `approvalMode` config knob. Phase 1 pins to `"never"`
   * inside `doStart`. When B ships real upstream forwarding + a
   * Phase 2 policy this shape will be re-evaluated.
   */
  readonly limits?: Partial<BackendUdsServerLimits>;
  /**
   * Launcher-provisioned high-entropy capability for the backend
   * (Agent) UDS socket. Length >= 32. The TUI face uses a fresh
   * `TuiBearer` minted per lifecycle start; no separate config value.
   */
  readonly backendCapability: string;
}

/**
 * Lifecycle state machine (副指挥 3cb7ba9b Commit 2).
 *
 * Terminal states are `stopped` (clean teardown) and `stop_failed`
 * (close/abort surfaced an error or the bounded close timeout
 * elapsed and the forced abort itself threw). Reporting `stopped`
 * when the transport failed to close would be a lie — callers use
 * the truthful `stop_failed` to escalate.
 *
 * Transitions:
 *   created  → starting  (start())
 *   starting → running    (doStart resolves)
 *   starting → stopped    (rollbackStartFailure, no partial bind)
 *   starting → stop_failed (rollbackStartFailure with a
 *                           close/abort throw)
 *   running  → stopping   (stop() begins OR upstream close cascade)
 *   stopping → stopped    (clean teardown)
 *   stopping → stop_failed (bounded close timeout + abort throw,
 *                           or close throw + abort throw)
 *   * → * : no transition after a terminal state; stop() on a
 *           terminal state returns the cached final promise.
 */
export type LifecycleState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "stop_failed";

/**
 * 副指挥 3cb7ba9b Commit 2 #4: bounded timeout for a graceful
 * `upstreamTransport.close()`. If close hasn't resolved after this
 * many ms, lifecycle calls `abort()` and stops waiting on close.
 * Chosen small enough to keep an unresponsive transport from
 * blocking teardown indefinitely, but generous enough for a real
 * WebSocket / process-tree close handshake on healthy machines.
 */
export const UPSTREAM_CLOSE_TIMEOUT_MS = 2_000;

export class GatewayLifecycle {
  private readonly opts: GatewayLifecycleOptions;
  private state: LifecycleState = "created";
  private backendServer: BackendUdsServer | null = null;
  private tuiServer: TuiWsServer | null = null;
  private tuiBearer: TuiBearer | null = null;
  private upstreamRouter: UpstreamRouter | null = null;
  private humanOwner: HumanOwnerCoordinator | null = null;
  private mux: UpstreamRequestMux<InternalOrigin> | null = null;
  private reverseNs: ReverseRequestNamespace | null = null;
  /**
   * P0 fix (副指挥 9936fe24 item #6): stop-during-preflight fence.
   * Every await in `start` re-checks this flag; if stop() was
   * invoked mid-start, the fence short-circuits the remaining
   * construction, cleans up whatever landed, and lands in
   * `stopped`. Prevents "start races stop and revives with a live
   * socket" behavior.
   */
  private stopRequested = false;
  /** Promise that resolves once a concurrent start() settles.
   *  `stop()` awaits it so ordering is deterministic. */
  private startInProgress: Promise<void> | null = null;
  /**
   * 副指挥 e85ade40 P0-1: track which servers have actually bound
   * their listeners so async rollback awaits the correct stop()
   * calls. A synchronous rollback that nulls refs while a UDS
   * listener is still bound would report `stopped` while the socket
   * path remained connectable (repro:
   * `{"state":"stopped","socketExists":true,"socketAccepts":true}`).
   */
  private backendStarted = false;
  private tuiStarted = false;
  /**
   * 副指挥 3cb7ba9b Commit 2 #1 (shutdown single-flight): every
   * teardown entry point (`stop()`, `onUpstreamCloseFromRouter`,
   * `rollbackStartFailure` post-terminal reentries) funnels through
   * `runShutdown()` which memoises the shutdown Promise. Concurrent
   * callers share the SAME promise; the teardown sequence executes
   * at most once. Cleared only when we transition into a terminal
   * state (`stopped` / `stop_failed`).
   */
  private shutdownPromise: Promise<void> | null = null;
  /**
   * 副指挥 3cb7ba9b Commit 2 #5: truthful failure state. If
   * `upstreamTransport.close()` throws / times out AND the follow-up
   * `abort()` also throws, the lifecycle transitions to
   * `stop_failed` and preserves the cause here. Not cleared once
   * set — a lifecycle in `stop_failed` cannot recover.
   */
  private stopFailureError: Error | null = null;

  constructor(opts: GatewayLifecycleOptions) {
    this.opts = opts;
  }

  currentState(): LifecycleState {
    return this.state;
  }

  /**
   * 副指挥 3cb7ba9b Commit 2 #5: if the lifecycle ended in
   * `stop_failed`, return the captured cause. Callers use this to
   * escalate — a truthful `stop_failed` with the original error is
   * strictly better than a lying `stopped`.
   */
  stopFailure(): Error | null { return this.stopFailureError; }

  // 副指挥 1b24ae71 P1: raw coordinator accessor REMOVED. External
  // observers use typed snapshots (`humanOwnerAttached()` below) or
  // Node integration tests that construct a fresh coordinator.
  humanOwnerAttached(): boolean {
    return this.humanOwner?.attachSnapshot().attached ?? false;
  }

  /**
   * Start ordering:
   *   1. transition created → starting.
   *   2. run injected preflight. Throw on failure BEFORE any socket
   *      touches disk. No cleanup needed: nothing was created.
   *   3. instantiate the frozen mux + reverse namespace SINGLE
   *      instances.
   *   4. wrap the injected provider / diagnostics into no-throw
   *      helpers.
   *   5. construct HumanOwnerCoordinator (owns the reverse ns).
   *   6. construct + start GatewayServer (owns the sockets).
   *   7. transition starting → running.
   *
   * If step 6 throws, we mark stopped and rethrow. GatewayServer's
   * rollbackStart is responsible for unlinking anything it made.
   */
  async start(): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`cannot start from state '${this.state}'`);
    }
    this.state = "starting";
    const promise = this.doStart();
    this.startInProgress = promise;
    try {
      await promise;
    } finally {
      this.startInProgress = null;
    }
  }

  private async doStart(): Promise<void> {
    // 副指挥 1b24ae71 P0-1: construct the mux + reverseNs + coordinator
    // + UpstreamRouter BEFORE preflight. The router subscribes to the
    // upstream transport immediately and BUFFERS any frames received
    // during the preflight window. A close received before activate()
    // puts the router in terminal state and start() aborts.
    this.mux = new UpstreamRequestMux<InternalOrigin>();
    this.reverseNs = new ReverseRequestNamespace();

    const diagnostics = makeNoThrowDiagnostics(this.opts.diagnosticsSink);
    const initProvider = makeNoThrowInitializeProvider(this.opts.initSnapshotSource, diagnostics);
    const authorizer = this.opts.authorizer ?? defaultDenyTuiAuthorizer;

    this.humanOwner = new HumanOwnerCoordinator({
      mux: this.mux as unknown as UpstreamRequestMux<unknown>,
      reverseNs: this.reverseNs,
      diagnostics,
      approvalMode: "never",
    });

    this.tuiBearer = TuiBearer.mint();

    this.backendServer = new BackendUdsServer({
      socketPath: this.opts.backendSocketPath,
      socketDir: this.opts.socketDir,
      mux: this.mux,
      upstreamTransport: this.opts.upstreamTransport,
      diagnostics,
      backend: this.opts.backend,
      backendCapability: this.opts.backendCapability,
      limits: this.opts.limits,
    });

    this.tuiServer = new TuiWsServer({
      bearer: this.tuiBearer,
      humanOwner: this.humanOwner,
      authorizer,
      initProvider,
      diagnostics,
    });

    const tuiForward: TuiForwardSeam = {
      acceptReverseRequestForSend: (frame) => this.tuiServer!.acceptReverseRequestForSend(frame),
      acceptProxiedResponseForSend: (tuiId, frame) => this.tuiServer!.acceptProxiedResponseForSend(tuiId, frame),
    };
    this.upstreamRouter = new UpstreamRouter({
      mux: this.mux,
      humanOwner: this.humanOwner,
      upstreamTransport: this.opts.upstreamTransport,
      diagnostics,
      tuiForward,
      onUpstreamClose: () => this.onUpstreamCloseFromRouter(),
    });
    // 副指挥 06e92ef7 P0-5: subscribe is atomic — if the second
    // subscription throws, subscribe() itself rolls back the first
    // handler internally (see upstream-router.ts). At this level we
    // additionally wrap the whole init in a try/catch so any
    // constructor / subscribe throw lands cleanly in stopped.
    try {
      this.upstreamRouter.subscribe();
    } catch (e) {
      await this.rollbackStartFailure();
      throw e;
    }

    // 副指挥 e85ade40 P0-1: async fence. AWAITS the rollback so any
    // partially-bound listener is stopped BEFORE state=stopped is
    // set and refs are nulled. Prior sync fence returned `stopped`
    // while the UDS listener was still accepting.
    const throwIfAbortedAfterAwait = async (label: string): Promise<void> => {
      if (this.upstreamRouter?.wasCloseBeforeActive() || this.upstreamRouter?.currentState() === "terminal") {
        await this.rollbackStartFailure();
        throw new Error(`start aborted: upstream closed (${label})`);
      }
      if (this.stopRequested) {
        await this.rollbackStartFailure();
        throw new Error(`start aborted by concurrent stop (${label})`);
      }
    };

    try {
      await this.opts.preflight.run();
    } catch (e) {
      await this.rollbackStartFailure();
      throw e;
    }
    await throwIfAbortedAfterAwait("preflight");

    try {
      await this.backendServer.start();
      this.backendStarted = true;
    } catch (e) {
      // 副指挥 e85ade40 P0-1: defensive — mark started so rollback
      // awaits stop() even if start() rejected after a partial bind.
      // BackendUdsServer.start() sets `this.running = true` before
      // returning; a mid-start throw between bind and running=true
      // is the rare case, but stop() is a no-op on !running so this
      // is safe.
      this.backendStarted = true;
      await this.rollbackStartFailure();
      throw e;
    }
    await throwIfAbortedAfterAwait("backend_start");

    try {
      await this.tuiServer.start();
      this.tuiStarted = true;
    } catch (e) {
      this.tuiStarted = true; // defensive: partial bind → stop() anyway
      await this.rollbackStartFailure();
      throw e;
    }
    await throwIfAbortedAfterAwait("tui_start");

    // Activate the router only when it is still healthy. If a close
    // arrived earlier, `wasCloseBeforeActive` would have made
    // `throwIfAbortedAfterAwait` fire already.
    this.upstreamRouter.activate();
    if (this.upstreamRouter.currentState() === "terminal") {
      await this.rollbackStartFailure();
      throw new Error("start aborted: upstream closed during activate");
    }

    this.state = "running";
  }

  /**
   * 副指挥 e85ade40 P0-1: rollback is now ASYNC. If a server has
   * bound its listener (`backendStarted` / `tuiStarted`), we AWAIT
   * its `stop()` BEFORE nulling refs and setting `state="stopped"`.
   * Otherwise a caller reading `currentState()` would see
   * `"stopped"` while the UDS socket path still accepts connections
   * (repro: {startResult:"rejected:start aborted by concurrent stop
   * (backend_start)", state:"stopped", socketExists:true,
   * socketAccepts:true}).
   *
   * Ordering:
   *   1. unsubscribe the router (idempotent) — no new frames route.
   *   2. AWAIT tuiServer.stop() if started (WS listener close).
   *   3. AWAIT backendServer.stop() if started (UDS unlink + socket
   *      cleanup + created-paths sweep — write-path critical to the
   *      P0-1 repro).
   *   4. BOUNDED `upstreamTransport.close()` (副指挥 3cb7ba9b
   *      Commit 2 #4) — the graceful close is raced against
   *      `UPSTREAM_CLOSE_TIMEOUT_MS`; timeout / throw escalates to
   *      the REQUIRED `abort()`. If both close and abort fail we
   *      still complete the rollback but land in `stop_failed`
   *      instead of `stopped` (Commit 2 #5). Start's outer throw
   *      still surfaces; observers read `stopFailure()` for the
   *      cause.
   *   5. Rotate bearer + null every ref.
   *   6. drainAll mux + reverseNs so any registered origins release.
   *   7. state = "stopped" iff close cleanly resolved; else
   *      "stop_failed" with the cause preserved.
   */
  private async rollbackStartFailure(): Promise<void> {
    try { this.upstreamRouter?.unsubscribe(); } catch { /* silent */ }
    if (this.tuiStarted && this.tuiServer !== null) {
      try { await this.tuiServer.stop(); } catch { /* silent */ }
    }
    if (this.backendStarted && this.backendServer !== null) {
      try { await this.backendServer.stop(); } catch { /* silent */ }
    }
    // 副指挥 3cb7ba9b Commit 2 #4: bounded close even during
    // start rollback. A hung transport during preflight cleanup
    // must NOT wedge start().
    const upstreamOutcome = await this.closeUpstreamBounded();
    if (this.tuiBearer !== null) {
      try { this.tuiBearer.rotate(); } catch { /* silent */ }
      this.tuiBearer = null;
    }
    this.upstreamRouter = null;
    this.backendServer = null;
    this.tuiServer = null;
    this.humanOwner = null;
    if (this.mux !== null) { try { this.mux.drainAll(); } catch { /* silent */ } this.mux = null; }
    if (this.reverseNs !== null) { try { this.reverseNs.drainAll(); } catch { /* silent */ } this.reverseNs = null; }
    this.backendStarted = false;
    this.tuiStarted = false;
    if (upstreamOutcome.kind === "ok") {
      this.state = "stopped";
    } else {
      this.stopFailureError = upstreamOutcome.error;
      this.state = "stop_failed";
    }
  }

  /**
   * Callback the sole `UpstreamRouter` invokes when the injected
   * transport signals close. Funnels the upstream-close cascade
   * into the SAME single-flight shutdown promise a manual `stop()`
   * would use (副指挥 3cb7ba9b Commit 2 #1 + #2). No inline
   * cascade — teardown ordering is centralised in `doShutdown()`
   * so a race between upstream close and a concurrent stop() runs
   * the sequence exactly once.
   */
  private onUpstreamCloseFromRouter(): void {
    if (this.state === "running") {
      this.state = "stopping";
    }
    // Fire-and-forget; the runShutdown Promise is memoised so a
    // subsequent stop() will await the same one.
    void this.runShutdown();
  }

  /**
   * 副指挥 3cb7ba9b Commit 2 #1: shutdown single-flight. Concurrent
   * callers (`stop()` × `stop()`, `stop()` × upstream close cascade,
   * `stop()` from a start-rollback path) receive the SAME cached
   * Promise. The teardown sequence executes at most once; each
   * caller awaits its completion. On terminal state, subsequent
   * calls resolve immediately.
   */
  async stop(): Promise<void> {
    return this.runShutdown();
  }

  private runShutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.stopRequested = true;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  /**
   * Stop ordering (副指挥 3cb7ba9b Commit 2 #2, #4, #5, #6):
   *   1. Wait for any in-flight start() so ordering is
   *      deterministic. Start's own fences may already have landed
   *      us in `stopped` / `stop_failed`.
   *   2. If already terminal, return.
   *   3. `state = "stopping"`. Unsubscribe the router so no new
   *      frames dispatch during teardown.
   *   4. `backendServer.stop()` (idempotent, best-effort — a Node
   *      net server close cannot itself hang forever the way the
   *      upstream transport can).
   *   5. `tuiServer.stop()` (same rationale).
   *   6. Rotate the TUI bearer.
   *   7. Bounded `upstreamTransport.close()` — race the graceful
   *      close against `UPSTREAM_CLOSE_TIMEOUT_MS`. Any of {close
   *      throws, close times out} escalates to the REQUIRED
   *      `abort()` contract. Abort throw itself → `stop_failed`
   *      with the abort error preserved.
   *   8. Drain pending origins exactly once (mux + reverseNs
   *      `drainAll` — both are one-shot).
   *   9. Transition to terminal: `stopped` iff close cleanly
   *      resolved, else `stop_failed`.
   */
  private async doShutdown(): Promise<void> {
    if (this.startInProgress !== null) {
      try { await this.startInProgress; } catch { /* start rejected already lands in a terminal state */ }
    }
    if (this.state === "stopped" || this.state === "stop_failed") return;
    if (this.state === "created") { this.state = "stopped"; return; }
    this.state = "stopping";
    if (this.upstreamRouter !== null) {
      try { this.upstreamRouter.unsubscribe(); } catch { /* silent */ }
      this.upstreamRouter = null;
    }
    if (this.backendServer !== null) {
      try { await this.backendServer.stop(); } catch { /* best-effort */ }
      this.backendServer = null;
    }
    if (this.tuiServer !== null) {
      try { await this.tuiServer.stop(); } catch { /* best-effort */ }
      this.tuiServer = null;
    }
    this.backendStarted = false;
    this.tuiStarted = false;
    if (this.tuiBearer !== null) {
      try { this.tuiBearer.rotate(); } catch { /* silent */ }
      this.tuiBearer = null;
    }
    const upstreamOutcome = await this.closeUpstreamBounded();
    // 副指挥 3cb7ba9b Commit 2 #6: drain pending exactly once. Mux
    // + reverseNs `drainAll` are one-shot by construction; guard
    // still applies belt-and-braces for a re-entered path.
    if (this.mux !== null) {
      try { this.mux.drainAll(); } catch { /* silent */ }
      this.mux = null;
    }
    if (this.reverseNs !== null) {
      try { this.reverseNs.drainAll(); } catch { /* silent */ }
      this.reverseNs = null;
    }
    this.humanOwner = null;
    if (upstreamOutcome.kind === "ok") {
      this.state = "stopped";
    } else {
      this.stopFailureError = upstreamOutcome.error;
      this.state = "stop_failed";
    }
  }

  /**
   * Bounded upstream close (副指挥 3cb7ba9b Commit 2 #3 + #4 + #5).
   *
   * - Race `opts.upstreamTransport.close()` against a
   *   `UPSTREAM_CLOSE_TIMEOUT_MS` timer.
   * - Clean resolve → `{kind: "ok"}`, no abort needed.
   * - Close throws or times out → call the REQUIRED `abort()`.
   *     - abort returns → `{kind: "failed", error}` where `error`
   *       preserves the ORIGINAL cause (close throw / timeout);
   *       terminal state becomes `stop_failed` per Commit 2 #5.
   *     - abort itself throws → `{kind: "failed", error}` where
   *       `error` preserves the abort throw (the more actionable
   *       cause — abort is the required force-terminate contract).
   * - After abort we do NOT wait on the graceful close any longer.
   */
  private async closeUpstreamBounded(): Promise<
    | { kind: "ok" }
    | { kind: "failed"; error: Error }
  > {
    let closeError: Error | null = null;
    let timedOut = false;
    let closeSettled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closePromise = Promise.resolve()
      .then(() => this.opts.upstreamTransport.close())
      .then(
        () => { closeSettled = true; },
        (e: unknown) => {
          closeSettled = true;
          closeError = e instanceof Error ? e : new Error(String(e));
        },
      );
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, UPSTREAM_CLOSE_TIMEOUT_MS);
    });
    await Promise.race([closePromise, timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);
    if (closeSettled && closeError === null) {
      return { kind: "ok" };
    }
    // Either close threw or the bounded timer fired first. Escalate
    // to the REQUIRED abort contract.
    const originalCause: Error = closeError !== null
      ? closeError
      : new Error(`upstream close timed out after ${UPSTREAM_CLOSE_TIMEOUT_MS}ms`);
    try {
      this.opts.upstreamTransport.abort();
      // Abort returned. The transport IS force-terminated, but the
      // clean-close contract failed — preserve the ORIGINAL cause
      // and report `stop_failed` so callers know something misbehaved.
      return { kind: "failed", error: originalCause };
    } catch (e) {
      const abortError = e instanceof Error ? e : new Error(String(e));
      // Preserve the abort throw as the primary cause (abort is the
      // required force-terminate; if it fails there's no fallback).
      // Attach the original cause via `.cause` for observability.
      // (Node's Error `cause` option; a diagnostics sink can inspect
      // both.)
      return { kind: "failed", error: new Error(abortError.message, { cause: originalCause }) };
    }
  }

  // ─────────── Transport pass-throughs ───────────

  sendInternal<T = unknown>(method: string, params: unknown | undefined, label = method): Promise<T> {
    if (this.state !== "running" || this.backendServer === null) {
      return Promise.reject(new Error(`sendInternal called in state '${this.state}'`));
    }
    return this.backendServer.sendInternal<T>(method, params, label);
  }

  // ─────────── Test-only inspectors ───────────

  /** Fresh TUI bearer plaintext, callable ONCE. Returns null once the
   *  bearer has been claimed (either via presentBearer on the WS
   *  admission path or via this method being called by the launcher). */
  takeTuiBearerPlaintextForLauncher(): string | null {
    // 副指挥 06e92ef7 P0-2: refuse in non-running state so a fail-
    // closed / stop-during-preflight caller cannot claim a bearer
    // for a lifecycle that never opened its sockets.
    if (this.state !== "running") return null;
    if (this.tuiBearer === null) return null;
    return this.tuiBearer.takePlaintextForLauncher();
  }

  tuiWsPortActual(): number {
    return this.tuiServer?.boundPortActual() ?? 0;
  }

  connectionCount(): number {
    return this.backendServer?.connectionCount() ?? 0;
  }

  pendingUpstreamCount(kind?: "proxied_tui" | "internal"): number {
    if (this.mux === null) return 0;
    return kind === undefined ? this.mux.pendingCount() : this.mux.pendingCountByKind(kind);
  }

  pendingReverseCount(): number {
    return this.reverseNs?.pendingCount() ?? 0;
  }
}
