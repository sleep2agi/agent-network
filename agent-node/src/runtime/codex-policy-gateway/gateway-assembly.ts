// RFC-030 Wave 1B L3-R6 — production gateway assembly.
//
// Composes B's pieces under A's frozen orchestration (00d4ea8):
//
//   sqlite gate ─┐
//   profile gate ├─ fail closed BEFORE anything touches disk/socket
//   baseline gate┘         (spawn is gated inside spawnFactory)
//        │
//   gated app-server spawn ──► CodexUpstreamTransport (ONE socket)
//        │                              │
//   GatewayLedger                A GatewayLifecycle.start()
//        │                    (preflight → mux/reverseNs → HumanOwner
//   GatewayScheduler ◄─────────  → GatewayServer/UDS)   │
//        │  ownerAttached = humanOwner.isTuiAttached (fail closed)
//        │  backend = scheduler (ProtocolBackend surface)
//        │
//   bootstrap via lifecycle.sendInternal (initialize → snapshot,
//   thread resume/start) ──► BridgeAdapter over the assembly shim
//   (request = sendInternal + timeout; events = transport notifications)
//
// Hard rules held here:
//   - NO second UpstreamRequestMux / ReverseRequestNamespace — A's
//     lifecycle.start() creates the only instances (通信龙 hard rule).
//   - EAGER boot: assemble() runs every gate at node start.
//   - authorizer is B's REAL Phase-1 authorizer (never default-allow);
//     an authorizer-ALLOWED turn/interrupt also notifies the adapter
//     (interrupted_by_human classification, R8).
//   - ownerAttached is the HumanOwnerCoordinator truth — no owner
//     probe wiring means () => false, never true.

import { randomBytes } from "node:crypto";
import { GatewayLifecycle, type PreflightRunner } from "./lifecycle";
import { GatewayLedger } from "./ledger";
import { GatewayScheduler } from "./scheduler";
import { BridgeAdapter, type UpstreamRpcLike } from "./bridge-adapter";
import { createTuiAuthorizer, type TuiRequestAuthorizer } from "./tui-authorizer";
import { CodexUpstreamTransport } from "./upstream-transport";
import { spawnOwnedCodexUpstream } from "./owned-upstream-provider";
import { resolveSqliteDriver } from "./sqlite-driver";
import { assertPhase1Profile, PHASE1_PROFILE } from "./policy";
import {
  pumpInboxBatch,
  runGatewayInboxCycle,
  type GatewayInboxCycleReport,
  type InboxPumpHooks,
  type PumpRow,
  type PumpBatchReport,
} from "./inbox-pump";
import {
  buildAllowlistEnv,
  type AllowedChildEnv,
  type LaunchOutcome,
  type TuiChildLauncher,
} from "./tui-child-launcher";
import { ProductionTuiLauncher } from "./production-tui-launcher";
import type { CodexBinaryIdentity } from "./codex-binary";
import type {
  GatewayDeliveryCode,
  GatewayDeliveryStatus,
} from "./ledger";
import type { ProtocolDiagnostics, TuiInitializeProvider, JsonRpcRequestFrame, TuiPolicyDecision } from "./protocol";

export interface CodexGatewayAssemblyOptions {
  /** codex binary (baseline-gated before spawn). */
  binary?: string;
  /** Persisted thread id; empty → create fresh. */
  threadId?: string;
  socketDir: string;
  backendSocketPath: string;
  /** @deprecated final A exposes the TUI only on strict loopback WS. */
  tuiSocketPath?: string;
  /** Gateway ledger SQLite path (":memory:" for tests). */
  sqlitePath: string;
  queueLimit?: number;
  dispatchTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Optional explicit backend UDS capability; production mints 32 bytes. */
  backendCapability?: string;
  /** Narrow environment projected into the real TUI child. */
  tuiEnv?: AllowedChildEnv;
  /** Production default is a retained PTY launcher. `false` is tests only. */
  tuiLauncher?: TuiChildLauncher | false;
  workDir?: string;
  /**
   * DI seams (tests only; production omits both):
   *   spawnFactory — must run the profile+baseline gates itself when
   *     overridden (the default does, via the runtime's gated spawn).
   *   diagnosticsSink — defaults to a log-backed sink.
   */
  spawnFactory?: () => Promise<SpawnedUpstream>;
  diagnosticsSink?: ProtocolDiagnostics;
  onThread?: (threadId: string, created: boolean) => void;
}

