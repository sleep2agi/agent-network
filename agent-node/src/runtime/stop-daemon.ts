// RFC-027 §2.4 — daemon-side stop/delete handler.
//
// Receives an SSE `{type:'stop_node', request_id}` doorbell from hub
// (sent by the stop_node / delete_node MCP tool dispatcher), pulls the
// envelope via get_stop_request, runs SIGTERM → grace → SIGKILL on
// the recorded PID, optionally backs up the child's workdir to
// `~/.anet/deleted/<ts>-<alias>/` with chmod 700, then acks via
// ack_stop_request.
//
// Key invariants (§2.4):
//   - We never fork/exec a binary in this path — only `process.kill`
//     a PID that we previously stored via `recordSpawnedChild` (RFC-026
//     §4.2 attack-surface seal).
//   - backup_path naming = `<Date.now()>-<alias>` so the same alias can
//     be deleted-and-recreated without collision (scenario K).
//   - chmod 700 immediately after rename, even if source dir was looser
//     (secret/env_refs files mustn't leak via the trash dir; D7 nit).
//   - `noop_not_my_child` is informational — not an error. Daemon restart
//     before rebuildChildrenMapOnBoot lands is the common cause. Hub-side
//     sweeper / reconciliation picks up the row eventually.

import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Module-level child map. Filled by recordSpawnedChild when create-node-
// daemon successfully spawns a child; consumed by handleStopDoorbell to
// know which PID to signal. PR1 keeps it in-process — PR1.1 will add
// pgrep-based boot recovery (rebuildChildrenMapOnBoot stub below).
export interface ChildEntry {
  pid: number;
  started_at: number;
  child_node_id: string;
  alias: string;
}
const childrenMap = new Map<string, ChildEntry>();

/** Called by create-node-daemon after a successful spawn. Idempotent
 *  — re-recording an existing child_node_id overwrites (e.g. on rename
 *  cycle). The hub-side state machine already prevents duplicate
 *  create dispatches for the same alias. */
export function recordSpawnedChild(child_node_id: string, alias: string, pid: number): void {
  childrenMap.set(child_node_id, { pid, started_at: Date.now(), child_node_id, alias });
}

/** Test-only helper — clears the map so test suites can isolate. NOT
 *  exposed via cli; daemon runtime never wants to drop its tracking
 *  state mid-flight. */
export function _resetChildrenMapForTest(): void { childrenMap.clear(); }

/** Read-only access for diagnostics. */
export function getChildrenSnapshot(): ChildEntry[] {
  return Array.from(childrenMap.values());
}

export interface StopDoorbellDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  // Path roots. Defaulted from process.env.HOME in cli wiring; tests
  // can override to a temp dir.
  workdirRoot?: string;       // <home>/.anet/nodes — where child config dirs live
  deletedRoot?: string;       // <home>/.anet/deleted — backup target
  // Allow tests to inject a fake kill / sleep / rename / clock so we
  // can drive the state machine without burning real wall-clock or
  // spawning real subprocesses. Production wires these to node:process
  // / setTimeout / Date.now / node:fs.
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;          // virtual clock for tests; defaults to Date.now
  renameDir?: (src: string, dst: string) => void;
  ensureDir?: (path: string, mode: number) => void;
  chmod?: (path: string, mode: number) => void;
}

interface GetStopRequestResult {
  ok: boolean;
  error?: string;
  request_id?: string;
  child_node_id?: string;
  child_alias?: string;
  action?: "stop" | "delete";
  delete_config?: boolean;
  grace_seconds?: number;
  force?: boolean;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** kill-0 check — does PID still exist? Used to poll for reap. */
function isAlive(pid: number, signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (e: any) {
    if (e?.code === "ESRCH") return false;
    throw e;
  }
}

/** Wait up to `timeoutMs` for the PID to die. Polls every 200ms.
 * `now` is injectable so tests can drive a virtual clock instead of
 * burning real wall-clock (PR1 SF-1 #345 review catch: the SIGKILL
 * escalation test was timing out at the default 5s bun-test budget
 * because the real Date.now was used; under the fake sleep the loop
 * could never advance).
 */
async function waitForExit(
  pid: number,
  timeoutMs: number,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive(pid, signalProcess)) return true;
    await sleep(200);
  }
  return !isAlive(pid, signalProcess);
}

