// RFC-030 P3-A v3 — managed identity + group reap for copresence teardown.
//
// v3 (2026-07-29) exists because an independent audit did what three
// previous review rounds did not: it ran the code on a real Linux box. The
// mock suite was 52/52 green while the feature was 100% non-functional
// here, because EVERY unit test injected MockEnumer/MockKiller and the real
// implementations had literally zero test references. Mutation testing on
// that suite proved only that the mock and the implementation agreed with
// each other. The v3 corrections and the real-/proc suite that guards them:
//
//   - Blocker 1: the fail-closed "unreadable" list was machine-wide, so any
//     same-uid/different-gid process on the host (a docker helper, here)
//     made reapMarkerGroups return "failed" forever — the marker was never
//     removed and every stop printed "teardown incomplete" even when the
//     tree was clean. Scope is now bounded to our own process tree
//     (invariant 11).
//   - Blocker 2: process ownership was read from the /proc/PID/environ
//     INODE owner, which reports root for our own non-dumpable children
//     (prctl(PR_SET_DUMPABLE,0)). Those carriers were invisible: not a hit,
//     not unreadable, so teardown "succeeded" and deleted the marker while
//     the orphan lived on. Ownership now comes from /proc/PID/status Uid:.
//   - Blocker 3: group-level stat-unreadable pids were collected before the
//     pgid filter — one hidden process anywhere blocked every group.
//   - Blocker 4: PLATFORM_UNSUPPORTED preceded the MISSING check, so every
//     node on macOS/Windows warned about a marker file that never existed.
//   - Blockers 5+6: start-side ordering and stale-marker reclaim, now in
//     prepareIdentityForStart (bottom of this file) so they are testable.
//   - Blocker 7: the post-rescan unreadable branch had no coverage.
//   - Blocker 8: invariant 5 promised a starttime re-verification that no
//     code performed; validateAnchors now performs it.
//
// Original v2 header follows.
//
// Restart of the earlier P3-A candidate (9f2ec282, invalidated 2026-07-29
// after 独立安全审 caught 3 blockers). Written from scratch to correct:
//   - Blocker 1: uuid was generated twice (start-side vs write-side) so the
//     tmux env uuid never matched the disk uuid → environ scan always 0 hits
//     → nothing was ever killed while the code reported success. Fix here:
//     writeMarker takes uuid as a parameter, single source of truth.
//   - Blocker 2: `ps -o pid= --pgid N` is not portable (procps-ng rejects it
//     with "unknown gnu long option"); the old catch-all swallowed the error
//     and returned [] which was judged "no foreign members, ok:true". Fix
//     here: enumeration uses direct /proc/*/stat reads via the injected
//     ProcessEnumerator (no ps at all); any read failure throws, callers
//     surface it as a fail-closed refuse.
//   - 副指挥 8 追加 + 通信龙 13 findings folded into structure below.
//
// Design invariants (each is unit-test-covered with mutation-red potential):
//   1. UUID round-trip: cli.ts generates uuid once, passes to writeMarker
//      AND to the tmux `-e ANET_NODE_MARKER=` inject. writeMarker persists
//      exactly that uuid. Any code path that generates a second uuid → red.
//   2. Enumeration is portable + errors are loud. On ENOENT for /proc/PID
//      the pid is simply gone (return null, that's normal); on any other
//      error the enumerator throws and the reap flow refuses.
//   3. Group homogeneity fail-closed: every live member of a PGID must
//      carry the marker; any foreign member (marker absent) OR any
//      unreadable member (permission / race) → SKIP the group, log detail.
//      Never assume "empty foreign list == safe" from a swallowed error.
//   4. Marker file safety: 0600 mode enforced at read; symlinks refused
//      (lstat + regular-file check); owner uid verified; malformed JSON
//      / wrong schema / non-object bodies return structured refuse (never
//      TypeError from `in` operator on null/number/array/etc.).
//   5. PID reuse: the marker file's recorded session pids are NOT a kill
//      list — identity is always the environ uuid. They are used for one
//      thing only: anchoring the "is this unreadable process plausibly
//      part of our tree" scope check (invariant 11). Before a recorded pid
//      may act as an anchor it must still be the SAME process, proven by
//      comparing SessionInfo.starttime_jiffies against the live
//      /proc/PID/stat starttime (see validateAnchors). A recycled pid has
//      a different starttime and is dropped. Host-level reuse across a
//      reboot is caught earlier by the boot_id check in readMarker.
//   6. TOCTOU: before each kill() call, re-run environ scan + homogeneity.
//      Do not act on a 3-second-old snapshot.
//   7. Self-context: caller ancestry is walked (getpid + PPID walk); if
//      any ancestor carries the target marker, refuse the stop with
//      "run from external shell", never "exclude caller and continue".
//   8. Copresence gating: the stop-time gate keys on a persistent
//      config-level flag (marker file EXISTS), not on runtime string.
//      Ordinary codex-app-server nodes without --copresence do not have
//      a marker file → readMarker returns MISSING → caller falls through
//      to the pre-P3 legacy stop path (zero diff).
//   9. Partial-start rollback: if start fails before writeMarker is called,
//      NO marker file exists → subsequent stop uses legacy path (safe).
//      If start fails AFTER writeMarker, marker exists → stop uses the
//      identity flow. Never blind pkill on partial state.
//  10. Idempotent: readMarker returning MISSING is a "clean, already stopped"
//      signal — not a warning. The stop caller prints one informational line
//      and exits 0.
//  11. Fail-closed scope is BOUNDED to our own process tree. Every
//      fail-closed signal derived from "a process we could not inspect"
//      must first prove that process is plausibly ours: its pgid belongs to
//      a marker-carrying group, or its ppid chain reaches a marker carrier
//      or a validated marker-file session pid. An unrelated process
//      elsewhere on the machine that we merely cannot read (different
//      primary gid, hidepid, LSM, container policy) must NEVER be able to
//      block teardown. v2 violated this: a machine-wide unreadable list
//      meant reapMarkerGroups could never return success on a host that
//      happened to run any same-uid/different-gid process, so the marker
//      was never removed and every stop printed "teardown incomplete".

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  lstatSync,
  chmodSync,
  renameSync,
  readdirSync,
  mkdirSync,
  fsyncSync,
  openSync,
  closeSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

export interface SessionInfo {
  tmux: string;
  pid: number;
  pgid: number;
  starttime_jiffies: number;
}