export interface CodexGatewayHandle {
  lifecycle: GatewayLifecycle;
  scheduler: GatewayScheduler;
  adapter: BridgeAdapter;
  ledger: GatewayLedger;
  transport: CodexUpstreamTransport;
  /** Settles on the real upstream WS close event (never carries raw reason). */
  upstreamClosed: Promise<void>;
  /** Production-only TUI process-group terminal fence. */
  tuiClosed: Promise<void> | null;
  threadId: string;
  tuiLaunchOutcome: LaunchOutcome;
  /** Consume one get_inbox batch through the Phase-1 pump. */
  pump(rows: readonly PumpRow[], hooks: InboxPumpHooks): Promise<PumpBatchReport>;
  /** The production mixed-window demux; ordinary rows retain ACK ownership. */
  runInboxCycle(
    rows: readonly PumpRow[],
    hooks: InboxPumpHooks,
    ordinaryHandler: (row: PumpRow) => void | Promise<void>,
  ): Promise<GatewayInboxCycleReport>;
  /** Durable reply_pending drain. #440 supplies the final canonical sink. */
  drainReplies(deliver: GatewayReplyDeliverer): Promise<GatewayReplyDrainReport>;
  /** Kill owned app-server/TUI groups without closing a possibly-live DB. */
  forceStopOwned(): Promise<void>;
  stop(): Promise<void>;
}

export interface SpawnedUpstream {
  readonly url: string;
  readonly identity?: CodexBinaryIdentity;
  shutdown(): Promise<void> | void;
  /** Optional only for legacy test fixtures; production always supplies it. */
  abort?(): Promise<void> | void;
}

export interface PendingGatewayOutcome {
  readonly deliveryId: string;
  readonly submissionId: string;
  readonly canonicalTaskId: string;
  readonly status: GatewayDeliveryStatus;
  readonly code: GatewayDeliveryCode;
  readonly text: string;
}

/** Compatibility name for the pre-H1 intermediate seam. */
export type PendingGatewayReply = PendingGatewayOutcome;

export type GatewayOutcomeDeliveryResult =
  | { readonly kind: "applied" | "already_applied_same" }
  | { readonly kind: "retryable"; readonly code: string }
  | {
      readonly kind: "refused";
      readonly code: "not_found" | "ownership_mismatch" | "terminal_conflict";
    };

export type GatewayReplyDeliverer = (
  reply: PendingGatewayOutcome,
) => Promise<GatewayOutcomeDeliveryResult>;

export interface GatewayReplyDrainReport {
  delivered: string[];
  deferred: string[];
  quarantined: string[];
  invalid: string[];
}

const DEFAULT_INIT_PARAMS = { clientInfo: { name: "anet_codex_gateway", version: "wave1b" } };
const DELIVERY_STATUS_BY_CODE: Readonly<Record<string, GatewayDeliveryStatus>> = {
  completed: "replied",
  dispatch_failed: "failed",
  dispatch_outcome_unknown: "failed",
  turn_failed: "failed",
  empty_final_answer: "failed",
  interrupted_by_human: "cancelled",
  cancelled_by_agent: "cancelled",
  recovery_payload_invalid: "failed",
};

/** Default gated spawn — reuses the runtime's fail-closed open path. */
async function defaultGatedSpawn(opts: CodexGatewayAssemblyOptions): Promise<SpawnedUpstream> {
  // Spawn-only provider: no legacy client, bridge, initialize, or thread
  // bootstrap is ever constructed on the production gateway path.
  return spawnOwnedCodexUpstream({
    binary: opts.binary,
    cwd: opts.workDir,
    log: opts.log,
  });
}

type StableGatewayRequestError = Error & {
  readonly code: "ERR_REQUEST_TIMEOUT" | "ERR_UPSTREAM_REQUEST_FAILED";
};