export async function handleStopDoorbell(
  event: { request_id: string },
  deps: StopDoorbellDeps,
): Promise<void> {
  const { request_id } = event;
  const signalProcess = deps.signalProcess ?? ((pid, sig) => { process.kill(pid, sig); });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const renameDir = deps.renameDir ?? ((src, dst) => renameSync(src, dst));
  const ensureDir = deps.ensureDir ?? ((p, mode) => { mkdirSync(p, { recursive: true, mode }); });
  const chmod = deps.chmod ?? ((p, mode) => chmodSync(p, mode));
  const workdirRoot = deps.workdirRoot ?? join(homedir(), ".anet", "nodes");
  const deletedRoot = deps.deletedRoot ?? join(homedir(), ".anet", "deleted");

  let req: GetStopRequestResult;
  try {
    req = await deps.callCommHub("get_stop_request", { request_id });
  } catch (e: any) {
    deps.warn(`[stop-daemon] get_stop_request failed: ${e?.message || e}`);
    return; // hub will retry via sweeper
  }
  if (!req?.ok || !req.child_node_id || !req.action) {
    deps.warn(`[stop-daemon] get_stop_request returned error: ${req?.error || "unknown"}`);
    return;
  }
  const { child_node_id, child_alias, action, delete_config = true, grace_seconds = 10 } = req;

  const entry = childrenMap.get(child_node_id);
  if (!entry) {
    // §2.4 — degraded path, not an error. Daemon restart + pre-boot-
    // rebuild scenario. Ack so hub can move on.
    deps.log(`[stop-daemon] child not in map (likely daemon-restarted): ${child_node_id}`);
    await deps.callCommHub("ack_stop_request", {
      request_id, status: "noop_not_my_child",
      error: "child not in children_map; daemon likely restarted before rebuild",
    }).catch(() => { /* ack failure → next sweeper picks up */ });
    return;
  }

  // SIGTERM → grace → SIGKILL
  let exit_signal: string = "UNKNOWN";
  try {
    if (isAlive(entry.pid, signalProcess)) {
      signalProcess(entry.pid, "SIGTERM");
      exit_signal = "SIGTERM";
      deps.log(`[stop-daemon] sent SIGTERM to pid=${entry.pid} alias=${entry.alias} grace=${grace_seconds}s`);
      const reaped = await waitForExit(entry.pid, grace_seconds * 1000, signalProcess, sleep, now);
      if (!reaped) {
        try { signalProcess(entry.pid, "SIGKILL"); } catch (e: any) {
          if (e?.code !== "ESRCH") throw e;
        }
        exit_signal = "SIGKILL";
        deps.warn(`[stop-daemon] grace exceeded, sent SIGKILL to pid=${entry.pid} alias=${entry.alias}`);
        await waitForExit(entry.pid, 5_000, signalProcess, sleep, now);
      }
    } else {
      exit_signal = "ALREADY_DEAD";
      deps.log(`[stop-daemon] pid=${entry.pid} alias=${entry.alias} already dead before SIGTERM`);
    }
  } catch (e: any) {
    if (e?.code === "ESRCH") {
      exit_signal = "ALREADY_DEAD";
    } else {
      deps.warn(`[stop-daemon] signal flow threw: ${e?.message || e}`);
      await deps.callCommHub("ack_stop_request", {
        request_id, status: "stop_failed",
        exit_signal,
        error: `signal failed: ${(e?.message || e).toString().slice(0, 500)}`,
      }).catch(() => {});
      return;
    }
  }

  // §2.4 / §4.4 — for delete branch with delete_config=true, move the
  // child's workdir into the trash. chmod 700 on both the parent
  // (~/.anet/deleted) and the moved dir so secrets don't leak.
  let backup_path: string | null = null;
  if (action === "delete" && delete_config && child_alias) {
    try {
      ensureDir(deletedRoot, 0o700);
      // chmod the parent too in case it pre-existed with looser perms.
      try { chmod(deletedRoot, 0o700); } catch { /* best-effort */ }
      backup_path = join(deletedRoot, `${Date.now()}-${child_alias}`);
      const srcDir = join(workdirRoot, child_alias);
      renameDir(srcDir, backup_path);
      chmod(backup_path, 0o700);
      deps.log(`[stop-daemon] backed up child workdir → ${backup_path} (chmod 700)`);
    } catch (e: any) {
      deps.warn(`[stop-daemon] backup mv failed for ${child_alias}: ${e?.message || e}`);
      // Don't fail the whole stop — child process is already gone. Ack
      // 'stopped' with backup_path=null so hub still finalizes; row is
      // deleted, ntok revoked, and the daemon's local trash leak is
      // surfaced via the warn log + next sweeper run.
      backup_path = null;
    }
  }

  childrenMap.delete(child_node_id);

  await deps.callCommHub("ack_stop_request", {
    request_id, status: "stopped", exit_signal, ...(backup_path ? { backup_path } : {}),
  }).catch((e: any) => {
    deps.warn(`[stop-daemon] ack failed: ${e?.message || e}`);
  });
}