export interface CopresenceMarker {
  marker: string; // uuid v4
  boot_id: string;
  started_at_epoch_ms: number;
  owner_uid: number;
  // Best-effort observability hints (which tmux session each pid came from,
  // pgid/starttime at harvest time). NOT the identity source — reap uses
  // /proc/PID/environ scan for the marker uuid, which stays valid even when
  // the recorded pids die or spawn workers under different pgids.
  //
  // Finding #4 (audit 92d53c8f): every field here is OPTIONAL. If pane pid
  // harvest fails for any session (or all), the marker file still gets
  // written — the identity uuid is what matters. Prior all-or-nothing gate
  // meant one flaky tmux display-message call destroyed the node's ability
  // to be identity-reaped forever.
  sessions: {
    appsrv?: SessionInfo;
    bridge?: SessionInfo;
    tui?: SessionInfo;
  };
}

export type RefuseCause =
  | "MISSING"
  | "SYMLINK"
  | "NOT_REGULAR"
  | "WRONG_MODE"
  | "OWNER_MISMATCH"
  | "PARSE_ERROR"
  | "SCHEMA_INVALID"
  | "STALE_BOOT_ID"
  | "PLATFORM_UNSUPPORTED";

export type ReadMarkerResult =
  | { kind: "ok"; marker: CopresenceMarker }
  | { kind: "refuse"; cause: RefuseCause; detail: string };

export interface ProcStat {
  pgid: number;
  starttime_jiffies: number;
  ppid: number;
}

/**
 * Injectable primitive for /proc access. Real impl reads the filesystem;
 * unit tests inject a mock so /proc-based logic is deterministically testable.
 *
 * Contract:
 *   - listAllPids: read /proc directory and return numeric-name entries.
 *     Throws on unrecoverable errors (permission denied on /proc itself).
 *   - readEnviron: read /proc/<pid>/environ as a raw string. Returns null
 *     if the pid has vanished (ENOENT) — that's a normal race, not a failure.
 *     Throws for permission errors etc.
 *   - readStat: read /proc/<pid>/stat and extract (pgid, starttime, ppid).
 *     Returns null on ENOENT (pid gone). Throws on other errors.
 */
export interface ProcessEnumerator {
  listAllPids(): number[];
  readEnviron(pid: number): string | null;
  readStat(pid: number): ProcStat | null;
  /**
   * REAL uid of the process itself (`Uid:` line of /proc/<pid>/status,
   * field 0). Used by the environ-EACCES discriminator to tell
   * "other-user process (expected EACCES)" from "our own process we could
   * not inspect (must be accounted for)".
   *
   * MUST NOT be implemented as `statSync('/proc/<pid>/environ').uid`.
   * A process that called prctl(PR_SET_DUMPABLE, 0) keeps its real uid but
   * its /proc/<pid>/{environ,mem,...} nodes flip to root:root 0400 (see
   * proc(5) / kernel `task_dump_owner`). Deriving ownership from the
   * environ inode therefore reports uid 0 for our OWN non-dumpable
   * children, which made them invisible to the scan: not in `hits`, not in
   * the unreadable list, so teardown reported success and deleted the
   * marker while the orphan lived on (Defect A).
   *
   * Returns null if the pid is gone (ENOENT) or if even /proc/<pid>/status
   * is blocked (hidepid / LSM) — in that case the process cannot be ours
   * to reason about and is skipped.
   */
  readOwnerUid(pid: number): number | null;
  /**
   * Single-character process state from /proc/<pid>/status (R/S/D/Z/T/...).
   * `Z` means zombie — mm freed, environ returns EACCES even to owner, but
   * the pid is going away shortly. Skip zombies during environ scan.
   * Returns null if the pid is gone (ENOENT).
   */
  readState(pid: number): string | null;
}

/**
 * Injectable primitive for sending signals. Real impl uses process.kill;
 * tests inject a mock.
 */
export interface KillPrimitive {
  killPgroup(pgid: number, signal: "TERM" | "KILL"): void;
  /** Returns true if ANY process in the pgroup is still alive. */
  pgroupAlive(pgid: number): boolean;
}

// ─── Paths ────────────────────────────────────────────────────────────────

export function markerFilePath(nodesDir: string, nodeId: string): string {
  return join(nodesDir, nodeId, "copresence-identity.json");
}

// ─── Boot ID (host identity for PID-reuse detection) ─────────────────────

export function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // No /proc/... (mac/win dev). Return a per-process synthetic so
    // cross-machine marker use always fails STALE_BOOT_ID rather than
    // matching a wildcard.
    return `no-boot-id-${process.pid}-${Date.now()}`;
  }
}

// ─── Marker file: write ──────────────────────────────────────────────────