/**
 * R2 boundary: A's frozen mux faithfully preserves an upstream JSON-RPC
 * error message on its internal rejection.  That value is useful inside A,
 * but must never escape the production assembly into a caller, logger, or
 * persisted surface.  Deliberately construct a fresh error without `cause`.
 */
function stableGatewayRequestError(
  code: StableGatewayRequestError["code"],
): StableGatewayRequestError {
  const message = code === "ERR_REQUEST_TIMEOUT"
    ? "gateway upstream request timed out"
    : "gateway upstream request failed";
  return Object.assign(new Error(message), { code });
}

function withTimeout<T>(p: Promise<T>, ms: number, upstreamClosed: Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: { ok: true; value: T } | { ok: false; error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (value.ok) resolve(value.value);
      else reject(value.error);
    };
    const t = setTimeout(
      () => finish({ ok: false, error: stableGatewayRequestError("ERR_REQUEST_TIMEOUT") }),
      ms,
    );
    p.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, error: stableGatewayRequestError("ERR_UPSTREAM_REQUEST_FAILED") }),
    );
    upstreamClosed.then(
      () => finish({ ok: false, error: stableGatewayRequestError("ERR_UPSTREAM_REQUEST_FAILED") }),
      () => finish({ ok: false, error: stableGatewayRequestError("ERR_UPSTREAM_REQUEST_FAILED") }),
    );
  });
}

