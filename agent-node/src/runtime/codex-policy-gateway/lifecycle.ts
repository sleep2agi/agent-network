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
 * 副指挥 cdd20559 P0: total, non-throwing coercion of any value
 * (including non-Error rejections whose `String(...)` throws) into
 * an `Error` object.
 *
 * Layers:
 *   1. `instanceof Error` is wrapped in try/catch — a hostile
 *      `Symbol.hasInstance` trap on a subclass could throw; we
 *      swallow it and fall through.
 *   2. `Object.prototype.toString.call(x)` — does NOT invoke any
 *      user-defined `toString`/`valueOf`, so cannot be poisoned by
 *      the caller's object.
 *   3. If step 2 also throws (extremely rare — would require a
 *      poisoned global prototype trap), fall back to a fixed
 *      synthetic marker so shutdown always converges.
 *
 * NEVER throws. Preserves original Error identity when the value
 * IS already an Error.
 */
function toError(value: unknown): Error {
  try {
    if (value instanceof Error) return value;
  } catch { /* poisoned Symbol.hasInstance on RHS proxy — fall through */ }
  let tag: string;
  try {
    tag = Object.prototype.toString.call(value);
  } catch {
    tag = "<un-stringifiable rejection value>";
  }
  return new Error(tag);
}

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

/**
 * 副指挥 d53209eb #2: bounded timeout for LOCAL server stops
 * (Backend UDS listener + TUI WS listener). Their graceful
 * `.close(cb)` waits for every connected client to close its
 * socket; a hostile client can wedge that forever. Bounded stop
 * escalates to `forceTerminate()`.
 */
export const LOCAL_STOP_TIMEOUT_MS = 1_000;

/**
 * 副指挥 0bd525d0 P1-2: bounded timeout for the REQUIRED
 * `abort()` promise contract. If `abort()` returns a Promise that
 * takes longer than this to resolve/reject, the lifecycle stops
 * waiting and lands in `stop_failed`.
 */
export const UPSTREAM_ABORT_TIMEOUT_MS = 1_000;

/**
 * Internal teardown outcome record — returned by
 * `runTeardownCore()`. `stop()` observes the terminal state via
 * `currentState()` and (for stop_failed) `stopFailure()`.
 */
interface TeardownOutcome {
  readonly terminal: "stopped" | "stop_failed";
  readonly primary: Error | null;
  readonly ledger: TeardownFailureLedger;
}

/**
 * 副指挥 0bd525d0 P1-1: stage-labeled failure ledger. Each stage
 * has its own slot so a multi-failure teardown never overwrites
 * any of the four original error causes. `stopFailure()` returns
 * the PRIMARY (per an explicit ordering — see `pickPrimary` below);
 * `stopFailureCloseCauseError()` returns ONLY the upstream close
 * cause; a new `stopFailureLedger()` returns the full record.
 */