function assertParentDir(nodesDir: string, nodeId: string): void {
  const dir = join(nodesDir, nodeId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write the marker file atomically.
 *
 * IMPORTANT (Blocker 1 fix): the uuid parameter is the SINGLE SOURCE OF
 * TRUTH. Caller is expected to inject this same uuid into every tmux
 * session's ANET_NODE_MARKER env var. writeMarker does NOT generate its
 * own uuid — that was the exact bug in 9f2ec282.
 */
export function writeMarker(
  nodesDir: string,
  nodeId: string,
  uuid: string,
  sessions: CopresenceMarker["sessions"],
): CopresenceMarker {
  if (typeof uuid !== "string" || uuid.length === 0) {
    throw new Error("writeMarker: uuid must be a non-empty string (caller-provided single source of truth)");
  }
  assertParentDir(nodesDir, nodeId);
  const marker: CopresenceMarker = {
    marker: uuid,
    boot_id: readBootId(),
    started_at_epoch_ms: Date.now(),
    owner_uid: process.getuid ? process.getuid()! : -1,
    sessions,
  };
  const finalPath = markerFilePath(nodesDir, nodeId);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  // Pre-unlink defeats symlink-follow (same idiom as P2 env-file fix).
  try { unlinkSync(tmpPath); } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
  const body = JSON.stringify(marker, null, 2) + "\n";
  // wx flag = exclusive create (belt-and-suspenders after pre-unlink).
  writeFileSync(tmpPath, body, { mode: 0o600, flag: "wx" });
  chmodSync(tmpPath, 0o600); // belt-and-suspenders (umask may have masked mode)
  const fd = openSync(tmpPath, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmpPath, finalPath);
  return marker;
}

// ─── Marker file: read (with all fail-closed refuses) ────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function validateSchema(obj: unknown): obj is CopresenceMarker {
  if (!isPlainObject(obj)) return false;
  if (typeof obj.marker !== "string" || obj.marker.length === 0) return false;
  if (typeof obj.boot_id !== "string") return false;
  if (typeof obj.started_at_epoch_ms !== "number") return false;
  if (typeof obj.owner_uid !== "number") return false;
  if (!isPlainObject(obj.sessions)) return false;
  const s = obj.sessions;
  for (const key of ["appsrv", "bridge", "tui"] as const) {
    const sess = s[key];
    if (sess === undefined) continue; // optional per finding #4
    if (!isPlainObject(sess)) return false;
    if (typeof sess.tmux !== "string") return false;
    if (typeof sess.pid !== "number") return false;
    if (typeof sess.pgid !== "number") return false;
    if (typeof sess.starttime_jiffies !== "number") return false;
  }
  return true;
}

/**
 * Read the marker file with structured fail-closed refuses.
 *
 * Never throws for expected refuse causes. Only throws if the OS itself
 * is broken (e.g. EIO). Malformed JSON, wrong types, null bodies etc.
 * all return { kind: "refuse", cause, detail }.
 */
export function readMarker(nodesDir: string, nodeId: string): ReadMarkerResult {
  const path = markerFilePath(nodesDir, nodeId);
  // Use lstat to catch symlinks (statSync would follow).
  //
  // Blocker 4 fix: the MISSING check runs FIRST, before the platform check.
  // The caller treats every cause except MISSING as "a marker exists but we
  // refused it" and prints a loud "investigate the marker file for
  // corruption" warning. v2 returned PLATFORM_UNSUPPORTED before ever
  // touching the filesystem, so on macOS/Windows EVERY node of EVERY runtime
  // — none of which have ever had a marker file — printed that warning on
  // `anet node stop`. A no-marker node must be indistinguishable from the
  // pre-P3 baseline on every platform, so absence of the file wins.
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "refuse", cause: "MISSING", detail: `no marker at ${path}` };
    throw err;
  }
  // Finding #7 (audit 92d53c8f): P3 identity teardown depends on /proc/*
  // which only exists on Linux. A marker file DOES exist here (copied dev
  // tree, shared home dir, cross-platform sync) but we cannot act on it —
  // refuse cleanly with a clear cause so the cli falls through to the legacy
  // sweep.
  if (process.platform !== "linux") {
    return {
      kind: "refuse",
      cause: "PLATFORM_UNSUPPORTED",
      detail: `P3 identity teardown requires Linux /proc; platform=${process.platform}; falling through to legacy sweep`,
    };
  }
  if (lstat.isSymbolicLink()) {
    return { kind: "refuse", cause: "SYMLINK", detail: `marker at ${path} is a symlink; refusing to follow` };
  }
  if (!lstat.isFile()) {
    return { kind: "refuse", cause: "NOT_REGULAR", detail: `marker at ${path} is not a regular file (mode=${lstat.mode.toString(8)})` };
  }
  if ((lstat.mode & 0o777) !== 0o600) {
    return { kind: "refuse", cause: "WRONG_MODE", detail: `marker at ${path} has mode ${(lstat.mode & 0o777).toString(8)}, expected 600` };
  }
  const ownUid = process.getuid ? process.getuid()! : -1;
  if (lstat.uid !== ownUid) {
    return { kind: "refuse", cause: "OWNER_MISMATCH", detail: `marker at ${path} owned by uid ${lstat.uid}, we are uid ${ownUid}` };
  }
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "refuse", cause: "MISSING", detail: `marker vanished between lstat and read: ${path}` };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err: any) {
    return { kind: "refuse", cause: "PARSE_ERROR", detail: `marker JSON parse failed: ${err?.message || err}` };
  }
  if (!validateSchema(parsed)) {
    return { kind: "refuse", cause: "SCHEMA_INVALID", detail: `marker schema invalid (body type=${typeof parsed}, isArray=${Array.isArray(parsed)}, isNull=${parsed === null})` };
  }
  const currentBoot = readBootId();
  if (parsed.boot_id !== currentBoot) {
    return { kind: "refuse", cause: "STALE_BOOT_ID", detail: `marker boot_id=${parsed.boot_id} but current=${currentBoot} (host restarted since marker was written)` };
  }
  return { kind: "ok", marker: parsed };
}

export function removeMarker(nodesDir: string, nodeId: string): void {
  try { unlinkSync(markerFilePath(nodesDir, nodeId)); } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
}

// ─── Enumeration (real /proc-based implementation) ───────────────────────

export function realEnumerator(): ProcessEnumerator {
  return {
    listAllPids(): number[] {
      const entries = readdirSync("/proc");
      const pids: number[] = [];
      for (const e of entries) {
        const n = Number(e);
        if (Number.isInteger(n) && n > 0) pids.push(n);
      }
      return pids;
    },
    readEnviron(pid: number): string | null {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8");
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ESRCH") return null;
        // Permission-denied etc — surface it, do NOT silently return null.
        throw err;
      }
    },
    readStat(pid: number): ProcStat | null {
      let raw: string;
      try {
        raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ESRCH") return null;
        throw err;
      }
      // /proc/PID/stat format: pid (comm) state ppid pgrp ...
      // comm can contain spaces or parens; find the LAST ')' to split.
      const lastParen = raw.lastIndexOf(")");
      if (lastParen < 0) throw new Error(`malformed /proc/${pid}/stat: no ')'`);
      const rest = raw.slice(lastParen + 1).trim().split(/\s+/);
      // rest[0] = state, rest[1] = ppid, rest[2] = pgrp, ..., rest[19] = starttime (jiffies since boot)
      // Field indices per proc(5) after we've stripped pid + (comm):
      //   0 state, 1 ppid, 2 pgrp, ..., 19 starttime
      if (rest.length < 20) throw new Error(`malformed /proc/${pid}/stat: only ${rest.length} fields after comm`);
      const ppid = Number(rest[1]);
      const pgrp = Number(rest[2]);
      const starttime = Number(rest[19]);
      if (!Number.isFinite(ppid) || !Number.isFinite(pgrp) || !Number.isFinite(starttime)) {
        throw new Error(`malformed /proc/${pid}/stat: non-numeric fields`);
      }
      return { pgid: pgrp, starttime_jiffies: starttime, ppid };
    },
    readOwnerUid(pid: number): number | null {
      // Read the process's REAL uid from /proc/<pid>/status, NOT the owner
      // of the /proc/<pid>/environ inode. See the interface doc: a
      // non-dumpable process (prctl(PR_SET_DUMPABLE, 0)) keeps real uid
      // 1000 while its environ inode is reported as root:root 0400, so the
      // inode-owner reading silently classified our own children as
      // "somebody else's process".
      //
      // Verified on Linux 6.8 with a uid-1000 child that called
      // prctl(PR_SET_DUMPABLE, 0):
      //   stat /proc/<pid>/environ  -> uid=0 gid=0 mode=400   (misleading)
      //   /proc/<pid>/status Uid:   -> 1000 1000 1000 1000    (correct)
      let raw: string;
      try {
        raw = readFileSync(`/proc/${pid}/status`, "utf8");
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ESRCH") return null;
        // hidepid / LSM blocks even the metadata: we cannot reason about
        // this pid at all, and it cannot be a process we spawned and can
        // still see. Skip rather than throw.
        if (err?.code === "EACCES" || err?.code === "EPERM") return null;
        throw err;
      }
      // `Uid:\t<real>\t<effective>\t<saved>\t<fs>` — field 0 is the real uid.
      const m = raw.match(/^Uid:\s*(\d+)/m);
      if (!m) return null;
      const uid = Number(m[1]);
      return Number.isFinite(uid) ? uid : null;
    },
    readState(pid: number): string | null {
      // /proc/<pid>/stat field-after-comm[0] is state. We already have readStat
      // above but that throws on malformed; here we want a lighter/silent read
      // that returns just the state char (used to detect zombies during environ
      // EACCES discrimination). Prefer /proc/<pid>/status (line-oriented, more
      // stable to parse than the space-packed stat).
      //
      // We combine State + TracerPid into a single call for callers that need
      // both. When TracerPid != 0, the task's mm is locked by the tracer and
      // readEnviron will EACCES even for the owner — treat that as an
      // expected "mm-locked" state (returned as "t" per convention).
      let raw: string;
      try {
        raw = readFileSync(`/proc/${pid}/status`, "utf8");
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ESRCH") return null;
        throw err;
      }
      const tracerMatch = raw.match(/^TracerPid:\s*(\d+)/m);
      if (tracerMatch && Number(tracerMatch[1]) > 0) {
        return "t"; // ptrace-stopped: mm-locked, environ unreadable, expected
      }
      // Line format: `State:\tZ (zombie)` — take the first non-whitespace char
      // after `State:`.
      const m = raw.match(/^State:\s*(\S)/m);
      return m ? m[1] : null;
    },
  };
}

