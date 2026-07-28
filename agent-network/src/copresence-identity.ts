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
  sessions: {
    appsrv: SessionInfo;
    bridge: SessionInfo;
    tui: SessionInfo;
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
  | "STALE_BOOT_ID";

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
  };
}

export function realKiller(): KillPrimitive {
  return {
    killPgroup(pgid: number, signal: "TERM" | "KILL"): void {
      // Negative pid → group signal. process.kill accepts string signal.
      process.kill(-pgid, signal === "TERM" ? "SIGTERM" : "SIGKILL");
    },
    pgroupAlive(pgid: number): boolean {
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
 */
export function scanEnvironForMarker(enumer: ProcessEnumerator, markerUuid: string): number[] {
  if (typeof markerUuid !== "string" || markerUuid.length === 0) {
    throw new Error("scanEnvironForMarker: markerUuid must be a non-empty string");
  }
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
  const pids = enumer.listAllPids();
  const hits: number[] = [];
  for (const pid of pids) {
    const env = enumer.readEnviron(pid);
    if (env == null) continue; // pid raced away, normal
    const parts = env.split("\0");
    if (parts.indexOf(needle) >= 0) hits.push(pid);
  }
  return hits;
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
  | { ok: false; cause: "FOREIGN_MEMBER" | "ENUM_ERROR"; foreignPids: number[]; unreadablePids: number[]; detail: string };

/**
 * Verify that EVERY live member of `pgid` carries the marker.
 *
 * Blocker 2 fix: enumeration errors surface as ENUM_ERROR (fail-closed),
 * never as an empty-list judged "safe". Any unreadable member also
 * fails-closed.
 *
 * Algorithm:
 *   1. Enumerate all pids on the system.
 *   2. Filter to pids whose /proc/PID/stat pgid == target pgid.
 *   3. For each such pid, check its environ. If pid can't be read → fail-closed.
 *      If pid lacks marker → foreign member → fail-closed.
 */
export function verifyGroupHomogeneity(
  enumer: ProcessEnumerator,
  pgid: number,
  markerUuid: string,
): HomogeneityResult {
  const needle = `ANET_NODE_MARKER=${markerUuid}`;
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
  for (const pid of groupMembers) {
    let env: string | null;
    try {
      env = enumer.readEnviron(pid);
    } catch (err: any) {
      unreadable.push(pid);
      continue;
    }
    if (env == null) continue; // pid gone between stat and environ, normal race
    const parts = env.split("\0");
    if (parts.indexOf(needle) < 0) foreign.push(pid);
  }
  if (unreadable.length > 0) {
    return { ok: false, cause: "ENUM_ERROR", foreignPids: foreign, unreadablePids: unreadable, detail: `${unreadable.length} member(s) unreadable — cannot prove homogeneity` };
  }
  if (foreign.length > 0) {
    return { ok: false, cause: "FOREIGN_MEMBER", foreignPids: foreign, unreadablePids: [], detail: `${foreign.length} member(s) do not carry the marker` };
  }
  return { ok: true, members: groupMembers };
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

// ─── PID reuse verification ─────────────────────────────────────────────

/**
 * For each session recorded in the marker file, check whether the recorded
 * pid still refers to that specific process (starttime_jiffies match) and
 * whether the host has restarted (boot_id already checked by readMarker,
 * this is the per-session pid re-verification for stale hint detection).
 *
 * A session whose current /proc/PID/stat starttime differs from the marker's
 * stored starttime is a stale PID — the OS recycled it to an unrelated proc.
 * Skip that session, do NOT signal.
 */
export function sessionStillFresh(enumer: ProcessEnumerator, session: SessionInfo): boolean {
  let stat: ProcStat | null;
  try {
    stat = enumer.readStat(session.pid);
  } catch {
    return false; // fail-closed
  }
  if (stat == null) return false; // process gone
  return stat.starttime_jiffies === session.starttime_jiffies;
}

// ─── Reap orchestration ─────────────────────────────────────────────────

export type ReapResult =
  | { kind: "success"; killedPgids: number[]; residualPids: number[] }
  | { kind: "failed"; killedPgids: number[]; residualPids: number[]; skippedGroups: Array<{ pgid: number; reason: string }>; detail: string };

export interface ReapOptions {
  graceMs: number;
  logger: (msg: string) => void;
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
export function reapMarkerGroups(
  enumer: ProcessEnumerator,
  killer: KillPrimitive,
  markerUuid: string,
  opts: ReapOptions,
): ReapResult {
  const skippedGroups: Array<{ pgid: number; reason: string }> = [];
  const killedPgids: number[] = [];

  // Step 1-2: discover + group
  const pids = scanEnvironForMarker(enumer, markerUuid);
  opts.logger(`[identity] environ scan found ${pids.length} marker-carrying pid(s)`);
  if (pids.length === 0) {
    return { kind: "success", killedPgids: [], residualPids: [] };
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

  // Step 5: grace
  const sleep = (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait so we don't need an async layer here */ }
  };
  sleep(opts.graceMs);

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
  const residual = scanEnvironForMarker(enumer, markerUuid);
  if (residual.length > 0) {
    return {
      kind: "failed",
      killedPgids,
      residualPids: residual,
      skippedGroups,
      detail: `${residual.length} marker-carrying pid(s) still alive after grace+KILL`,
    };
  }
  return { kind: "success", killedPgids, residualPids: [] };
}
