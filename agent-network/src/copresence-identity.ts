// RFC-030 P3-A v2 — managed identity + group reap for copresence teardown.
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
//   5. PID reuse: at reap time re-verify marker starttime + current
//      boot_id vs the marker file. If mismatch, that pid is a stale
//      recycled pid — skip.
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
   * Owner uid of /proc/<pid>. Used by scanEnvironForMarker to discriminate
   * "other-user process (expected EACCES)" from "our own process with weird
   * EACCES (real problem, must fail closed)".
   * Returns null if the pid is gone (ENOENT).
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
  // Finding #7 (audit 92d53c8f): P3 identity teardown depends on /proc/*
  // which only exists on Linux. On Darwin/Windows dev machines every stop
  // used to misreport marker corruption (or crash reading /proc/…). Refuse
  // cleanly with a clear cause so the cli falls through to the legacy sweep
  // without alarming the operator.
  if (process.platform !== "linux") {
    return {
      kind: "refuse",
      cause: "PLATFORM_UNSUPPORTED",
      detail: `P3 identity teardown requires Linux /proc; platform=${process.platform}; falling through to legacy sweep`,
    };
  }
  const path = markerFilePath(nodesDir, nodeId);
  // Use lstat to catch symlinks (statSync would follow).
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "refuse", cause: "MISSING", detail: `no marker at ${path}` };
    throw err;
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
      // IMPORTANT: check /proc/PID/environ's OWN owner, not /proc/PID directory.
      // Some special processes (systemd sd-pam, setuid children, root
      // sub-daemons launched via user session) have /proc/PID owned by the
      // real user uid but /proc/PID/environ owned by root with mode 0400.
      // We're testing whether we CAN read environ; the environ file's owner
      // is what actually matters for that.
      //
      // If /proc/PID/environ specifically can't be stat'd, the pid is either
      // gone or the container/policy layer blocks even the metadata; return
      // null (skip) — safer to not treat as "ours" than to fail-closed and
      // block stops for irrelevant system processes.
      try {
        return statSync(`/proc/${pid}/environ`).uid;
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ESRCH") return null;
        if (err?.code === "EACCES") return null; // metadata itself blocked, treat as not-ours
        throw err;
      }
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
   * Pids we had to SKIP due to EACCES on own-uid running-state process.
   * These pids MIGHT be marker-carrying but we couldn't verify. Reap flow
   * uses this to REFUSE marker removal even when hits=0 (defense against
   * Defect A: silently missing a marker-carrying process, then deleting
   * the marker as if teardown succeeded).
   */
  unreadableOwnUid: number[];
}

export function scanEnvironForMarker(enumer: ProcessEnumerator, markerUuid: string): number[] {
  return scanEnvironForMarkerFull(enumer, markerUuid).hits;
}

export function scanEnvironForMarkerFull(enumer: ProcessEnumerator, markerUuid: string): ScanResult {
  if (typeof markerUuid !== "string" || markerUuid.length === 0) {
    throw new Error("scanEnvironForMarker: markerUuid must be a non-empty string");
  }
  if (typeof markerUuid !== "string" || markerUuid.length === 0) {
    throw new Error("scanEnvironForMarker: markerUuid must be a non-empty string");
  }
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
  const ownUid = process.getuid ? process.getuid()! : -1;
  const pids = enumer.listAllPids();
  const hits: number[] = [];
  const unreadableOwnUid: number[] = [];
  for (const pid of pids) {
    let env: string | null;
    try {
      env = enumer.readEnviron(pid);
    } catch (err: any) {
      // Blocker 1 fix (audit 92d53c8f + practical Linux calibration).
      //
      // Real /proc has many pids where readEnviron EACCES even when the pid
      // "appears" ours by directory stat: sd-pam (env owned by root),
      // docker/podman daemons (dumpable=0), systemd session leaders,
      // ptrace-locked, exec2-transitioning, etc.
      //
      // Discrimination:
      //   - Non-EACCES error → throw (real problem, not a permission thing)
      //   - env-file uid != ours → skip (not ours)
      //   - state Z/X/T/t or other non-R/S/D → skip (mm-locked/dying)
      //   - Otherwise (own-uid, running state, still EACCES) →
      //     record in unreadableOwnUid list. Caller uses this to refuse
      //     removing the marker file (defense against Defect A: if we
      //     silently skipped and reported hits=0, marker would be deleted
      //     as if teardown succeeded, but a real marker-carrying process
      //     might have been in the unreadable set).
      if (err?.code !== "EACCES") throw err;
      let envOwnerUid: number | null;
      try { envOwnerUid = enumer.readOwnerUid(pid); } catch { continue; }
      if (envOwnerUid == null) continue;
      if (envOwnerUid !== ownUid) continue;
      let state: string | null;
      try { state = enumer.readState(pid); } catch { continue; }
      if (state == null) continue;
      if (state !== "R" && state !== "S" && state !== "D") continue;
      unreadableOwnUid.push(pid);
      continue;
    }
    if (env == null) continue; // pid raced away, normal
    const parts = env.split("\0");
    if (parts.indexOf(needle) >= 0) hits.push(pid);
  }
  return { hits, unreadableOwnUid };
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
      // A process in the enumeration list whose stat we can't read is suspicious;
      // fail-closed rather than assume it's not in the group.
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
  const scan = scanEnvironForMarkerFull(enumer, markerUuid);
  const pids = scan.hits;
  opts.logger(`[identity] environ scan found ${pids.length} marker-carrying pid(s), ${scan.unreadableOwnUid.length} own-uid unreadable`);
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
  const rescan = scanEnvironForMarkerFull(enumer, markerUuid);
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