export function realKiller(): KillPrimitive {
  return {
    killPgroup(pgid: number, signal: "TERM" | "KILL"): void {
      // Finding #2 (audit 92d53c8f): kill(-0) targets the CALLER's own
      // process group — kernel threads have pgrp=0. Any code path that
      // arrived here with pgid<=0 has a bug upstream; refuse to signal.
      if (pgid <= 0) {
        throw new Error(`killPgroup refused: pgid must be > 0 (got ${pgid}); kill(-0) or kill(-negative) would target caller's own pgroup`);
      }
      // Negative pid → group signal. process.kill accepts string signal.
      process.kill(-pgid, signal === "TERM" ? "SIGTERM" : "SIGKILL");
    },
    pgroupAlive(pgid: number): boolean {
      if (pgid <= 0) {
        throw new Error(`pgroupAlive refused: pgid must be > 0 (got ${pgid})`);
      }
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (err: any) {
        if (err?.code === "ESRCH") return false;
        if (err?.code === "EPERM") return true; // exists but not ours; treat as alive
        throw err;
      }
    },
  };
}

// ─── Environ scan (identity truth) ───────────────────────────────────────

/**
 * Scan /proc for all pids whose environ contains ANET_NODE_MARKER=<uuid>.
 * This is the authoritative identity source — NOT the marker file's stored
 * pids, which may be stale (main died, workers survived under new pgids).
 *
 * Bytes format of /proc/PID/environ: NUL-separated key=value pairs.
 *
 * Blocker 1 fix (independent audit 92d53c8f, 2026-07-29): /proc/<pid>/environ
 * is 0400 owner-only. Blindly reading it will hit EACCES on every other-user
 * process (pid 1 is systemd/root → guaranteed EACCES). The naive fix — wrap
 * in try/catch and continue — would silently miss marker-carrying processes
 * whose environ we can't read for some other reason, recreating Defect A
 * ("nothing killed but report success"). Right fix:
 *
 *   1. Try readEnviron.
 *   2. On EACCES, discriminate via readOwnerUid + readState:
 *      - Owner uid != ours     → EXPECTED skip (can't be one of our procs).
 *      - Own uid, state = Z    → EXPECTED skip (zombie, mm freed).
 *      - Own uid, not zombie   → FAIL-CLOSED (unexplained EACCES on our own
 *                                live process is a real problem, must throw).
 */
export interface ScanResult {
  /** Pids whose environ we successfully read and matched the marker uuid. */
  hits: number[];
  /**
   * Own-uid, live, environ-unreadable pids that are PLAUSIBLY PART OF THE
   * COPRESENCE TREE (invariant 11 scope test). These might be marker-
   * carrying without us being able to prove it, so the reap flow REFUSES
   * marker removal while this list is non-empty — defense against Defect A
   * (silently missing a marker-carrying process, then deleting the marker
   * as if teardown had succeeded).
   */
  unreadableOwnUid: number[];
  /**
   * Own-uid, live, environ-unreadable pids that failed the scope test:
   * their pgid belongs to no marker-carrying group and their ppid chain
   * reaches no marker carrier / validated marker-file session pid.
   *
   * INFORMATIONAL ONLY — never fail-closed. A machine routinely has such
   * processes (a same-uid process whose primary GID differs from ours fails
   * the kernel's __ptrace_may_access gid check and EACCESes on environ even
   * though its real uid matches). v2 lumped these into unreadableOwnUid,
   * which made reapMarkerGroups structurally unable to return success on
   * any such host.
   *
   * KNOWN RESIDUAL GAP (stated rather than papered over): a marker-carrying
   * process that is BOTH non-dumpable (environ unreadable) AND fully
   * detached (setsid'd into its own pgroup with ppid=1, no live recorded
   * session pid above it) lands here and is therefore not reaped and does
   * not block marker removal. Nothing in /proc exposes the environment of a
   * non-dumpable task to a non-root reader, so no scope widening can
   * recover it — only running teardown as root could. Widening scope to
   * "every same-uid unreadable process" is NOT an acceptable trade: that is
   * exactly the v2 behaviour that made teardown never succeed. The
   * realistic copresence shape (child of a recorded pane pid, or sharing a
   * marker carrier's pgroup) IS covered — see the real-/proc test.
   */
  unreadableOutOfScope: number[];
}

/**
 * Marker-file session records used to anchor the invariant-11 scope test.
 * Each entry must be re-validated (pid alive AND same starttime) before it
 * is trusted — see validateAnchors.
 */
export interface ScanAnchors {
  sessions?: Array<{ pid: number; starttime_jiffies: number }>;
}