export interface TeardownFailureLedger {
  readonly backendStop: Error | null;
  readonly tuiStop: Error | null;
  readonly upstreamClose: Error | null;
  readonly upstreamAbort: Error | null;
}

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
   * 副指挥 d53209eb #4/#6: single-flight TEARDOWN CORE. `stop()`,
   * `onUpstreamCloseFromRouter`, AND `rollbackStartFailure` all
   * enter this one memoised promise. The `shutdownPromise` above
   * is the OUTER stop() wrapper that additionally awaits any
   * in-flight `startInProgress` before entering the core.
   */
  private teardownCorePromise: Promise<TeardownOutcome> | null = null;
  /**
   * @internal Test-only counter. Reachable via cast
   * `(lifecycle as unknown as { teardownCoreEnteredCountValue: number })`.
   * Increments exactly once per successful teardown regardless of
   * how many shutdown entry points raced (public `stop()`, upstream
   * close cascade, start rollback). No public accessor —
   * `GatewayLifecycle` is exported from `integration-entry.ts`
   * so a public method would be part of the production API.
   */
  private teardownCoreEnteredCountValue = 0;
  /**
   * 副指挥 3cb7ba9b Commit 2 #5 + d53209eb #7: truthful failure.
   * `stopFailureError` retains the PRIMARY error object identity
   * — the raw `TypeError` / custom-code Error thrown by
   * `abort()`, or the close error if abort was skipped. NEVER a
   * new Error wrapper. `stopFailureCloseCause` stores a secondary
   * close/timeout cause when the primary is an abort throw and
   * we couldn't (or wouldn't) attach it via `.cause` on the
   * primary Error object.
   */
  private stopFailureError: Error | null = null;
  private stopFailureLedgerRecord: TeardownFailureLedger = {
    backendStop: null, tuiStop: null, upstreamClose: null, upstreamAbort: null,
  };
  /**
   * 副指挥 e8cdc302 Round 7: monotonic lifecycle epoch. Incremented
   * synchronously on EVERY shutdown intent (`stop()`, upstream
   * close cascade, start rollback) via `applySyncAdmissionFence()`.
   * `start()` captures its epoch at admission; every start-side
   * continuation (subscribe / preflight settle / bind / activate
   * commit) refuses to advance unless the epoch still matches.
   * The final `state = "running"` write is CAS-guarded on this
   * value — a stop that fired during activate() cannot be
   * clobbered back to `running`.
   *
   * The epoch is INDEPENDENT of `state` — `state` is the terminal-
   * facing observable, but a mid-teardown state could technically
   * be re-observed by a stale continuation. The epoch is
   * strictly monotonic; a stale continuation observing an epoch
   * mismatch knows unambiguously that a shutdown intent has fired
   * and its work is forfeit.
   */
  private lifecycleEpoch = 0;
  /**
   * 副指挥 b65ebc50 Round 7: shutdown signal. Resolves the first
   * time `applySyncAdmissionFence()` runs. `preflight.run()` is
   * raced against this signal so a never-resolving preflight
   * cannot wedge `stop()`.
   */
  private shutdownSignalResolve: () => void = () => {};
  private shutdownSignalPromise: Promise<void> = new Promise<void>((res) => {
    this.shutdownSignalResolve = res;
  });

  constructor(opts: GatewayLifecycleOptions) {
    this.opts = opts;
  }

  currentState(): LifecycleState {
    return this.state;
  }

  /**
   * 副指挥 3cb7ba9b Commit 2 #5 + d53209eb #7: primary abort/close
   * cause. Returns the ORIGINAL Error identity (`TypeError`, custom
   * `.code`, stack) — never a wrapper. If `abort()` was skipped
   * (close cleanly resolved), returns null.
   */
  stopFailure(): Error | null { return this.stopFailureError; }
  /**
   * 副指挥 0bd525d0 P1-1: returns ONLY the upstream `close()` cause
   * (throw or timeout Error). Never a local backend/TUI failure.
   * Null when close resolved cleanly OR when close was never
   * reached.
   */
  stopFailureCloseCauseError(): Error | null {
    return this.stopFailureLedgerRecord.upstreamClose;
  }
  /**
   * 副指挥 0bd525d0 P1-1: full stage-labeled ledger. Each of the
   * four teardown stages has its own slot; a multi-failure
   * teardown never overwrites any of the four original error
   * causes. Observers should prefer this accessor for anything
   * beyond the two summary accessors above.
   */
  stopFailureLedger(): TeardownFailureLedger { return this.stopFailureLedgerRecord; }

  // 副指挥 1b24ae71 P1: raw coordinator accessor REMOVED. External
  // observers use typed snapshots (`humanOwnerAttached()` below) or
  // Node integration tests that construct a fresh coordinator.
  humanOwnerAttached(): boolean {
    return this.humanOwner?.attachSnapshot().attached ?? false;
  }

  /**
   * Start ordering (副指挥 dd12966c):
   *   `doStart()` wraps ALL of `doStartInner()` in a unified
   *   try/catch. Any throw from construction (mux / reverseNs /
   *   coordinator / bearer / BackendUdsServer / TuiWsServer /
   *   UpstreamRouter constructor), subscribe, preflight, bind, or
   *   activate funnels through `rollbackStartFailure()` → the
   *   memoised teardown core. Terminal state is `stopped` on a
   *   clean rollback; `stop_failed` if any teardown stage itself
   *   surfaced an error.
   *
   *   The per-phase try/catch blocks inside `doStartInner()` are
   *   retained as defence-in-depth but are structurally redundant
   *   under the outer wrapper — all failure paths reach the same
   *   memoised core exactly once.
   */
  async start(): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`cannot start from state '${this.state}'`);
    }
    this.state = "starting";
    // 副指挥 e8cdc302 Round 7: capture epoch at admission BEFORE
    // any body runs. Every continuation checks
    // `epoch === this.lifecycleEpoch`; a stale continuation whose
    // epoch no longer matches rolls back and refuses to commit.
    const startEpoch = this.lifecycleEpoch;
    // 副指挥 b65ebc50 Round 7: publish `startInProgress` SYNC via
    // deferred BEFORE any body runs. Prior code called
    // `this.doStart()` first (its sync prefix ran, including
    // `router.subscribe()` which could sync-fire close handlers
    // that reenter `stop()`), then assigned `startInProgress`.
    // A reentrant `stop()` during subscribe saw `startInProgress
    // === null`, entered the teardown core synchronously, and
    // tried to unsubscribe a router whose `frameUnsub` /
    // `closeUnsub` hadn't been stored yet — real transport
    // handler leak. Same shape as `stop()` / `runTeardownCore()`:
    // deferred first, body bridged via `.then`.
    let resolveStart!: () => void;
    let rejectStart!: (e: unknown) => void;
    const startDeferred = new Promise<void>((res, rej) => {
      resolveStart = res;
      rejectStart = rej;
    });
    this.startInProgress = startDeferred;
    this.doStart(startEpoch).then(resolveStart, rejectStart);
    try {
      await startDeferred;
    } finally {
      this.startInProgress = null;
    }
  }

  private async doStart(startEpoch: number): Promise<void> {
    // 副指挥 dd12966c: the ENTIRE doStart body — construction,
    // subscribe, preflight, bind, activate — is wrapped in a
    // unified catch that funnels ANY throw through
    // `rollbackStartFailure`, which enters the memoised teardown
    // core.
    try {
      await this.doStartInner(startEpoch);
    } catch (e) {
      await this.rollbackStartFailure();
      throw e;
    }
  }

  private async doStartInner(startEpoch: number): Promise<void> {
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
      // 副指挥 ef331a80 Round 8: pre-active close bubbles to the
      // shutdown signal so a `Promise.race([preflight, signal])`
      // is unblocked even if no external `stop()` fires. Bumps the
      // epoch monotonically so post-subscribe continuations refuse
      // to advance.
      onPreActiveClose: () => this.applySyncAdmissionFence(),
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
    // 副指挥 cb54a10e Round 8: subscribe→preflight CAS fence.
    // `onFrame` registration inside `router.subscribe()` can
    // synchronously fire a handler that calls `stop()` (or
    // synchronously delivers a close that fires
    // `onPreActiveClose`). Both bump the epoch. Without an
    // immediate post-subscribe check, `preflight.run()` would
    // still be called (preflightCalls=1) AND its handler could
    // write a frame to the upstream (writes=1) before the fence
    // in `throwIfAbortedAfterAwait` after the preflight settle.
    // Refuse to advance if the epoch shifted OR shutdown intent
    // has fired OR router saw a pre-active close.
    const preActiveClosePre = this.upstreamRouter.wasCloseBeforeActive();
    if (
      startEpoch !== this.lifecycleEpoch
      || this.stopRequested
      || preActiveClosePre
    ) {
      // Capture message BEFORE rollback so a nulled `upstreamRouter`
      // after `runTeardownCore()` doesn't crash the error format.
      const msg = `start aborted before preflight: shutdown intent during subscribe (epoch=${startEpoch}/${this.lifecycleEpoch}, stopRequested=${this.stopRequested}, preActiveClose=${preActiveClosePre})`;
      await this.rollbackStartFailure();
      throw new Error(msg);
    }

    // 副指挥 e8cdc302 Round 7: epoch fence. EVERY continuation
    // checks that our captured `startEpoch` still matches the
    // current `this.lifecycleEpoch`. A shutdown intent bumps
    // the epoch monotonically inside `applySyncAdmissionFence`,
    // so any post-await continuation with a stale epoch knows
    // unambiguously to bail out — no need to trust a mutable
    // `stopRequested` flag alone.
    const throwIfAbortedAfterAwait = async (label: string): Promise<void> => {
      if (startEpoch !== this.lifecycleEpoch) {
        await this.rollbackStartFailure();
        throw new Error(`start aborted: lifecycle epoch changed (${label})`);
      }
      if (this.upstreamRouter?.wasCloseBeforeActive() || this.upstreamRouter?.currentState() === "terminal") {
        await this.rollbackStartFailure();
        throw new Error(`start aborted: upstream closed (${label})`);
      }
      if (this.stopRequested) {
        await this.rollbackStartFailure();
        throw new Error(`start aborted by concurrent stop (${label})`);
      }
    };

    // 副指挥 b65ebc50 + cb54a10e Round 8: race preflight against
    // the shutdown signal via SAFE adoption. `preflight.run()`
    // returns a caller-provided Promise-like whose own
    // `.then/.catch` may be poisoned. Never touch instance
    // getters — adopt into a native Promise via
    // `Promise.resolve(preflightP)`, which uses the native
    // adoption path (any getter throw becomes a rejection of the
    // adopted Promise instead of throwing out of the attach). No
    // separate `.catch()` consumer is attached: `Promise.race`
    // already attaches its own resolver via the native `.then`
    // machinery, so a late rejection of `preflightP` has a
    // handler and cannot surface as `unhandledRejection`.
    const preflightP = this.opts.preflight.run();
    const safePreflightP = Promise.resolve(preflightP);
    try {
      await Promise.race([
        safePreflightP,
        this.shutdownSignalPromise.then(() => {
          throw new Error("start aborted: shutdown signalled during preflight");
        }),
      ]);
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
    // 副指挥 e8cdc302 Round 7: post-activate CAS commit. Activate
    // synchronously dispatches any buffered upstream frames — a
    // diagnostics-sink handler could call `stop()` during that
    // dispatch, which would sync-bump the epoch. We refuse to
    // commit `state = "running"` unless the epoch we captured
    // AT ADMISSION still matches AND the state is still
    // `starting` (i.e., the sync fence hasn't touched it). Any
    // mismatch enters the same memoised rollback and rejects
    // start — NO admission revive.
    if (
      startEpoch !== this.lifecycleEpoch
      || this.state !== "starting"
      || this.stopRequested
      || this.upstreamRouter.currentState() === "terminal"
    ) {
      await this.rollbackStartFailure();
      throw new Error(
        `start aborted after activate (epoch=${startEpoch}/${this.lifecycleEpoch}, state=${this.state}, stopRequested=${this.stopRequested})`,
      );
    }
    // CAS commit: state === "starting" AND epoch matches. Publish
    // the terminal "running" observable.
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
   *   4. All bounded / abort / preserve-identity semantics live in
   *      `runTeardownCore()`; rollback simply enters the memoised
   *      core with `stopRequested = true` (副指挥 d53209eb #4).
   *   5. Terminal state = whatever the core returned. `start()`
   *      still throws the outer error to its caller; observers
   *      read `stopFailure()` for the transport-side cause.
   */
  private async rollbackStartFailure(): Promise<void> {
    this.stopRequested = true;
    // Enter the SAME memoised teardown core the public stop path
    // uses. If a concurrent stop() awaits `startInProgress`, it
    // will see the terminal state after we return and short-
    // circuit — but if it enters concurrently, both awaits attach
    // to the same `teardownCorePromise`.
    await this.runTeardownCore();
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
    // Fire-and-forget through the same outer `stop()` wrapper so
    // that concurrent stop() callers share the exact same
    // Promise (副指挥 d53209eb #3 identity).
    // 副指挥 cdd20559 P0: even though `stop()` is designed never
    // to reject (doTeardownCore returns TeardownOutcome; no throw
    // path), attach a `.catch` sink so a hypothetical regression
    // that introduced a rejection cannot surface as unhandled from
    // this cascade path.
    void this.stop().catch(() => { /* consumed defensively */ });
  }

  /**
   * 副指挥 d53209eb #3: `stop()` is NON-async. It returns the
   * memoised `shutdownPromise` directly, so two concurrent
   * callers get p1 === p2 === p3 exactly. If it were declared
   * `async`, TS wraps the return in an adoption Promise on each
   * invocation, breaking identity.
   *
   * The outer `shutdownPromise` awaits any in-flight `startInProgress`
   * before entering the memoised teardown core.
   */
  stop(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.stopRequested = true;
    // 副指挥 8cd477e9 Round 6: publish the memo SYNC via a
    // deferred + immediately-invoked body — round-5's
    // `Promise.resolve().then(...)` delayed the ENTIRE body to a
    // microtask, which opened an admission window:
    //   - `running` + `stop()` → state still `running`; bearer
    //     still claimable; sendInternal still writes.
    //   - `created` + `stop()` + same-turn `start()` → stop
    //     completed but state still `created`; start ran real
    //     preflight; a never-resolving preflight wedged stop.
    // Round 6 fix: sync state fence (running → stopping, created
    // → stopped) + sync bearer rotate + sync memo publish via
    // deferred. Body then runs synchronously up to its first
    // await; any reentrance sees a non-null memo. Public Promise
    // identity is preserved (`this.shutdownPromise` is the same
    // deferred every caller receives).
    this.applySyncAdmissionFence();
    let resolveShutdown: () => void = () => {};
    let rejectShutdown: (e: unknown) => void = () => {};
    const deferred = new Promise<void>((res, rej) => {
      resolveShutdown = res;
      rejectShutdown = rej;
    });
    this.shutdownPromise = deferred;
    // Invoke body synchronously — memo is already visible to any
    // reentrant `stop()` triggered by the body's sync prefix.
    this.doOuterStop().then(resolveShutdown, rejectShutdown);
    return this.shutdownPromise;
  }

  /**
   * 副指挥 8cd477e9 Round 6: synchronous admission fence.
   * Applied as the FIRST step of `stop()` so a caller observing
   * `currentState()`, `takeTuiBearerPlaintextForLauncher()`, or
   * `sendInternal()` immediately after `stop()` returns sees the
   * closed door — no admission window.
   *
   *   - `running`  → `stopping` (sendInternal gate rejects; new
   *      bearer claims refused by state check).
   *   - `starting` → `stopping` (the epoch fence via
   *      `stopRequested` above still triggers; state visible now).
   *   - `created`  → `stopped` (idempotent for the never-started
   *      case; a subsequent `start()` throws
   *      "cannot start from state 'stopped'").
   *   - Bearer rotated NOW so `takeTuiBearerPlaintextForLauncher`
   *      returns null immediately.
   *   - `stop_failed` / `stopping` / `stopped` are already
   *      terminal-ish; unchanged here.
   */
  private applySyncAdmissionFence(): void {
    // 副指挥 e8cdc302 Round 7: bump the monotonic epoch FIRST so
    // any start-side continuation running after this fence sees a
    // mismatched epoch and refuses to advance. Epoch is a plain
    // counter — value is unimportant, only strict monotonicity.
    this.lifecycleEpoch++;
    if (this.state === "created") {
      this.state = "stopped";
    } else if (this.state === "running" || this.state === "starting") {
      this.state = "stopping";
    }
    if (this.tuiBearer !== null) {
      try { this.tuiBearer.rotate(); } catch { /* silent */ }
    }
    // Fire the shutdown signal — preflight race unblocks; late
    // resolves/rejects are consumed by the safe-consume `.catch`
    // attached where the preflight promise is spawned.
    try { this.shutdownSignalResolve(); } catch { /* silent */ }
  }

  private async doOuterStop(): Promise<void> {
    if (this.startInProgress !== null) {
      try { await this.startInProgress; } catch { /* start rejected — a rollback lands in a terminal state */ }
    }
    if (this.state === "stopped" || this.state === "stop_failed") return;
    if (this.state === "created") { this.state = "stopped"; return; }
    // Enter the memoised teardown core — rollback would have
    // already been in it if start rejected.
    await this.runTeardownCore();
  }

  /**
   * 副指挥 d53209eb #4: single-flight teardown CORE. All three
   * entry points (public `stop()` via `doOuterStop`, upstream
   * close cascade via `onUpstreamCloseFromRouter`, start
   * rollback via `rollbackStartFailure`) resolve to the SAME
   * memoised Promise. The core sequence executes at most once.
   */
  private runTeardownCore(): Promise<TeardownOutcome> {
    if (this.teardownCorePromise !== null) return this.teardownCorePromise;
    this.teardownCoreEnteredCountValue++;
    // 副指挥 8cd477e9 Round 6: sync memo publish via deferred.
    // `doTeardownCore()`'s first sync step is
    // `router.unsubscribe()`. If the transport's frame-unsubscribe
    // fires close handlers synchronously, the reentrant
    // `onUpstreamCloseFromRouter → stop() → runTeardownCore()`
    // path must see `teardownCorePromise !== null`. Round-5's
    // `Promise.resolve().then(...)` deferred the WHOLE body to a
    // microtask (see `stop()` note); round-6 publishes the
    // deferred SYNC and invokes the body immediately after —
    // memo visible before any body code runs, and no admission
    // window.
    let resolveCore: (v: TeardownOutcome) => void = () => {};
    let rejectCore: (e: unknown) => void = () => {};
    const deferred = new Promise<TeardownOutcome>((res, rej) => {
      resolveCore = res;
      rejectCore = rej;
    });
    this.teardownCorePromise = deferred;
    this.doTeardownCore().then(resolveCore, rejectCore);
    return this.teardownCorePromise;
  }

  // 副指挥 13dd3853 D: NO public accessor for the teardown-core
  // counter. `GatewayLifecycle` is exported from `integration-
  // entry.ts`, so a public method would be part of the production
  // API surface. Tests reach the private field via cast:
  //   `(lifecycle as unknown as { teardownCoreEnteredCountValue: number })
  //      .teardownCoreEnteredCountValue`
  // The private field itself stays; there's no runtime observable
  // for it beyond that cast.

  /**
   * Teardown core (副指挥 3cb7ba9b + d53209eb).
   * Sequence:
   *   1. If already terminal, return the memoised outcome.
   *   2. `state = "stopping"`. Unsubscribe router (no new dispatch).
   *   3. BOUNDED `backendServer.stop()` — race against
   *      `LOCAL_STOP_TIMEOUT_MS`; timeout/throw escalates to
   *      `forceTerminate()`. Any failure → `stop_failed` cause.
   *   4. Same for `tuiServer.stop()`.
   *   5. Rotate TUI bearer.
   *   6. Bounded `upstreamTransport.close()` — tagged-winner race;
   *      any failure escalates to REQUIRED `abort()` with runtime
   *      thenable guard.
   *   7. Drain mux + reverseNs (one-shot).
   *   8. Set terminal: `stopped` iff all four (backend, tui,
   *      upstream close, abort-if-called) succeeded; else
   *      `stop_failed` with primary Error identity preserved.
   */
  private async doTeardownCore(): Promise<TeardownOutcome> {
    if (this.state === "stopped" || this.state === "stop_failed") {
      return {
        terminal: this.state,
        primary: this.stopFailureError,
        ledger: this.stopFailureLedgerRecord,
      };
    }
    if (this.state === "created") {
      this.state = "stopped";
      return {
        terminal: "stopped", primary: null,
        ledger: { backendStop: null, tuiStop: null, upstreamClose: null, upstreamAbort: null },
      };
    }
    this.state = "stopping";
    // 副指挥 0bd525d0 P1-1: stage-labeled failure ledger. Each of
    // the four stages has an isolated slot. Nothing overwrites
    // anything.
    const ledger: {
      backendStop: Error | null;
      tuiStop: Error | null;
      upstreamClose: Error | null;
      upstreamAbort: Error | null;
    } = { backendStop: null, tuiStop: null, upstreamClose: null, upstreamAbort: null };

    if (this.upstreamRouter !== null) {
      try { this.upstreamRouter.unsubscribe(); } catch { /* silent */ }
      this.upstreamRouter = null;
    }

    if (this.backendServer !== null) {
      const be = this.backendServer;
      this.backendServer = null;
      ledger.backendStop = await this.boundedLocalStop(
        "backend",
        () => be.stop(),
        () => be.forceTerminate(),
      );
    }
    if (this.tuiServer !== null) {
      const tui = this.tuiServer;
      this.tuiServer = null;
      ledger.tuiStop = await this.boundedLocalStop(
        "tui",
        () => tui.stop(),
        () => tui.forceTerminate(),
      );
    }
    this.backendStarted = false;
    this.tuiStarted = false;
    if (this.tuiBearer !== null) {
      try { this.tuiBearer.rotate(); } catch { /* silent */ }
      this.tuiBearer = null;
    }
    const upstreamOutcome = await this.closeUpstreamBounded();
    ledger.upstreamClose = upstreamOutcome.closeError;
    ledger.upstreamAbort = upstreamOutcome.abortError;
    // 副指挥 3cb7ba9b Commit 2 #6: drain pending exactly once. Mux
    // + reverseNs `drainAll` are one-shot by construction.
    if (this.mux !== null) {
      try { this.mux.drainAll(); } catch { /* silent */ }
      this.mux = null;
    }
    if (this.reverseNs !== null) {
      try { this.reverseNs.drainAll(); } catch { /* silent */ }
      this.reverseNs = null;
    }
    this.humanOwner = null;
    // 副指挥 0bd525d0 P1-1: primary priority order (strongest
    // signal first). ORIGINAL Error identity is used verbatim —
    // never wrapped, never mutated (no `.cause` attach; the
    // ledger is non-invasive).
    const primary = this.pickPrimary(ledger);
    this.stopFailureLedgerRecord = ledger;
    if (primary === null) {
      this.state = "stopped";
      return { terminal: "stopped", primary: null, ledger };
    }
    this.stopFailureError = primary;
    this.state = "stop_failed";
    return { terminal: "stop_failed", primary, ledger };
  }

  /**
   * 副指挥 0bd525d0 P1-1: pick primary Error identity from the
   * ledger. Priority order (strongest signal first):
   *   1. upstreamAbort — the required force-terminate contract
   *      failed; nothing after is trustworthy.
   *   2. upstreamClose — graceful close threw / timed out but
   *      abort succeeded.
   *   3. backendStop — Backend UDS teardown failure.
   *   4. tuiStop — TUI WS teardown failure.
   * Returns null iff every slot is null.
   */
  private pickPrimary(ledger: {
    backendStop: Error | null;
    tuiStop: Error | null;
    upstreamClose: Error | null;
    upstreamAbort: Error | null;
  }): Error | null {
    if (ledger.upstreamAbort !== null) return ledger.upstreamAbort;
    if (ledger.upstreamClose !== null) return ledger.upstreamClose;
    if (ledger.backendStop !== null) return ledger.backendStop;
    if (ledger.tuiStop !== null) return ledger.tuiStop;
    return null;
  }

  /**
   * 副指挥 d53209eb #2: bounded local stop. Race the graceful
   * `.stop()` against `LOCAL_STOP_TIMEOUT_MS`; on timeout OR throw,
   * escalate to `forceTerminate()` (synchronous force-close). If
   * `forceTerminate` itself throws we treat that as a hard failure
   * to converge — teardown terminates with a truthful `stop_failed`.
   *
   * Returns null on clean success; the Error otherwise (with the
   * ORIGINAL identity preserved).
   */
  private async boundedLocalStop(
    label: string,
    stop: () => Promise<void>,
    forceTerminate: () => void,
  ): Promise<Error | null> {
    // Tagged-winner race so a mutable-flag read cannot mis-attribute
    // the outcome (副指挥 d53209eb #4).
    type Outcome =
      | { kind: "stop_ok" }
      | { kind: "stop_error"; error: Error }
      | { kind: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopP: Promise<Outcome> = Promise.resolve()
      .then(stop)
      .then<Outcome, Outcome>(
        () => ({ kind: "stop_ok" }),
        (e: unknown) => ({ kind: "stop_error", error: toError(e) }),
      );
    const timeoutP: Promise<Outcome> = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), LOCAL_STOP_TIMEOUT_MS);
    });
    const winner = await Promise.race([stopP, timeoutP]);
    if (timer !== undefined) clearTimeout(timer);
    // Silence any late rejection of the losing branch — a Promise
    // that rejects with no `.catch` handler would surface as an
    // unhandled rejection (副指挥 d53209eb #8).
    stopP.catch(() => { /* handled: winner was timeout */ });
    if (winner.kind === "stop_ok") return null;
    // Escalate. Force-terminate is a required contract on the
    // local server; if it also throws that IS the stop_failed cause.
    const primary: Error = winner.kind === "stop_error"
      ? winner.error
      : new Error(`${label} stop timed out after ${LOCAL_STOP_TIMEOUT_MS}ms`);
    try {
      forceTerminate();
    } catch (e) {
      // ForceTerminate throw supersedes the primary as the more
      // actionable failure — no fallback path exists.
      return toError(e);
    }
    return primary;
  }

  /**
   * Bounded upstream close + bounded abort. Tagged-winner races
   * for both stages (副指挥 0bd525d0 P0-1 + P1-2 + P1-3).
   *
   * Returns `{closeError, abortError}` — either can be null on
   * success; both null means clean teardown of the upstream.
   *
   * Semantics:
   *   - Close stage: tagged race close() vs `UPSTREAM_CLOSE_TIMEOUT_MS`.
   *     - close_ok → no abort call, both null.
   *     - close_error / timeout → abort stage.
   *   - Abort stage: abort() is REQUIRED (`() => Promise<void>`);
   *     bounded await against `UPSTREAM_ABORT_TIMEOUT_MS`.
   *     - Synchronous throw → caught by the outer try, primary
   *       Error identity preserved.
   *     - Rejection → primary Error identity preserved.
   *     - Timeout → synthetic timeout Error.
   *     - Ok → close-side cause becomes primary (abortError=null).
   *   - Timers cleared in `finally`. Loser branches consumed.
   *   - NO getter reads, NO `.then` coercion, NO `String(x)` on
   *     the return value — the return of abort() is either
   *     awaited to completion or its throw is caught. Any hostile
   *     value the caller returns cannot break the shutdown
   *     convergence.
   */
  private async closeUpstreamBounded(): Promise<{
    readonly closeError: Error | null;
    readonly abortError: Error | null;
  }> {
    type CloseWinner =
      | { kind: "close_ok" }
      | { kind: "close_error"; error: Error }
      | { kind: "timeout" };
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeP: Promise<CloseWinner> = Promise.resolve()
      .then(() => this.opts.upstreamTransport.close())
      .then<CloseWinner, CloseWinner>(
        () => ({ kind: "close_ok" }),
        (e: unknown) => ({ kind: "close_error", error: toError(e) }),
      );
    const closeTimeoutP: Promise<CloseWinner> = new Promise((resolve) => {
      closeTimer = setTimeout(() => resolve({ kind: "timeout" }), UPSTREAM_CLOSE_TIMEOUT_MS);
    });
    let closeWinner: CloseWinner;
    try {
      closeWinner = await Promise.race([closeP, closeTimeoutP]);
    } finally {
      if (closeTimer !== undefined) clearTimeout(closeTimer);
    }
    // Consume late rejection of losing branch to prevent unhandled.
    closeP.catch(() => { /* handled: timeout won */ });
    if (closeWinner.kind === "close_ok") {
      return { closeError: null, abortError: null };
    }
    const closeError: Error = closeWinner.kind === "close_error"
      ? closeWinner.error
      : new Error(`upstream close timed out after ${UPSTREAM_CLOSE_TIMEOUT_MS}ms`);
    // 副指挥 0bd525d0 P1-2 option A: bounded await of abort() promise.
    // We NEVER inspect getters / `.then` accessors / coerce to String
    // on the return value — everything hangs off the awaited Promise.
    type AbortWinner =
      | { kind: "abort_ok" }
      | { kind: "abort_error"; error: Error }
      | { kind: "abort_timeout" };
    let abortWinner: AbortWinner;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 副指挥 0bd525d0 P0-1: the ENTIRE abort call sits inside a
      // try/catch. A synchronous throw (bad implementation) is
      // caught here; a rejection is caught by the .then below.
      const abortP: Promise<AbortWinner> = Promise.resolve()
        .then(() => this.opts.upstreamTransport.abort())
        .then<AbortWinner, AbortWinner>(
          () => ({ kind: "abort_ok" }),
          (e: unknown) => ({ kind: "abort_error", error: toError(e) }),
        );
      const abortTimeoutP: Promise<AbortWinner> = new Promise((resolve) => {
        abortTimer = setTimeout(() => resolve({ kind: "abort_timeout" }), UPSTREAM_ABORT_TIMEOUT_MS);
      });
      try {
        abortWinner = await Promise.race([abortP, abortTimeoutP]);
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
      }
      abortP.catch(() => { /* handled: timeout won */ });
    } catch (e) {
      // Reached only if `.then(() => transport.abort())` chain threw
      // synchronously inside Promise.resolve().then() — extremely
      // unlikely, but we still land in `stop_failed` cleanly.
      const err = toError(e);
      return { closeError, abortError: err };
    }
    if (abortWinner.kind === "abort_ok") {
      // Transport IS force-terminated. Primary cause is the
      // close-side error alone; abort slot stays null.
      return { closeError, abortError: null };
    }
    if (abortWinner.kind === "abort_error") {
      // Original Error identity preserved.
      return { closeError, abortError: abortWinner.error };
    }
    return {
      closeError,
      abortError: new Error(`upstream abort timed out after ${UPSTREAM_ABORT_TIMEOUT_MS}ms`),
    };
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