export async function assembleCodexGateway(
  opts: CodexGatewayAssemblyOptions,
): Promise<CodexGatewayHandle> {
  const log = opts.log ?? (() => {});
  const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 30_000;

  // ── gate 1: SQLite runtime (fail closed before anything else) ──────
  const { driver } = resolveSqliteDriver(opts.sqlitePath);
  const ledger = new GatewayLedger(driver);

  let spawnedForCleanup: SpawnedUpstream | null = null;
  let transportForCleanup: CodexUpstreamTransport | null = null;
  let lifecycleForCleanup: GatewayLifecycle | null = null;
  let launcherForCleanup: TuiChildLauncher | null = null;
  let ownerObserverForCleanup: ReturnType<typeof setInterval> | null = null;

  try {

  // ── gate 2+3 + spawn (profile + baseline inside the gated spawn) ───
  const spawned = await (opts.spawnFactory ?? (() => defaultGatedSpawn(opts)))();
  spawnedForCleanup = spawned;

  // ── the ONE upstream socket ────────────────────────────────────────
  const transport = new CodexUpstreamTransport({
    url: spawned.url,
    log,
    abortUpstream: () => new Promise<void>((resolve, reject) => {
      try {
        const result = spawned.abort?.();
        Promise.resolve(result).then(() => resolve(), reject);
      } catch (error) {
        reject(error);
      }
    }),
  });
  transportForCleanup = transport;
  let resolveUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  transport.onClose(resolveUpstreamClosed);
  await transport.connect();

  // ── late-bound refs breaking the construction cycle ────────────────
  let lifecycle: GatewayLifecycle | null = null;
  let adapter: BridgeAdapter | null = null;
  let boundThreadId: string | null = null;

  // Assembly shim: EVERY internal request rides A's single mux via
  // lifecycle.sendInternal; a per-call timeout contains the drainAll-
  // without-reject gap (flagged to A) so no B await can hang.
  const upstreamRpc: UpstreamRpcLike = {
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (!lifecycle) return Promise.reject(new Error("gateway lifecycle not started"));
      return withTimeout(
        lifecycle.sendInternal<T>(method, params, method),
        timeoutMs ?? dispatchTimeoutMs,
        upstreamClosed,
      );
    },
    on(event: string, fn: (params: unknown) => void) {
      return transport.onNotification((method, params) => {
        if (method === event) fn(params);
      });
    },
  };

  // Scheduler — owner truth comes from A's HumanOwnerCoordinator; no
  // coordinator yet (pre-start) reads as NOT attached (fail closed).
  const scheduler = new GatewayScheduler({
    ledger,
    dispatcher: {
      startTurn: (input) => {
        if (!adapter) return Promise.reject(new Error("gateway adapter not ready"));
        return adapter.startTurn(input);
      },
    },
    queueLimit: opts.queueLimit,
    ownerAttached: () => lifecycle?.humanOwnerAttached() ?? false,
    isShuttingDown: () => {
      const state = lifecycle?.currentState();
      return state === "stopping" || state === "stopped" || state === "stop_failed";
    },
    log,
  });

  // Real Phase-1 authorizer (never default-allow). An ALLOWED
  // turn/interrupt is about to be forwarded by A's dispatch — notify
  // the adapter so the aborted agent turn lands interrupted_by_human.
  const baseAuthorizer = createTuiAuthorizer({
    boundThreadId: () => boundThreadId,
    reservation: () => scheduler.snapshot().activeReservationOwner,
  });
  const authorizer: TuiRequestAuthorizer = {
    async authorize(frame: JsonRpcRequestFrame): Promise<TuiPolicyDecision> {
      const decision = await baseAuthorizer.authorize(frame);
      if (decision.verdict === "allow" && frame.method === "turn/interrupt") {
        adapter?.noteHumanInterruptForwarded();
      }
      return decision;
    },
  };

  // Upstream initialize snapshot — captured once at bootstrap; A wraps
  // this in its no-throw provider. undefined until then (fail closed).
  let initSnapshot: Readonly<Record<string, unknown>> | undefined;
  const initSnapshotSource: TuiInitializeProvider = {
    currentSnapshot: () => initSnapshot,
  };

  let diagCounter = 0;
  const diagnosticsSink: ProtocolDiagnostics = opts.diagnosticsSink ?? {
    newCorrelationId: () => `gw-${++diagCounter}`,
    reportInternalError: (e) => {
      // R2: the upstream-provided error object is deliberately not rendered.
      log(`[gateway] internal error ref=${e.correlationId} op=${e.operation}`);
    },
  };

  // Assembly preflight for A's lifecycle: heavy gates already ran above;
  // this re-asserts the cheap invariants right before UDS goes live.
  const preflight: PreflightRunner = {
    async run() {
      assertPhase1Profile(PHASE1_PROFILE);
      // No protocol mutation during preflight: a duplicate `initialized`
      // notification is observable upstream and can invalidate bootstrap.
      await transport.probe();
    },
  };

  lifecycle = new GatewayLifecycle({
    backendSocketPath: opts.backendSocketPath,
    socketDir: opts.socketDir,
    preflight,
    backend: scheduler, // ProtocolBackend surface == scheduler's typed contract
    upstreamTransport: transport,
    initSnapshotSource,
    diagnosticsSink,
    authorizer,
    backendCapability:
      opts.backendCapability ?? randomBytes(32).toString("base64url"),
  });
  lifecycleForCleanup = lifecycle;

  await lifecycle.start();

  // ── bootstrap over the single mux ──────────────────────────────────
  initSnapshot = (await upstreamRpc.request<Record<string, unknown>>(
    "initialize",
    DEFAULT_INIT_PARAMS,
  )) as Readonly<Record<string, unknown>>;
  await transport.writeFrame({ jsonrpc: "2.0", method: "initialized" } as never);

  let created = false;
  let threadId = opts.threadId ?? "";
  if (threadId) {
    // Shared-thread continuity is fail-closed. R2 deliberately redacts raw
    // upstream errors, so this layer cannot prove a resume failure means
    // "not found" rather than timeout/close/policy failure. Never replace a
    // persisted thread silently; only an explicit no-thread boot may create.
    await upstreamRpc.request("thread/resume", { threadId });
  }
  if (!threadId) {
    const t = await upstreamRpc.request<{ threadId?: string; thread?: { id?: string } }>(
      "thread/start",
      {},
    );
    threadId = t?.threadId ?? t?.thread?.id ?? "";
    if (!threadId) throw new Error("gateway bootstrap: thread/start returned no threadId");
    created = true;
  }
  boundThreadId = threadId;
  opts.onThread?.(threadId, created);

  adapter = new BridgeAdapter({
    client: upstreamRpc,
    threadId,
    dispatchTimeoutMs,
    log,
  });
  adapter.bindScheduler(scheduler);

  // Crash recovery is deliberately conservative. Rows known never sent are
  // rehydrated from their durable payload; dispatching/accepted uncertainty
  // becomes terminal ambiguous (no resend), and completed answers resume at
  // reply_pending for the later #440 canonical sink.
  const recovery = ledger.recover(new Map());
  scheduler.restoreRecoveredQueue(recovery.requeued);
  if (
    recovery.requeued.length > 0 ||
    recovery.ambiguous.length > 0 ||
    recovery.replyPending.length > 0
  ) {
    log(
      `[gateway] recovery requeued=${recovery.requeued.length} ambiguous=${recovery.ambiguous.length} reply_pending=${recovery.replyPending.length}`,
    );
  }

  // Final A intentionally exposes only a typed attachment snapshot, not
  // the raw coordinator. A bounded observer re-kicks B's scheduler when
  // the snapshot changes without monkey-patching frozen A internals.
  let ownerSnapshot = lifecycle.humanOwnerAttached();
  const ownerObserver = setInterval(() => {
    const next = lifecycle?.humanOwnerAttached() ?? false;
    if (next !== ownerSnapshot) {
      ownerSnapshot = next;
      scheduler.onOwnerAttachmentChanged();
    }
  }, 100);
  ownerObserverForCleanup = ownerObserver;
  ownerObserver.unref?.();

  let tuiLauncher: TuiChildLauncher | null = null;
  let productionTuiLauncher: ProductionTuiLauncher | null = null;
  let tuiLaunchOutcome: LaunchOutcome = {
    spawned: false,
    reason: "test_spawn_factory_without_launcher",
  };
  const launchConfigured = opts.tuiLauncher !== undefined
    ? opts.tuiLauncher
    : opts.spawnFactory
      ? false
      : (productionTuiLauncher = new ProductionTuiLauncher({
          binary: opts.binary,
          identity: spawned.identity,
          threadId,
          cwd: opts.workDir,
          log,
        }));
  if (launchConfigured instanceof ProductionTuiLauncher) {
    productionTuiLauncher = launchConfigured;
  }
  if (launchConfigured !== false) {
    const bearer = lifecycle.takeTuiBearerPlaintextForLauncher();
    if (bearer === null) {
      throw new Error("gateway TUI bearer unavailable after lifecycle start");
    }
    const inherited: AllowedChildEnv = opts.tuiEnv ?? {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    };
    const env = buildAllowlistEnv(bearer, inherited);
    tuiLauncher = launchConfigured;
    launcherForCleanup = tuiLauncher;
    tuiLaunchOutcome = await tuiLauncher.launch({
      wsUrl: `ws://127.0.0.1:${lifecycle.tuiWsPortActual()}`,
      env,
    });
    if (!tuiLaunchOutcome.spawned) {
      throw new Error(`gateway TUI launcher refused (${tuiLaunchOutcome.reason ?? "unknown"})`);
    }
  }

  log(`[gateway] assembled: thread ${threadId.slice(0, 12)}… (created=${created})`);

  let forceStopOwnedPromise: Promise<void> | null = null;
  const forceStopOwned = (): Promise<void> => {
    if (forceStopOwnedPromise !== null) return forceStopOwnedPromise;
    forceStopOwnedPromise = (async () => {
      clearInterval(ownerObserver);
      const outcomes = await Promise.allSettled([
        tuiLauncher?.terminate() ?? Promise.resolve(),
        transport.abort(),
        Promise.resolve(spawned.abort?.()),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        throw new Error("gateway owned-resource force stop failed");
      }
    })();
    return forceStopOwnedPromise;
  };

  let handleStopPromise: Promise<void> | null = null;
  const stopHandle = (): Promise<void> => {
    if (handleStopPromise !== null) return handleStopPromise;
    handleStopPromise = new Promise<void>((resolve, reject) => {
      void (async () => {
        clearInterval(ownerObserver);
        let firstError: unknown = null;
        try { await tuiLauncher?.terminate(); } catch (error) { firstError ??= error; }
        try { await lifecycle!.stop(); } catch (error) { firstError ??= error; }
        try { await spawned.shutdown(); } catch (error) { firstError ??= error; }
        try { driver.close(); } catch (error) { firstError ??= error; }
        if (firstError !== null) throw firstError;
      })().then(resolve, reject);
    });
    return handleStopPromise;
  };

  let replyDrainPromise: Promise<GatewayReplyDrainReport> | null = null;
  const drainReplies = (deliver: GatewayReplyDeliverer): Promise<GatewayReplyDrainReport> => {
    if (replyDrainPromise !== null) return replyDrainPromise;
    replyDrainPromise = (async () => {
      const report: GatewayReplyDrainReport = {
        delivered: [],
        deferred: [],
        quarantined: [],
        invalid: [],
      };
      for (const row of ledger.outboundPending()) {
        if (
          !row.taskId ||
          row.deliveryStatus === null ||
          row.deliveryCode === null ||
          row.deliveryText === null ||
          row.deliveryText.length === 0 ||
          row.deliveryText.length > 10_000 ||
          DELIVERY_STATUS_BY_CODE[String(row.deliveryCode)] !== row.deliveryStatus
        ) {
          ledger.markOutboundQuarantined(row.submissionId, "invalid_outbox");
          report.invalid.push(row.submissionId);
          continue;
        }
        try {
          ledger.noteOutboundAttempt(row.submissionId);
          const result = await deliver({
            deliveryId: row.submissionId,
            submissionId: row.submissionId,
            canonicalTaskId: row.taskId,
            status: row.deliveryStatus,
            code: row.deliveryCode,
            text: row.deliveryText,
          });
          if (result?.kind === "applied" || result?.kind === "already_applied_same") {
            scheduler.markReplied(row.submissionId);
            report.delivered.push(row.submissionId);
          } else if (
            result?.kind === "refused" &&
            (result.code === "not_found" ||
              result.code === "ownership_mismatch" ||
              result.code === "terminal_conflict")
          ) {
            ledger.markOutboundQuarantined(row.submissionId, result.code);
            log(`[gateway] outcome delivery quarantined submission=${row.submissionId} code=${result.code}`);
            report.quarantined.push(row.submissionId);
          } else {
            // Retryable and malformed adapter results both remain durable.
            log(`[gateway] outcome delivery deferred submission=${row.submissionId}`);
            report.deferred.push(row.submissionId);
          }
        } catch {
          // No adapter/transport error enters log or the durable ledger.
          log(`[gateway] outcome delivery deferred submission=${row.submissionId}`);
          report.deferred.push(row.submissionId);
        }
      }
      return report;
    })().finally(() => {
      replyDrainPromise = null;
    });
    return replyDrainPromise;
  };

  return {
    lifecycle,
    scheduler,
    adapter,
    ledger,
    transport,
    upstreamClosed,
    tuiClosed: productionTuiLauncher?.exited ?? null,
    threadId,
    tuiLaunchOutcome,
    pump: (rows, hooks) => pumpInboxBatch(rows, scheduler, hooks),
    runInboxCycle: (rows, hooks, ordinaryHandler) =>
      runGatewayInboxCycle(rows, scheduler, hooks, ordinaryHandler),
    drainReplies,
    forceStopOwned,
    stop: stopHandle,
  };
  } catch (error) {
    if (ownerObserverForCleanup !== null) clearInterval(ownerObserverForCleanup);
    try { await launcherForCleanup?.terminate(); } catch { /* preserve boot cause */ }
    if (lifecycleForCleanup !== null) {
      try { await lifecycleForCleanup.stop(); } catch { /* preserve boot cause */ }
    } else if (transportForCleanup !== null) {
      try { await transportForCleanup.abort(); } catch { /* preserve boot cause */ }
    }
    if (spawnedForCleanup !== null) {
      try { await spawnedForCleanup.abort?.(); } catch { /* preserve boot cause */ }
      try { await spawnedForCleanup.shutdown(); } catch { /* preserve boot cause */ }
    }
    try { driver.close(); } catch { /* preserve boot cause */ }
    throw error;
  }
}