export function anchorsFromMarker(marker: CopresenceMarker): ScanAnchors {
  const sessions: Array<{ pid: number; starttime_jiffies: number }> = [];
  for (const key of ["appsrv", "bridge", "tui"] as const) {
    const s = marker.sessions?.[key];
    if (!s) continue;
    if (!Number.isInteger(s.pid) || s.pid <= 0) continue;
    sessions.push({ pid: s.pid, starttime_jiffies: s.starttime_jiffies });
  }
  return { sessions };
}

/**
 * Invariant 5 in force: a recorded session pid may anchor the scope test
 * only if the pid is still alive AND its /proc/PID/stat starttime matches
 * what was recorded when the marker was written. A recycled pid has a
 * different starttime and is dropped, so a stale marker can never widen the
 * scope onto an unrelated process that happens to have inherited the pid.
 */
function validateAnchors(
  enumer: ProcessEnumerator,
  anchors: ScanAnchors | undefined,
): { pids: Set<number>; pgids: Set<number> } {
  const pids = new Set<number>();
  const pgids = new Set<number>();
  for (const s of anchors?.sessions || []) {
    let stat: ProcStat | null;
    try { stat = enumer.readStat(s.pid); } catch { continue; }
    if (stat == null) continue; // recorded pid is gone
    if (stat.starttime_jiffies !== s.starttime_jiffies) continue; // pid recycled
    pids.add(s.pid);
    if (stat.pgid > 0) pgids.add(stat.pgid);
  }
  return { pids, pgids };
}

const SCOPE_ANCESTRY_MAX_DEPTH = 64;

/**
 * Invariant 11 scope test: is `pid` plausibly part of the copresence tree?
 *
 * True when the pid IS an anchor, when its pgid belongs to a marker-carrying
 * group (or a validated anchor's group), or when walking its ppid chain
 * reaches an anchor / marker carrier / a pid inside a relevant pgroup.
 *
 * Everything else is out of scope and must not participate in a fail-closed
 * decision, no matter how unreadable it is.
 */
export function isInCopresenceScope(
  enumer: ProcessEnumerator,
  pid: number,
  relevantPids: Set<number>,
  relevantPgids: Set<number>,
): boolean {
  if (relevantPids.has(pid)) return true;
  let stat: ProcStat | null;
  try { stat = enumer.readStat(pid); } catch { return false; }
  if (stat == null) return false;
  if (relevantPgids.has(stat.pgid)) return true;
  let cur = stat.ppid;
  const seen = new Set<number>([pid]);
  for (let depth = 0; depth < SCOPE_ANCESTRY_MAX_DEPTH; depth++) {
    if (cur <= 1 || seen.has(cur)) break;
    seen.add(cur);
    if (relevantPids.has(cur)) return true;
    let up: ProcStat | null;
    try { up = enumer.readStat(cur); } catch { break; }
    if (up == null) break;
    if (relevantPgids.has(up.pgid)) return true;
    cur = up.ppid;
  }
  return false;
}

export function scanEnvironForMarker(enumer: ProcessEnumerator, markerUuid: string): number[] {
  return scanEnvironForMarkerFull(enumer, markerUuid).hits;
}

export function scanEnvironForMarkerFull(
  enumer: ProcessEnumerator,
  markerUuid: string,
  anchors?: ScanAnchors,
): ScanResult {
  if (typeof markerUuid !== "string" || markerUuid.length === 0) {
    throw new Error("scanEnvironForMarker: markerUuid must be a non-empty string");
  }
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
  const ownUid = process.getuid ? process.getuid()! : -1;
  const pids = enumer.listAllPids();
  const hits: number[] = [];
  // Own-uid, live pids whose environ we could not read. Scope is applied in
  // a SECOND pass, because the scope anchors include the hit set itself and
  // that is not known until the first pass finishes.
  const unreadableCandidates: number[] = [];
  for (const pid of pids) {
    let env: string | null;
    try {
      env = enumer.readEnviron(pid);
    } catch (err: any) {
      // Real /proc has many pids where readEnviron EACCESes:
      //   - other users' processes (uid mismatch)
      //   - same uid but different primary gid (kernel __ptrace_may_access
      //     checks BOTH uid and gid — e.g. a process whose primary group is
      //     `docker` while ours is our own login group)
      //   - non-dumpable processes (prctl(PR_SET_DUMPABLE, 0))
      //   - ptrace-stopped, zombie, execve-transitioning
      //
      // Discrimination:
      //   - Non-EACCES error   → throw (real problem, not a permission thing)
      //   - real uid != ours   → skip (cannot be one of our processes)
      //   - state not R/S/D    → skip (zombie / mm-locked / dying)
      //   - otherwise          → candidate; the scope test below decides
      //     whether it is fail-closed material or informational noise.
      if (err?.code !== "EACCES") throw err;
      let procUid: number | null;
      try { procUid = enumer.readOwnerUid(pid); } catch { continue; }
      if (procUid == null) continue;
      if (procUid !== ownUid) continue;
      let state: string | null;
      try { state = enumer.readState(pid); } catch { continue; }
      if (state == null) continue;
      if (state !== "R" && state !== "S" && state !== "D") continue;
      unreadableCandidates.push(pid);
      continue;
    }
    if (env == null) continue; // pid raced away, normal
    const parts = env.split("\0");
    if (parts.indexOf(needle) >= 0) hits.push(pid);
  }

  // Second pass — invariant 11. Anchors are (a) validated marker-file
  // session pids and their live pgroups, plus (b) every marker carrier we
  // just found and its pgroup.
  const validated = validateAnchors(enumer, anchors);
  const relevantPids = new Set<number>(validated.pids);
  const relevantPgids = new Set<number>(validated.pgids);
  for (const hit of hits) {
    relevantPids.add(hit);
    let stat: ProcStat | null;
    try { stat = enumer.readStat(hit); } catch { continue; }
    if (stat != null && stat.pgid > 0) relevantPgids.add(stat.pgid);
  }
  const unreadableOwnUid: number[] = [];
  const unreadableOutOfScope: number[] = [];
  for (const pid of unreadableCandidates) {
    if (isInCopresenceScope(enumer, pid, relevantPids, relevantPgids)) unreadableOwnUid.push(pid);
    else unreadableOutOfScope.push(pid);
  }
  return { hits, unreadableOwnUid, unreadableOutOfScope };
}

export function groupPidsByPgid(enumer: ProcessEnumerator, pids: number[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const pid of pids) {
    const stat = enumer.readStat(pid);
    if (stat == null) continue; // pid gone
    const arr = groups.get(stat.pgid) || [];
    arr.push(pid);
    groups.set(stat.pgid, arr);
  }
  return groups;
}

// ─── Group homogeneity (fail-closed) ─────────────────────────────────────

