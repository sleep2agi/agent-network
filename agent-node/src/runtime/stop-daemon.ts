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

import { chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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

// ─── RFC-027 PR1.1 — rebuildChildrenMapOnBoot ─────────────────────────
//
// On daemon process restart the in-memory childrenMap is empty. Without
// rebuild, every stop/delete dispatch for a still-running child no-ops
// with `noop_not_my_child` (same failure shape as PR1's BLOCKER-1) →
// hub never finalizes → user sees stop hang. The fix:
//
// 1. Pull this daemon's owned child aliases from hub via list_my_children
//    (PR1.1 MCP tool — returns {child_node_id, alias, lifecycle_state}
//    tuples scoped by the daemon's bound token + network).
// 2. For each alias, run `pgrep` to find the running process. Hardening
//    per 通信龙 proactive notes:
//      a. alias substring collisions ("bot" matching "bot2") — pgrep
//         pattern uses an explicit boundary (`--alias <alias>` followed
//         by EOL or whitespace), and we re-check via /proc/<pid>/cmdline
//         token-exact equality before trusting the match.
//      b. self-match / other daemon's children — intersect pgrep result
//         with the hub-supplied alias set; pgrep is the noisy candidate
//         source, hub is the authority.
//      c. defunct / zombie pids — /proc/<pid>/stat State=Z gets skipped.
//      d. hub-says-active but no matching pid → log a warn (operator
//         signal) but don't try to nudge hub state from here. P3 may add
//         a "report dead child" tool; PR1.1 just surfaces.

interface MyChild { child_node_id: string; alias: string; lifecycle_state: string; }

export interface RebuildDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  // Injectable for tests: returns candidate pids matching the pgrep
  // pattern for an alias.
  pgrepAlias?: (alias: string) => Promise<number[]>;
  // Injectable for tests: returns the /proc/<pid>/cmdline buffer (or
  // null if the pid disappeared mid-read).
  readProcCmdline?: (pid: number) => string | null;
  // Injectable for tests: returns the /proc/<pid>/stat State char
  // (e.g. "R", "S", "Z"). Null if pid gone.
  readProcStatState?: (pid: number) => string | null;
}

/** Default pgrep wrapper. Pattern explicitly boundary-anchored so
 *  alias "bot" doesn't match "bot2" / "bot-test". */
async function defaultPgrepAlias(alias: string): Promise<number[]> {
  const safe = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `agent-node.*--alias ${safe}($|[[:space:]])`;
  try {
    const { stdout } = await execFileP("pgrep", ["-f", pattern], { timeout: 5000 });
    return stdout.split(/\s+/).filter(Boolean).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  } catch (e: any) {
    // pgrep exits 1 when no match — treat as empty result, not error.
    if (e?.code === 1) return [];
    throw e;
  }
}

function defaultReadProcCmdline(pid: number): string | null {
  try {
    // /proc/<pid>/cmdline is NUL-separated; we want the raw bytes
    // and will split on NUL to get individual argv tokens.
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch { return null; }
}

function defaultReadProcStatState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // /proc/<pid>/stat format: "PID (comm) STATE ...". comm may
    // contain spaces+parens so we slice after the closing paren.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const tail = stat.slice(close + 1).trim().split(/\s+/);
    return tail[0] || null;
  } catch { return null; }
}

/** Check that a /proc/<pid>/cmdline argv contains BOTH `agent-node`
 *  AND `--alias <alias>` as adjacent tokens. Defends against
 *  alias substring collisions (pgrep matches the pattern but the
 *  actual argv has alias as a suffix of another token). */
function cmdlineMatchesAlias(cmdline: string | null, alias: string): boolean {
  if (!cmdline) return false;
  const argv = cmdline.split("\0").filter(Boolean);
  const aliasIdx = argv.findIndex((tok, i) => tok === "--alias" && argv[i + 1] === alias);
  if (aliasIdx < 0) return false;
  // Belt: ensure agent-node is in argv (process name or path).
  return argv.some(t => t === "agent-node" || t.endsWith("/agent-node") || t.endsWith("/cli.js"));
}

export interface RebuildResult {
  total_children_from_hub: number;
  recovered: number;        // children whose pid was found and registered
  missing: string[];        // hub-active alias with no matching live pid (warn-only)
  ambiguous: string[];      // alias with >1 candidate pid after cmdline verify (skipped)
  zombies: string[];        // alias whose pid was in defunct state (skipped)
}

export async function rebuildChildrenMapOnBoot(deps: RebuildDeps): Promise<RebuildResult> {
  const result: RebuildResult = { total_children_from_hub: 0, recovered: 0, missing: [], ambiguous: [], zombies: [] };
  const pgrepAlias = deps.pgrepAlias ?? defaultPgrepAlias;
  const readCmdline = deps.readProcCmdline ?? defaultReadProcCmdline;
  const readState = deps.readProcStatState ?? defaultReadProcStatState;

  let children: MyChild[];
  try {
    const r = await deps.callCommHub("list_my_children", {});
    if (!r?.ok || !Array.isArray(r.children)) {
      deps.warn(`[rebuild] list_my_children failed: ${r?.error || "unknown"}`);
      return result;
    }
    children = r.children;
  } catch (e: any) {
    deps.warn(`[rebuild] list_my_children threw: ${e?.message || e}`);
    return result;
  }
  result.total_children_from_hub = children.length;

  const selfPid = process.pid;

  for (const c of children) {
    if (!c.alias || !c.child_node_id) continue;
    let pids: number[];
    try {
      pids = await pgrepAlias(c.alias);
    } catch (e: any) {
      deps.warn(`[rebuild] pgrep failed for alias=${c.alias}: ${e?.message || e}`);
      continue;
    }

    // Filter out self + non-matching cmdline + defunct zombies.
    const verified: number[] = [];
    for (const pid of pids) {
      if (pid === selfPid) continue;
      const state = readState(pid);
      if (state === "Z") {
        result.zombies.push(c.alias);
        continue;
      }
      const cmd = readCmdline(pid);
      if (!cmdlineMatchesAlias(cmd, c.alias)) continue;
      verified.push(pid);
    }

    if (verified.length === 0) {
      // Hub says this alias is active but no live process found.
      // Warn-only per PR1.1 scope; nudging hub state is a follow-up.
      result.missing.push(c.alias);
      deps.warn(`[rebuild] hub-active alias=${c.alias} has no matching pid (crashed without cleanup?)`);
      continue;
    }
    if (verified.length > 1) {
      // Multiple matching pids — refuse to guess, log + skip. Operator
      // intervention required.
      result.ambiguous.push(c.alias);
      deps.warn(`[rebuild] alias=${c.alias} matched ${verified.length} pids ${verified.join(",")} after cmdline filter — skipping`);
      continue;
    }
    recordSpawnedChild(c.child_node_id, c.alias, verified[0]);
    result.recovered++;
    deps.log(`[rebuild] recovered alias=${c.alias} → pid=${verified[0]}`);
  }

  deps.log(`[rebuild] done: total=${result.total_children_from_hub} recovered=${result.recovered} missing=${result.missing.length} ambiguous=${result.ambiguous.length} zombies=${result.zombies.length}`);
  return result;
}

// Exported for unit tests so they can exercise cmdlineMatchesAlias
// without spawning real processes.
export const _internals = { cmdlineMatchesAlias };
