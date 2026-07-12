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

import { GatewayLifecycle, type PreflightRunner } from "./lifecycle";
import { GatewayLedger } from "./ledger";
import { GatewayScheduler } from "./scheduler";
import { BridgeAdapter, type UpstreamRpcLike } from "./bridge-adapter";
import { createTuiAuthorizer, type TuiRequestAuthorizer } from "./tui-authorizer";
import { CodexUpstreamTransport } from "./upstream-transport";
import { resolveSqliteDriver } from "./sqlite-driver";
import { assertPhase1Profile, PHASE1_PROFILE } from "./policy";
import { assertCodexBaseline } from "./version-gate";
import { pumpInboxBatch, type InboxPumpHooks, type PumpRow, type PumpBatchReport } from "./inbox-pump";
import type { ProtocolDiagnostics, TuiInitializeProvider, JsonRpcRequestFrame, TuiPolicyDecision } from "./protocol";

export interface CodexGatewayAssemblyOptions {
  /** codex binary (baseline-gated before spawn). */
  binary?: string;
  /** Persisted thread id; empty → create fresh. */
  threadId?: string;
  socketDir: string;
  backendSocketPath: string;
  tuiSocketPath: string;
  /** Gateway ledger SQLite path (":memory:" for tests). */
  sqlitePath: string;
  queueLimit?: number;
  dispatchTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * DI seams (tests only; production omits both):
   *   spawnFactory — must run the profile+baseline gates itself when
   *     overridden (the default does, via the runtime's gated spawn).
   *   diagnosticsSink — defaults to a log-backed sink.
   */
  spawnFactory?: () => Promise<{ url: string; shutdown: () => Promise<void> | void }>;
  diagnosticsSink?: ProtocolDiagnostics;
  onThread?: (threadId: string, created: boolean) => void;
}

export interface CodexGatewayHandle {
  lifecycle: GatewayLifecycle;
  scheduler: GatewayScheduler;
  adapter: BridgeAdapter;
  ledger: GatewayLedger;
  transport: CodexUpstreamTransport;
  threadId: string;
  /** Consume one get_inbox batch through the Phase-1 pump. */
  pump(rows: readonly PumpRow[], hooks: InboxPumpHooks): Promise<PumpBatchReport>;
  stop(): Promise<void>;
}

const DEFAULT_INIT_PARAMS = { clientInfo: { name: "anet_codex_gateway", version: "wave1b" } };

/** Default gated spawn — reuses the runtime's fail-closed open path. */
async function defaultGatedSpawn(opts: CodexGatewayAssemblyOptions): Promise<{
  url: string;
  shutdown: () => Promise<void> | void;
}> {
  // Import lazily to keep the assembly unit-testable without child procs.
  const { openCodexAppServerRuntime } = await import("../codex-app-server/runtime");
  // Owned spawn; profile + baseline gates run inside (L2). We only use
  // the spawned server's URL — the runtime's own client/bridge are shut
  // down immediately so the transport is the ONLY socket. (A cleaner
  // spawn-only helper is a follow-up; this keeps the gates single-sourced.)
  const session = await openCodexAppServerRuntime({
    binary: opts.binary,
    threadId: opts.threadId,
    sandboxMode: PHASE1_PROFILE.sandboxMode,
    approvalPolicy: PHASE1_PROFILE.approvalPolicy,
    log: opts.log,
  });
  const url = (session.client as unknown as { opts?: { url?: string } }).opts?.url
    ?? (() => { throw new Error("gated spawn did not expose a server url"); })();
  await session.client.close();
  return {
    url,
    shutdown: () => {
      session.proc?.kill();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`gateway request '${label}' timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
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

  // ── gate 2+3 + spawn (profile + baseline inside the gated spawn) ───
  const spawned = await (opts.spawnFactory ?? (() => defaultGatedSpawn(opts)))();

  // ── the ONE upstream socket ────────────────────────────────────────
  const transport = new CodexUpstreamTransport({ url: spawned.url, log });
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
        method,
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
    ownerAttached: () => lifecycle?.humanOwnerCoordinator()?.isTuiAttached() ?? false,
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
      const raw = e.error instanceof Error ? e.error.message : String(e.error);
      log(`[gateway] internal error ${e.correlationId} op=${e.operation}: ${raw.slice(0, 300)}`);
    },
  };

  // Assembly preflight for A's lifecycle: heavy gates already ran above;
  // this re-asserts the cheap invariants right before UDS goes live.
  const preflight: PreflightRunner = {
    async run() {
      assertPhase1Profile(PHASE1_PROFILE);
      // transport must still be alive — a dead upstream means no UDS.
      await transport.writeFrame({ jsonrpc: "2.0", method: "initialized" } as never)
        .catch(() => {
          throw new Error("gateway preflight: upstream transport is not writable");
        });
    },
  };

  lifecycle = new GatewayLifecycle({
    backendSocketPath: opts.backendSocketPath,
    tuiSocketPath: opts.tuiSocketPath,
    socketDir: opts.socketDir,
    preflight,
    backend: scheduler, // ProtocolBackend surface == scheduler's typed contract
    upstreamTransport: transport,
    initSnapshotSource,
    diagnosticsSink,
    authorizer,
  });

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
    try {
      await upstreamRpc.request("thread/resume", { threadId });
    } catch {
      threadId = ""; // stale persisted thread → fresh below
    }
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

  // Owner attach/detach → scheduler pump park/unpark.
  // (A's server calls attachTui/detachTui; we poll-free re-kick on TUI
  // connect by watching the coordinator through the scheduler hook at
  // each enqueue; explicit re-kick on attachment change:)
  const humanOwner = lifecycle.humanOwnerCoordinator();
  if (humanOwner) {
    const origAttach = humanOwner.attachTui.bind(humanOwner);
    const origDetach = humanOwner.detachTui.bind(humanOwner);
    // NOTE: wrapping the coordinator's own methods (not A's files) —
    // instance-level composition, A's class untouched.
    (humanOwner as { attachTui: () => void }).attachTui = () => {
      origAttach();
      scheduler.onOwnerAttachmentChanged();
    };
    (humanOwner as { detachTui: () => void }).detachTui = () => {
      origDetach();
      scheduler.onOwnerAttachmentChanged();
    };
  }

  log(`[gateway] assembled: thread ${threadId.slice(0, 12)}… (created=${created})`);

  return {
    lifecycle,
    scheduler,
    adapter,
    ledger,
    transport,
    threadId,
    pump: (rows, hooks) => pumpInboxBatch(rows, scheduler, hooks),
    async stop() {
      await lifecycle!.stop();
      await transport.close();
      await spawned.shutdown();
    },
  };
}
