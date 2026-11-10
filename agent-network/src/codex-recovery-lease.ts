// Board #762 — the host-wide codex legacy-recovery lease (cap 1, see
// codex-recovery-resource-gate.ts) must be released as soon as the bridge and
// the TUI are ready, and on every failure path, no matter what the launcher
// does afterwards.
//
// Before this, the POSIX launcher released it only at the very end of its
// health checks, and the many `process.exit(1)` failure paths released it
// only by dying. A launcher that kept running after "③ TUI … ready to attach"
// kept renewing the lease every 30 s, and every later recovery on the host
// (watchdog restarts included) waited at "waiting for a start slot (cap 1)".

export interface RecoveryLease {
  release: () => void;
}

export interface RecoveryLeaseHolderDeps {
  /** Register `fn` to run when the process exits; returns an unregister function.
   * Defaults to process.on("exit"), which also covers `process.exit(1)` failure paths. */
  onProcessExit?: (fn: () => void) => () => void;
  log?: (message: string) => void;
}

export interface RecoveryLeaseHolder {
  /** Take ownership of a lease returned by waitForCodexRecoveryResources. */
  hold(lease: RecoveryLease): void;
  /** Release the held lease (stops its heartbeat and drops the slot). Idempotent. */
  release(reason?: string): void;
  readonly held: boolean;
}

function defaultOnProcessExit(fn: () => void): () => void {
  process.on("exit", fn);
  return () => { process.off("exit", fn); };
}

export function createRecoveryLeaseHolder(deps: RecoveryLeaseHolderDeps = {}): RecoveryLeaseHolder {
  const onProcessExit = deps.onProcessExit ?? defaultOnProcessExit;
  let lease: RecoveryLease | undefined;
  let unregister: (() => void) | undefined;
  const release = (reason?: string) => {
    const current = lease;
    lease = undefined;
    const off = unregister;
    unregister = undefined;
    try { off?.(); } catch { /* the exit hook is best-effort */ }
    if (!current) return;
    try { current.release(); } catch { /* a leaked lease expires; the next admit reaps it */ }
    if (reason) deps.log?.(`[recovery-gate] recovery lane released (${reason})`);
  };
  return {
    hold(next) {
      if (lease && lease !== next) release("replaced");
      lease = next;
      if (!unregister) unregister = onProcessExit(() => release());
    },
    release,
    get held() { return lease !== undefined; },
  };
}

export interface CopresencePieces {
  /** `--tui-first`: restore the exact-session TUI before the bridge attaches. */
  tuiFirst: boolean;
  /** Piece ②: starts the bridge and resolves once it reported READY. */
  launchBridge: () => Promise<void>;
  /** Piece ③: starts the TUI session ("③ TUI … ready to attach"). */
  launchTui: () => void;
  /** Resolves once the TUI has painted a usable screen. */
  requireTuiPainted: () => Promise<void>;
  /** The TUI's own process tree must connect to the exact app-server; paint alone
   * can precede WebSocket hydration and does not release the recovery lane. */
  requireTuiConnected: () => Promise<void>;
  /** Runs once both sessions were launched (marker refresh, liveness check). */
  afterLaunch?: () => void;
  /** Printed between the TUI paint and the bridge attach on the --tui-first path. */
  announceTuiFirst?: () => void;
  lease: RecoveryLeaseHolder;
}

/** Bring up the bridge and the TUI in the configured order, then release the
 * recovery lease: the legacy resume (bridge) and the TUI hydration are the
 * memory-heavy part the lane protects. The lease is released on failure too. */
export async function launchCopresencePiecesReleasingRecovery(p: CopresencePieces): Promise<void> {
  try {
    if (p.tuiFirst) {
      p.launchTui();
      await p.requireTuiPainted();
      p.announceTuiFirst?.();
      await p.launchBridge();
      p.afterLaunch?.();
    } else {
      await p.launchBridge();
      p.launchTui();
      p.afterLaunch?.();
      await p.requireTuiPainted();
    }
    await p.requireTuiConnected();
  } catch (e) {
    p.lease.release("bridge/TUI start failed");
    throw e;
  }
  p.lease.release("bridge and TUI ready");
}
