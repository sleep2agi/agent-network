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

/** #1293 — undo a `recordSpawnedChild` when the spawn turns out not to
 *  have produced a usable child (capability fail-fast tripped).
 *
 *  🔴 这个函数存在的唯一理由是让记录可以**提前**：子节点在 spawn 那一刻就对 hub 可见,
 *     而记录原本排在 5 秒能力检查之后 —— 中间那段窗口里,hub 认识它、daemon 不认,
 *     任何 stop/delete 都 ack `noop_not_my_child`,hub 侧不收敛(#1293 实测约 5s)。
 *     提前记录必须配一个移除,否则能力检查失败时会在 map 里留一条**死条目**,
 *     而 handleStopDoorbell 会照着它去 signal 一个已经不存在的 pid。
 *  返回是否真的删掉了一条 —— 调用方可以据此判断「我记过吗」,而不是假设。 */
export function forgetSpawnedChild(child_node_id: string): boolean {
  return childrenMap.delete(child_node_id);
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


/** 把子节点的配置目录搬进回收站。命中与未命中两条 delete 路径共用它，
 *  这样「移动失败怎么办」不会在两处各写一遍然后慢慢漂开。
 *
 *  立场沿用命中路径原有的选择：移动失败**不**让整个 delete 失败 —— 子进程
 *  此时已经不在了，hub 侧的行应当收敛（删行 + 撤 ntok），本地回收站泄漏
 *  通过 warn 暴露。调用方靠 backup_path 在与不在来区分「真搬走了」和
 *  「盘上本来就没有」。 */
function moveWorkdirToTrash(
  child_alias: string,
  workdirRoot: string,
  deletedRoot: string,
  deps: StopDoorbellDeps,
  ensureDir: (p: string, mode: number) => void,
  chmod: (p: string, mode: number) => void,
  renameDir: (src: string, dst: string) => void,
): string | null {
  try {
    ensureDir(deletedRoot, 0o700);
    try { chmod(deletedRoot, 0o700); } catch { /* best-effort */ }
    const dst = join(deletedRoot, `${Date.now()}-${child_alias}`);
    renameDir(join(workdirRoot, child_alias), dst);
    chmod(dst, 0o700);
    deps.log(`[stop-daemon] backed up child workdir → ${dst} (chmod 700)`);
    return dst;
  } catch (e: any) {
    deps.warn(`[stop-daemon] backup mv failed for ${child_alias}: ${e?.message || e}`);
    return null;
  }
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
    // #1286 (delete) + #1448 finding-3 (stop): no map entry, for BOTH actions.
    //
    // entry 缺失不是罕见事：成功 stop 会删 map 条目、子节点自己崩了 rebuild 的
    // pgrep 也找不到 → stop-then-delete 或 crash-then-stop 时 miss 是必然的。
    //
    // #1286 把 delete 从「ack noop_not_my_child、留 hub 卡 deleting」修成了
    // 「sweep + (delete 才)搬 workdir + ack stopped」收敛。但当时只改了 delete,
    // 对称的 stop 路径仍走老的 noop 分支 → hub 卡 stopping(finding-3 的症状)。
    //
    // 这里两个 action 统一收敛:map 只提供过 entry.pid(命中路径的 pgid 信号用),
    // child_alias 来自 hub 请求、sweepOrphansForAlias 按 alias(pgrep+/proc token
    // 精确)找进程——所以「daemon 重启但子节点还在跑」这种情况 sweep 会把它 SIGTERM
    // 掉,ack stopped 才是诚实的;子节点已崩则 sweep 无命中、ack stopped 同样诚实。
    // 🔴 workdir 只在 action==='delete' 时搬(stop 保留 config);stop 的 delete_config
    //    本就是 false,这里再叠一层 action 显式门,防任何 stop 请求误带 delete_config。
    deps.log(`[stop-daemon] ${action} without map entry (expected after stop / crash): ${child_node_id}`);
    if (child_alias) {
      await sweepOrphansForAlias(child_alias, signalProcess, deps, `${action} without map entry`);
    }
    const backup = (action === "delete" && delete_config && child_alias)
      ? moveWorkdirToTrash(child_alias, workdirRoot, deletedRoot, deps, ensureDir, chmod, renameDir)
      : null;
    // Ack `stopped` either way: the child is not running (swept) and — for
    // delete — its config is not in place, which IS each action's end state,
    // so the hub must converge (stop→stopped / delete→row gone + ntok revoked).
    // Acking noop_not_my_child would leave lifecycle_state stuck at
    // 'stopping'/'deleting' — the reported symptom. `backup_path` present vs
    // absent distinguishes "moved it" from "nothing was on disk"; a failed
    // move is surfaced by warn, matching the hit path's stance.
    await deps.callCommHub("ack_stop_request", {
      request_id, status: "stopped", ...(backup ? { backup_path: backup } : {}),
    }).catch((e: any) => {
      deps.warn(`[stop-daemon] ack failed: ${e?.message || e}`);
    });
    return;
  }

  // SIGTERM → grace → SIGKILL
  //
  // PR1.2 e2e BLOCKER catch (#348 docker run-3 2026-06-30): the
  // recorded `entry.pid` is the `anet node start` wrapper, which
  // create-node-daemon.ts spawns with `detached: true` (setsid →
  // wrapper becomes its own session leader, pgid == pid). The wrapper
  // then spawns an `agent-node --alias <name>` grandchild as a regular
  // child of the wrapper. When we SIGTERM only the wrapper PID, the
  // grandchild gets reparented to PID 1 and continues running — pgrep
  // still finds it, so the child is "stopped" in the hub's eyes but
  // still draining vendor calls / mutating /work. The 24 unit tests
  // all mock signalProcess and treat the single PID as authoritative,
  // so this couldn't surface in single-unit coverage.
  //
  // Fix: send signals to the negative-PID (process group) instead of
  // the bare PID. POSIX kill(-pgid, sig) delivers to every process in
  // the pgid, which is exactly what we want — the wrapper + every
  // descendant (grandchild agent-node, any helper processes the
  // wrapper itself spawned). Fall back to bare-PID on EPERM /
  // platforms where negative-PID isn't supported. The kill-0 liveness
  // check stays bare-PID since the wrapper PID's existence is the
  // authoritative "is the chain still up" signal.
  const sendGroupSignal = (pid: number, sig: NodeJS.Signals | 0) => {
    try {
      signalProcess(-pid, sig);
    } catch (e: any) {
      if (e?.code === "ESRCH") return;     // group gone — caller will see via isAlive
      if (e?.code === "EPERM" || e?.code === "EINVAL") {
        // No process group leader / negative-PID unsupported. Fall
        // back to single-PID signal — better than silently failing.
        try { signalProcess(pid, sig); } catch (e2: any) {
          if (e2?.code !== "ESRCH") throw e2;
        }
        return;
      }
      throw e;
    }
  };
  let exit_signal: string = "UNKNOWN";
  try {
    if (isAlive(entry.pid, signalProcess)) {
      sendGroupSignal(entry.pid, "SIGTERM");
      exit_signal = "SIGTERM";
      deps.log(`[stop-daemon] sent SIGTERM to pgid=${entry.pid} alias=${entry.alias} grace=${grace_seconds}s (covers wrapper + agent-node grandchild)`);
      const reaped = await waitForExit(entry.pid, grace_seconds * 1000, signalProcess, sleep, now);
      if (!reaped) {
        sendGroupSignal(entry.pid, "SIGKILL");
        exit_signal = "SIGKILL";
        deps.warn(`[stop-daemon] grace exceeded, sent SIGKILL to pgid=${entry.pid} alias=${entry.alias}`);
        await waitForExit(entry.pid, 5_000, signalProcess, sleep, now);
      }
    } else {
      exit_signal = "ALREADY_DEAD";
      deps.log(`[stop-daemon] pid=${entry.pid} alias=${entry.alias} already dead before SIGTERM`);
      // Defense-in-depth: the wrapper may have died (crash / external
      // kill) while the detached grandchild kept running. Sweep any
      // stray agent-node process matching this alias and SIGTERM it.
      await sweepOrphansForAlias(entry.alias, signalProcess, deps, "wrapper was already dead");
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
  // Shared with the no-map-entry delete branch above so the two paths cannot
  // drift on "what happens when the move fails".
  const backup_path: string | null = (action === "delete" && delete_config && child_alias)
    ? moveWorkdirToTrash(child_alias, workdirRoot, deletedRoot, deps, ensureDir, chmod, renameDir)
    : null;

  // PR1.2 e2e defense-in-depth: even after pgid signaling, sweep any
  // residual agent-node process matching this alias. Catches the case
  // where a grandchild might have called its own setsid() and escaped
  // the wrapper's pgid (current agent-node doesn't, but the supervisor
  // path could change in the future and this assertion would still
  // hold). Verifies via /proc/<pid>/cmdline argv-adjacency to avoid
  // PR1.1's alias-substring footgun.
  // #1286 埋点 —— 复现时 daemon 日志**每次都停在** `backed up child workdir`,
  // 之后 48 秒零输出。备份到 ack 之间只有三步,但三步在源码上都有保护,静态读不出
  // 是哪一步。这三行把那段变成可读的:下次复现直接看日志停在哪一行,就定位到哪一步。
  // 🔴 它们不改变任何行为,唯一作用是让下一次复现能给出答案而不是又一次「停住了」。
  deps.log(`[stop-daemon] entering residual sweep alias=${entry.alias}`);
  await sweepOrphansForAlias(entry.alias, signalProcess, deps, "post-pgid-signal residual sweep");
  deps.log(`[stop-daemon] residual sweep returned alias=${entry.alias}`);

  childrenMap.delete(child_node_id);
  deps.log(`[stop-daemon] dropped from children map child_node_id=${child_node_id}, sending ack action=${action}`);

  await deps.callCommHub("ack_stop_request", {
    request_id, status: "stopped", exit_signal, ...(backup_path ? { backup_path } : {}),
  }).then(() => {
    deps.log(`[stop-daemon] ack accepted request_id=${request_id} action=${action}`);
  }).catch((e: any) => {
    deps.warn(`[stop-daemon] ack failed: ${e?.message || e}`);
  });
}

/** PR1.2 e2e helper — find any running agent-node process whose argv
 * has `--alias <alias>` (token-exact, NOT substring) AND whose binary
 * is `agent-node` or `cli.js`, and send SIGTERM. Used as a safety net
 * in handleStopDoorbell on two paths:
 *   1. wrapper-already-dead branch (grandchild may have been
 *      reparented to PID 1 by the wrapper's prior death)
 *   2. post-pgid-signal residual sweep (catches any future setsid'd
 *      grandchild that escaped the pgid)
 * Excludes self-pid + the daemon's own pid (the daemon itself is
 * `agent-node --alias <daemon-alias>` so we mustn't reach it). The
 * call site already passes the CHILD's alias, not the daemon's, but
 * we double-check by excluding self-pid as an extra belt — if anyone
 * ever calls this with the daemon's own alias by mistake, the
 * self-pid guard keeps it harmless.
 */
async function sweepOrphansForAlias(
  alias: string,
  signalProcess: (pid: number, sig: NodeJS.Signals | 0) => void,
  deps: StopDoorbellDeps,
  reason: string,
): Promise<void> {
  try {
    // SHOULD-FIX nit (PR #349 ack): drop the unused `readFileSync` from
    // this destructure — it's exported by node:fs, not node:child_process,
    // and the actual reads go through `fs.readFileSync` from the
    // separate import on the next line. Was a copy-paste leftover.
    const { execSync } = await import("node:child_process") as any as { execSync: (cmd: string, opts: any) => string };
    const fs = await import("node:fs");
    // PR1.1 cmdlineMatchesAlias-style verification: regex pgrep first
    // (cheap shortlist), then /proc/<pid>/cmdline argv-adjacency
    // check to filter substring-collision false positives.
    let out: string;
    try {
      // #1286 —— 🔴 这个 execSync 原来既没有 timeout 也没有 maxBuffer,而它坐在
      // 「备份完 workdir」到「发 ack_stop_request」这条路径的正中间。两个后果:
      //   · 无 timeout:pgrep 卡住 ⇒ 整个 doorbell 永不到达 ack ⇒ hub 行永远停在
      //     lifecycle_state=deleting,用户侧表现为「删不掉」,而 daemon 日志最后一行
      //     就停在 `backed up child workdir`,不报任何错。
      //   · 无 maxBuffer:默认 1MB。`pgrep -af` 打印**完整命令行**,agent-node 的命令行
      //     很长;进程多的机器上会 ENOBUFS 抛出 —— 那条路径是被 catch 住的(会 return,
      //     ack 照发),所以它不是挂死的成因,但会让清扫**静默失效**。
      // 🔴 我没有证据说这就是 #1286 的成因 —— 见本 PR 说明。这是独立成立的硬化:
      //    daemon 关键路径上不该有无上限的同步子进程调用。
      out = execSync(`pgrep -af 'agent-node' || true`, { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      return;
    }
    const candidates = out.split(/\r?\n/)
      .map(l => parseInt(l.trim().split(/\s+/)[0] || "0", 10))
      .filter(p => Number.isFinite(p) && p > 0 && p !== process.pid);
    for (const p of candidates) {
      let cmdline: string | null = null;
      try { cmdline = fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { continue; }
      if (!cmdlineMatchesAlias(cmdline, alias)) continue;
      deps.warn(`[stop-daemon] sweeping orphan pid=${p} alias=${alias} (${reason})`);
      try { signalProcess(p, "SIGTERM"); } catch { /* may already be dead */ }
    }
  } catch (e: any) {
    deps.warn(`[stop-daemon] orphan sweep skipped (${reason}): ${e?.message || e}`);
  }
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
