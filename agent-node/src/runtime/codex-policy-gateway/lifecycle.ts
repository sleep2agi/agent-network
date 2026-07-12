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

export type LifecycleState = "created" | "starting" | "running" | "stopping" | "stopped";

export class GatewayLifecycle {
  private readonly opts: GatewayLifecycleOptions;
  private state: LifecycleState = "created";
  private backendServer: BackendUdsServer | null = null;
  private tuiServer: TuiWsServer | null = null;
  private tuiBearer: TuiBearer | null = null;
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

  constructor(opts: GatewayLifecycleOptions) {
    this.opts = opts;
  }

  currentState(): LifecycleState {
    return this.state;
  }

  humanOwnerCoordinator(): HumanOwnerCoordinator | null {
    return this.humanOwner;
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
    try {
      await this.opts.preflight.run();
    } catch (e) {
      this.state = "stopped";
      throw e;
    }
    // P0 fence #1 — stop requested during preflight.
    if (this.stopRequested) {
      this.state = "stopped";
      throw new Error("start aborted by concurrent stop (preflight)");
    }

    this.mux = new UpstreamRequestMux<InternalOrigin>();
    this.reverseNs = new ReverseRequestNamespace();

    const diagnostics = makeNoThrowDiagnostics(this.opts.diagnosticsSink);
    const initProvider = makeNoThrowInitializeProvider(this.opts.initSnapshotSource, diagnostics);
    const authorizer = this.opts.authorizer ?? defaultDenyTuiAuthorizer;

    this.humanOwner = new HumanOwnerCoordinator({
      mux: this.mux as unknown as UpstreamRequestMux<unknown>,
      reverseNs: this.reverseNs,
      diagnostics,
      // P0.2 Commit 1 corrective: hard-pinned Phase 1 posture. No
      // options-side override; Phase 2 turn-on is a separate PR.
      approvalMode: "never",
    });

    // Mint a fresh TUI bearer per lifecycle. Plaintext lives here
     // just long enough to hand to the (future) child launcher; the
     // WS server retains only the domain-separated SHA-256 digest.
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

    // P0 fence #2 — stop requested before we bind sockets.
    if (this.stopRequested) {
      this.state = "stopped";
      this.backendServer = null;
      this.tuiServer = null;
      this.humanOwner = null;
      this.mux = null;
      this.reverseNs = null;
      throw new Error("start aborted by concurrent stop (pre-listen)");
    }

    try {
      await this.backendServer.start();
      await this.tuiServer.start();
    } catch (e) {
      try { await this.backendServer?.stop(); } catch { /* silent */ }
      try { await this.tuiServer?.stop(); } catch { /* silent */ }
      this.state = "stopped";
      this.backendServer = null;
      this.tuiServer = null;
      this.humanOwner = null;
      this.mux = null;
      this.reverseNs = null;
      throw e;
    }

    // P0 fence #3 — stop requested during server.start.
    if (this.stopRequested) {
      try { await this.backendServer.stop(); } catch { /* silent */ }
      try { await this.tuiServer.stop(); } catch { /* silent */ }
      this.state = "stopped";
      this.backendServer = null;
      this.tuiServer = null;
      this.humanOwner = null;
      this.mux = null;
      this.reverseNs = null;
      throw new Error("start aborted by concurrent stop (post-listen)");
    }

    this.state = "running";
  }

  /**
   * Stop ordering:
   *   1. transition running → stopping. New connections are
   *      already destroyed at accept time by the server's
   *      max_connections gate; sending sendInternal / sendProxiedTui
   *      is the caller's responsibility to fence off (this class
   *      doesn't own the caller's scheduler).
   *   2. Stop the GatewayServer. Its `stop()` closes both UDS
   *      servers, destroys live connections (which triggers TUI
   *      disconnect → drainProxiedTui + reverseNs.drainAll via the
   *      server's own closeConnection path if a TUI was attached),
   *      then drainAll's the mux via the upstream close hook. Sockets
   *      + created dir cleaned by the server's cleanupCreatedPaths.
   *   3. transition stopping → stopped.
   *
   * If already stopped / not started, `stop()` is a no-op.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // Wait for any in-flight start() so ordering is deterministic —
    // the fences in doStart() will land the lifecycle in `stopped`
    // if start hasn't finished listening yet. If start already
    // finished, we proceed to normal shutdown below.
    if (this.startInProgress !== null) {
      try { await this.startInProgress; } catch { /* start rejected — already stopped */ }
    }
    if (this.state === "stopped" || this.state === "created") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    if (this.backendServer !== null) {
      try { await this.backendServer.stop(); } catch { /* best-effort */ }
      this.backendServer = null;
    }
    if (this.tuiServer !== null) {
      try { await this.tuiServer.stop(); } catch { /* best-effort */ }
      this.tuiServer = null;
    }
    // Rotate the TUI bearer so no in-flight upgrade can consume it.
    if (this.tuiBearer !== null) {
      try { this.tuiBearer.rotate(); } catch { /* silent */ }
      this.tuiBearer = null;
    }
    try { await this.opts.upstreamTransport.close(); } catch { /* silent */ }
    if (this.mux !== null) { this.mux.drainAll(); this.mux = null; }
    if (this.reverseNs !== null) { this.reverseNs.drainAll(); this.reverseNs = null; }
    this.humanOwner = null;
    this.state = "stopped";
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