export type HomogeneityResult =
  | { ok: true; members: number[] }
  | { ok: false; cause: "FOREIGN_MEMBER" | "ENUM_ERROR" | "EMPTY_GROUP"; foreignPids: number[]; unreadablePids: number[]; detail: string };

/**
 * Verify that EVERY live member of `pgid` carries the marker.
 *
 * Blocker 2 fix: enumeration errors surface as ENUM_ERROR (fail-closed),
 * never as an empty-list judged "safe". Any unreadable member also
 * fails-closed. Empty group (no live members at all) also refuses — killing
 * an empty pgroup can't be right and empty-list judged "ok" recreates the
 * exact defect shape (independent audit 92d53c8f finding #6).
 *
 * Blocker 2 second half (zombie): a zombie same-uid process's environ
 * returns EACCES even to owner (mm freed), but stat still exists with
 * original pgid. Without discrimination, the zombie would be treated as
 * "unreadable member" → ENUM_ERROR → entire group SKIPPED. Since re-verify
 * happens post-SIGTERM (when zombies are most numerous), teardown would
 * never escalate. Fix: apply the same owner-uid + state=Z discriminator as
 * scanEnvironForMarker.
 *
 * Algorithm:
 *   1. Enumerate all pids on the system.
 *   2. Filter to pids whose /proc/PID/stat pgid == target pgid.
 *   3. For each such pid, check its environ with EACCES discrimination:
 *      - Other-user EACCES  → skip (can't be ours anyway).
 *      - Own-uid zombie     → skip (expected, dying).
 *      - Own-uid live EACCES → truly unreadable → fail-closed.
 *      - Missing marker     → foreign member → fail-closed.
 */
export function verifyGroupHomogeneity(
  enumer: ProcessEnumerator,
  pgid: number,
  markerUuid: string,
): HomogeneityResult {
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
  const ownUid = process.getuid ? process.getuid()! : -1;
  let allPids: number[];
  try {
    allPids = enumer.listAllPids();
  } catch (err: any) {
    return { ok: false, cause: "ENUM_ERROR", foreignPids: [], unreadablePids: [], detail: `listAllPids failed: ${err?.message || err}` };
  }
  const groupMembers: number[] = [];
  const unreadable: number[] = [];
  for (const pid of allPids) {
    let stat: ProcStat | null;
    try {
      stat = enumer.readStat(pid);
    } catch (err: any) {
      // Blocker 3 fix (invariant 11 at the group level). v2 pushed EVERY
      // stat-unreadable pid onto the global `unreadable` list BEFORE the
      // pgid filter, so one unrelated process anywhere on the machine whose
      // /proc/PID/stat could not be read (hidepid, LSM, container policy,
      // exotic namespace) turned EVERY group into ENUM_ERROR and nothing was
      // ever killed. Machine-wide coupling, same defect family as the
      // machine-wide unreadable scan list.
      //
      // We cannot apply the pgid filter to a pid whose stat we could not
      // read — the pgid is exactly what we failed to learn. So we bound the
      // fail-closed signal by ownership instead: /proc/PID/stat is 0444 on
      // Linux, so a read failure means a policy layer is hiding that task
      // from us entirely. If we cannot even establish its real uid
      // (readOwnerUid → null, i.e. /proc/PID/status is hidden too), or the
      // uid is not ours, the task lives outside our reach and provably
      // cannot be a member of a pgroup we created — informational skip.
      // Only an OWN-uid task we somehow cannot stat is genuinely alarming,
      // and that keeps the fail-closed trigger inside our own uid.
      let procUid: number | null;
      try { procUid = enumer.readOwnerUid(pid); } catch { continue; }
      if (procUid == null) continue;
      if (procUid !== ownUid) continue;
      unreadable.push(pid);
      continue;
    }
    if (stat == null) continue; // process gone, normal race
    if (stat.pgid !== pgid) continue;
    groupMembers.push(pid);
  }
  const foreign: number[] = [];
  const liveMembers: number[] = [];
  for (const pid of groupMembers) {
    let env: string | null;
    try {
      env = enumer.readEnviron(pid);
    } catch (err: any) {
      if (err?.code === "EACCES") {
        // Discriminator (see scanEnvironForMarker for full rationale). At
        // the group level, we're stricter than at scan level: if a member's
        // environ is unreadable AND we can't rule out its ownership OR its
        // dumpable=0 state, we mark it unreadable and let the group refuse
        // ENUM_ERROR. Marker-carrying-member-not-verifiable → don't kill.
        let envOwnerUid: number | null;
        try { envOwnerUid = enumer.readOwnerUid(pid); } catch { continue; }
        if (envOwnerUid == null) continue;
        if (envOwnerUid !== ownUid) continue;
        let state: string | null;
        try { state = enumer.readState(pid); } catch { continue; }
        if (state == null) continue;
        if (state !== "R" && state !== "S" && state !== "D") continue;
        unreadable.push(pid);
        continue;
      }
      unreadable.push(pid);
      continue;
    }
    if (env == null) continue; // pid gone between stat and environ, normal race
    liveMembers.push(pid);
    const parts = env.split("\0");
    if (parts.indexOf(needle) < 0) foreign.push(pid);
  }
  if (unreadable.length > 0) {
    return { ok: false, cause: "ENUM_ERROR", foreignPids: foreign, unreadablePids: unreadable, detail: `${unreadable.length} member(s) unreadable — cannot prove homogeneity` };
  }
  if (foreign.length > 0) {
    return { ok: false, cause: "FOREIGN_MEMBER", foreignPids: foreign, unreadablePids: [], detail: `${foreign.length} member(s) do not carry the marker` };
  }
  if (liveMembers.length === 0) {
    // Finding #6 (audit 92d53c8f): empty-group judged ok:true is defect
    // shape B. If nothing was found in the pgid, don't signal (empty
    // pgroup = pgroup dissolved; kill(-pgid) would be a no-op at best and
    // potentially catch a stray pgid re-assigned to something else).
    return { ok: false, cause: "EMPTY_GROUP", foreignPids: [], unreadablePids: [], detail: `pgid=${pgid} has no live marker-carrying members` };
  }
  return { ok: true, members: liveMembers };
}

// ─── Self-context check ─────────────────────────────────────────────────

/**
 * Walk the caller's ancestry (self → PPID → grandparent → ...) and check
 * whether any ancestor carries the target marker. If yes → caller is
 * running inside the copresence tree we're about to kill, and would take
 * itself down.
 */
export function callerCarriesMarker(enumer: ProcessEnumerator, markerUuid: string): { self: boolean; ancestorPid?: number } {
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
  let pid = process.pid;
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    let env: string | null;
    try {
      env = enumer.readEnviron(pid);
    } catch {
      env = null;
    }
    if (env != null) {
      const parts = env.split("\0");
      if (parts.indexOf(needle) >= 0) {
        return { self: pid === process.pid, ancestorPid: pid };
      }
    }
    let stat: ProcStat | null;
    try {
      stat = enumer.readStat(pid);
    } catch {
      break;
    }
    if (stat == null) break;
    if (stat.ppid === pid) break; // safety
    pid = stat.ppid;
  }
  return { self: false };
}

// ─── Reap orchestration ─────────────────────────────────────────────────
// (sessionStillFresh removed 2026-07-29 per audit 92d53c8f finding #1 — it
// had zero production call sites and gave Test 6 false coverage. PID-reuse
// defense in practice comes from the boot_id check inside readMarker plus
// the environ-scan-is-truth rule that ignores the marker file's stored pids
// entirely at reap time. If a future need re-introduces per-session stale-
// pid detection, wire it into reapMarkerGroups before adding tests.)

export type ReapResult =
  | { kind: "success"; killedPgids: number[]; residualPids: number[]; unreadableOwnUid?: number[] }
  | { kind: "failed"; killedPgids: number[]; residualPids: number[]; skippedGroups: Array<{ pgid: number; reason: string }>; detail: string; unreadableOwnUid?: number[] };

export interface ReapOptions {
  graceMs: number;
  logger: (msg: string) => void;
  /**
   * Sleep primitive (grace period). Real code uses setTimeout; tests inject
   * a fast/deterministic sleep so grace paths are actually covered. Prior
   * impl was a busy-wait `while (Date.now() < end) {}` — audit 92d53c8f
   * finding #3 flagged that as pinning one CPU core for graceMs and blocking
   * the event loop; test coverage missed it because tests passed graceMs=0.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Invariant-11 scope anchors, normally `anchorsFromMarker(marker)`.
   *
   * Without them the only anchors are the marker carriers the scan itself
   * found, so a marker-carrying process we cannot READ (non-dumpable) but
   * whose parent IS a recorded session pid would be judged out of scope and
   * silently dropped. Passing the marker's recorded session pids closes that
   * hole; each one is re-validated (alive + same starttime) before it can
   * widen scope, so a stale/recycled pid cannot.
   */
  anchors?: ScanAnchors;
}

/**
 * Full reap flow with TOCTOU re-verification.
 *
 * Sequence:
 *   1. Environ scan for marker → get all live pids carrying it.
 *   2. Group by current PGID.
 *   3. For each group: verify homogeneity. Skip on foreign/unreadable.
 *   4. For each verified group: send SIGTERM to pgroup.
 *   5. Wait grace.
 *   6. Re-verify each group (marker still there, no new foreign) before SIGKILL.
 *   7. Send SIGKILL to any group still alive.
 *   8. Post-rescan: if any marker-carrying pid alive → preserve marker.
 */
export async function reapMarkerGroups(
  enumer: ProcessEnumerator,
  killer: KillPrimitive,
  markerUuid: string,
  opts: ReapOptions,
): Promise<ReapResult> {
  const skippedGroups: Array<{ pgid: number; reason: string }> = [];
  const killedPgids: number[] = [];

  // Step 1-2: discover + group. Use ..Full form so we can retain the list
  // of pids we had to SKIP due to EACCES on own-uid running processes.
  // Those unreadable pids might have been marker-carrying; treating hits=0
  // as "success + delete marker" when the unreadable list is non-empty
  // recreates Defect A. Instead we return kind:"failed" and preserve the
  // marker for retry.
  const scan = scanEnvironForMarkerFull(enumer, markerUuid, opts.anchors);
  const pids = scan.hits;
  opts.logger(`[identity] environ scan found ${pids.length} marker-carrying pid(s), ${scan.unreadableOwnUid.length} in-scope unreadable, ${scan.unreadableOutOfScope.length} out-of-scope unreadable (informational)`);
  if (pids.length === 0 && scan.unreadableOwnUid.length === 0) {
    return { kind: "success", killedPgids: [], residualPids: [] };
  }
  if (pids.length === 0 && scan.unreadableOwnUid.length > 0) {
    return {
      kind: "failed",
      killedPgids: [],
      residualPids: [],
      skippedGroups: [],
      detail: `no marker-carrying pids found, but ${scan.unreadableOwnUid.length} own-uid running process(es) had unreadable environ — cannot prove marker-bearing processes don't exist; preserve marker for retry`,
      unreadableOwnUid: scan.unreadableOwnUid,
    };
  }
  const groups = groupPidsByPgid(enumer, pids);
  opts.logger(`[identity] grouped into ${groups.size} pgroup(s): ${[...groups.keys()].join(",")}`);

  // Step 3-4: verify + SIGTERM per verified group
  const verifiedGroups: number[] = [];
  for (const pgid of groups.keys()) {
    const check = verifyGroupHomogeneity(enumer, pgid, markerUuid);
    if (!check.ok) {
      const reason = `${check.cause}: ${check.detail} (foreign=[${check.foreignPids.join(",")}] unreadable=[${check.unreadablePids.join(",")}])`;
      skippedGroups.push({ pgid, reason });
      opts.logger(`[identity] SKIP pgid=${pgid} — ${reason}`);
      continue;
    }
    verifiedGroups.push(pgid);
    opts.logger(`[identity] verified pgid=${pgid} members=${check.members.join(",")}; sending SIGTERM`);
    try { killer.killPgroup(pgid, "TERM"); } catch (err: any) {
      opts.logger(`[identity] SIGTERM pgid=${pgid} failed: ${err?.message || err}`);
    }
  }

  if (verifiedGroups.length === 0) {
    return {
      kind: "failed",
      killedPgids: [],
      residualPids: pids,
      skippedGroups,
      detail: "no groups passed homogeneity — nothing killed",
    };
  }

  // Step 5: grace — real setTimeout, NOT busy-wait (finding #3).
  const sleep = opts.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(opts.graceMs);

  // Step 6-7: re-verify then SIGKILL as needed
  for (const pgid of verifiedGroups) {
    if (!killer.pgroupAlive(pgid)) {
      killedPgids.push(pgid);
      opts.logger(`[identity] pgid=${pgid} exited after SIGTERM`);
      continue;
    }
    // TOCTOU re-verify before escalating
    const recheck = verifyGroupHomogeneity(enumer, pgid, markerUuid);
    if (!recheck.ok) {
      const reason = `re-verify after grace: ${recheck.cause}: ${recheck.detail}`;
      skippedGroups.push({ pgid, reason });
      opts.logger(`[identity] SKIP escalation pgid=${pgid} — ${reason}`);
      continue;
    }
    opts.logger(`[identity] pgid=${pgid} still alive after grace; sending SIGKILL`);
    try { killer.killPgroup(pgid, "KILL"); killedPgids.push(pgid); } catch (err: any) {
      opts.logger(`[identity] SIGKILL pgid=${pgid} failed: ${err?.message || err}`);
    }
  }

  // Step 8: post-rescan
  const rescan = scanEnvironForMarkerFull(enumer, markerUuid, opts.anchors);
  const residual = rescan.hits;
  if (residual.length > 0 || rescan.unreadableOwnUid.length > 0) {
    return {
      kind: "failed",
      killedPgids,
      residualPids: residual,
      skippedGroups,
      detail: residual.length > 0
        ? `${residual.length} marker-carrying pid(s) still alive after grace+KILL`
        : `no marker-carrying residual but ${rescan.unreadableOwnUid.length} own-uid unreadable — preserve marker for retry`,
      unreadableOwnUid: rescan.unreadableOwnUid.length > 0 ? rescan.unreadableOwnUid : undefined,
    };
  }
  return { kind: "success", killedPgids, residualPids: [] };
}

// ─── Start-side identity preparation (blockers 5 + 6) ────────────────────

export interface PrepareStartDeps {
  /** Usually () => readMarker(nodesDir, nodeId). */
  readMarker(): ReadMarkerResult;
  /** Usually (uuid, anchors) => reapMarkerGroups(realEnumerator(), realKiller(), uuid, {...anchors}). */
  reap(uuid: string, anchors: ScanAnchors): Promise<ReapResult>;
  /** Usually () => removeMarker(nodesDir, nodeId). */
  removeMarker(): void;
  /** Usually (uuid, sessions) => writeMarker(nodesDir, nodeId, uuid, sessions). */
  writeMarker(uuid: string, sessions: CopresenceMarker["sessions"]): void;
  logger(msg: string): void;
}

export type PrepareStartResult =
  | { kind: "ok"; reclaimedUuid?: string }
  | { kind: "blocked"; cause: "STALE_TREE_ALIVE" | "UNUSABLE_MARKER"; detail: string; remedy: string };

/**
 * Everything that must happen BEFORE the first `tmux new-session` of a
 * copresence start. Extracted out of cli.ts so both blockers below are
 * actually reachable by tests — the audit's point that the two fatal
 * defects of the previous rounds both lived in an untested cli.ts seam.
 *
 * Blocker 5 — marker-before-tmux ordering.
 *   v2 wrote the marker only after the app-server had bound its port, i.e.
 *   after a 25s wait and after several `process.exit(1)` paths. A start that
 *   died in that window left a live, marker-carrying tmux session behind
 *   with NO marker file on disk: the exact unreclaimable-ghost this feature
 *   exists to prevent. The marker is now written here, before any session is
 *   created, with an empty `sessions` object — reap identity has always been
 *   the environ uuid, never the recorded pids, so an empty sessions object
 *   loses nothing but observability hints (which the start path fills in
 *   later, best-effort).
 *
 * Blocker 6 — never overwrite a preserved marker.
 *   A failed stop deliberately PRESERVES the marker so the next stop can
 *   retry idempotently. v2's start then overwrote it with a fresh uuid while
 *   only killing tmux sessions BY NAME, so the still-running subprocesses of
 *   the previous instance became permanently unreclaimable: their uuid was
 *   gone from disk forever. Now the old identity is reaped FIRST; if that
 *   reap does not fully succeed we refuse to start rather than destroy the
 *   only handle on those processes.
 */
export async function prepareIdentityForStart(
  newUuid: string,
  deps: PrepareStartDeps,
): Promise<PrepareStartResult> {
  if (typeof newUuid !== "string" || newUuid.length === 0) {
    throw new Error("prepareIdentityForStart: newUuid must be a non-empty string");
  }
  const existing = deps.readMarker();
  let reclaimedUuid: string | undefined;

  if (existing.kind === "ok") {
    const oldUuid = existing.marker.marker;
    if (oldUuid === newUuid) {
      // Caller reused a uuid — that can only be a bug (randomUUID collision
      // is not a thing). Refuse rather than conflate two generations.
      return {
        kind: "blocked",
        cause: "UNUSABLE_MARKER",
        detail: `refusing to start: the new identity uuid equals the existing marker's uuid`,
        remedy: `This is an internal error — the start path must generate a fresh uuid per start.`,
      };
    }
    deps.logger(`existing identity marker found (uuid=${oldUuid.slice(0, 8)}…) — reclaiming its processes before starting a new generation`);
    const result = await deps.reap(oldUuid, anchorsFromMarker(existing.marker));
    if (result.kind !== "success") {
      return {
        kind: "blocked",
        cause: "STALE_TREE_ALIVE",
        detail: `previous copresence generation (uuid=${oldUuid.slice(0, 8)}…) could not be fully reclaimed: ${result.detail}`,
        remedy: `Run \`anet node stop\` for this node again (the marker is preserved, retry is idempotent). Overwriting the marker now would lose the only handle on ${result.residualPids.length} surviving process(es) forever.`,
      };
    }
    deps.removeMarker();
    reclaimedUuid = oldUuid;
    deps.logger(`previous generation reclaimed (${result.killedPgids.length} pgroup(s) killed)`);
  } else if (existing.cause === "STALE_BOOT_ID") {
    // The host rebooted since the marker was written, so every process it
    // could possibly refer to is gone by definition. Safe to discard.
    deps.logger(`stale marker from a previous boot discarded (${existing.detail})`);
    deps.removeMarker();
  } else if (existing.cause !== "MISSING") {
    // SYMLINK / NOT_REGULAR / WRONG_MODE / OWNER_MISMATCH / PARSE_ERROR /
    // SCHEMA_INVALID / PLATFORM_UNSUPPORTED. In every one of these we cannot
    // learn the previous uuid, so we cannot reclaim the previous generation.
    // Overwriting would be exactly the blocker-6 data loss, and for the
    // security-shaped causes (symlink / foreign owner / wrong mode) writing
    // through would also mean writing into something an attacker planted.
    return {
      kind: "blocked",
      cause: "UNUSABLE_MARKER",
      detail: `an identity marker exists but cannot be read (${existing.cause}): ${existing.detail}`,
      remedy: `Inspect the marker file. If no copresence processes from a previous run survive, delete it and start again.`,
    };
  }

  // Blocker 5: marker on disk BEFORE any marker-carrying session exists.
  // `sessions` is intentionally empty — observability hints get filled in
  // later, best-effort; identity is the uuid alone.
  deps.writeMarker(newUuid, {});
  return { kind: "ok", reclaimedUuid };
}
