// RFC-030 P3 fix — managed identity + group reap for copresence teardown.
//
// Solves two P3-evidence-confirmed gaps in the P2 stopCommand copresence
// branch (副指挥 clause 2, task 0914e49e, 2026-07-29):
//   (a) abnormal / SIGKILL teardown left codex subprocesses orphaned because
//       tmux kill-session doesn't propagate SIGHUP through the `exec codex`
//       chain to codex's own worker/subprocess tree.
//   (b) name-based `tmux kill-session -t <alias>-appsrv` blind-kills any
//       process sharing the tmux session name — an imposter could be swept.
//
// Design:
//   1. Start writes a per-node marker file with a random UUID, boot_id,
//      pid/pgid/starttime for each session, and 0600/atomic-rename semantics.
//   2. Tmux sessions get the marker uuid injected as ANET_NODE_MARKER env,
//      inherited by every child (bash → codex → codex workers).
//   3. Stop scans /proc/PID/environ for the marker uuid (identity truth, not
//      the pgid hint from the marker file — covers main-dead-child-alive
//      and setsid-new-pgid cases).
//   4. Discovered marker-carrying pids are grouped by their current PGID;
//      each PGID group is fail-closed verified for homogeneity (every live
//      member of the group must carry the marker) — a group with any
//      foreign member is SKIPPED and logged, never blind-killed.
//   5. Verified groups are reaped via `kill -TERM -<pgid>` → grace →
//      `kill -KILL -<pgid>`. Post-reap: rescan; if any marker-bearing proc
//      still alive → preserve marker file for idempotent retry.
//
// All refuses fail-closed: no name/pattern fallback, no main-pid-only
// environ check, no follow-symlink, no lenient marker parse.

import { readFileSync, writeFileSync, unlinkSync, statSync, lstatSync, chmodSync, renameSync, readdirSync, mkdirSync, fsyncSync, openSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface SessionMarker {
  tmux: string;
  starttime_jiffies: number;
  pid: number;
  pgid: number;
}

export interface CopresenceMarker {
  marker: string; // random uuid v4
  boot_id: string;
  started_at_epoch_ms: number;
  owner_uid: number;
  sessions: {
    appsrv: SessionMarker;
    bridge: SessionMarker;
    tui: SessionMarker;
  };
}

export type RefuseCause =
  | "MISSING"
  | "SYMLINK"
  | "NOT_REGULAR"
  | "WRONG_MODE"
  | "OWNER_MISMATCH"
  | "PARSE_ERROR"
  | "SCHEMA_MISSING_FIELD"
  | "STALE_BOOT_ID";

export interface ReadMarkerResult {
  ok: boolean;
  marker?: CopresenceMarker;
  refuse?: RefuseCause;
  detail?: string;
}

export function markerFilePath(nodesDir: string, nodeId: string): string {
  return join(nodesDir, nodeId, "copresence-identity.json");
}

export function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    // On non-Linux (macOS dev machines) boot_id doesn't exist; return a
    // synthetic marker so the invariant still fails-closed on cross-machine
    // marker use. The stop-time boot_id check catches drift regardless.
    return "no-proc-boot-id";
  }
}

export function readStarttimeJiffies(pid: number): number {
  const s = readFileSync(`/proc/${pid}/stat`, "utf-8");
  // /proc/PID/stat is space-separated but field 2 (comm) is in parens and
  // may contain spaces. Split by rparen to isolate the fixed tail.
  const rp = s.lastIndexOf(")");
  if (rp < 0) throw new Error("stat parse failed");
  const tail = s.slice(rp + 2).split(" ");
  // After the ) sep: field 3 = state (index 0), ... field 22 = starttime (index 19)
  return parseInt(tail[19], 10);
}

export function readPgid(pid: number): number {
  const s = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const rp = s.lastIndexOf(")");
  if (rp < 0) throw new Error("stat parse failed");
  const tail = s.slice(rp + 2).split(" ");
  // field 5 = pgrp (tail index 2)
  return parseInt(tail[2], 10);
}

function assertParentDir0700(nodesDir: string, nodeId: string): void {
  const dir = join(nodesDir, nodeId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* exists */ }
  const st = statSync(dir);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    try {
      chmodSync(dir, 0o700);
    } catch (e: any) {
      throw new Error(`node dir ${dir} could not be chmodded to 0700: ${e?.message || e}`);
    }
  }
}

export function writeMarker(
  nodesDir: string,
  nodeId: string,
  sessions: CopresenceMarker["sessions"],
): CopresenceMarker {
  assertParentDir0700(nodesDir, nodeId);
  const marker: CopresenceMarker = {
    marker: randomUUID(),
    boot_id: readBootId(),
    started_at_epoch_ms: Date.now(),
    owner_uid: process.getuid ? process.getuid()! : -1,
    sessions,
  };
  const finalPath = markerFilePath(nodesDir, nodeId);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  // Pre-unlink defeats symlink-follow attack (same idiom as P2 env-file fix).
  try { unlinkSync(tmpPath); } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
  // wx flag = fail if exists (belt-and-suspenders after pre-unlink); 0600 at create.
  const body = JSON.stringify(marker, null, 2) + "\n";
  writeFileSync(tmpPath, body, { mode: 0o600, flag: "wx" });
  chmodSync(tmpPath, 0o600); // belt-and-suspenders
  // fsync tmp file then rename atomically.
  const fd = openSync(tmpPath, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmpPath, finalPath);
  return marker;
}

export function readMarker(nodesDir: string, nodeId: string): ReadMarkerResult {
  const path = markerFilePath(nodesDir, nodeId);
  // lstat first — no follow.
  let lst;
  try { lst = lstatSync(path); }
  catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, refuse: "MISSING" };
    return { ok: false, refuse: "PARSE_ERROR", detail: e?.message || String(e) };
  }
  if (lst.isSymbolicLink()) return { ok: false, refuse: "SYMLINK", detail: path };
  if (!lst.isFile()) return { ok: false, refuse: "NOT_REGULAR", detail: path };
  const mode = lst.mode & 0o777;
  if (mode !== 0o600) return { ok: false, refuse: "WRONG_MODE", detail: `mode=0o${mode.toString(8)}` };
  const myUid = process.getuid ? process.getuid()! : -1;
  if (lst.uid !== myUid) return { ok: false, refuse: "OWNER_MISMATCH", detail: `file uid=${lst.uid} process uid=${myUid}` };
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch (e: any) { return { ok: false, refuse: "PARSE_ERROR", detail: e?.message || String(e) }; }
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (e: any) { return { ok: false, refuse: "PARSE_ERROR", detail: e?.message || String(e) }; }
  const req = ["marker", "boot_id", "started_at_epoch_ms", "owner_uid", "sessions"] as const;
  for (const k of req) {
    if (!(k in parsed)) return { ok: false, refuse: "SCHEMA_MISSING_FIELD", detail: k };
  }
  const s = parsed.sessions;
  if (!s || typeof s !== "object") return { ok: false, refuse: "SCHEMA_MISSING_FIELD", detail: "sessions" };
  for (const key of ["appsrv", "bridge", "tui"] as const) {
    if (!s[key] || typeof s[key] !== "object") return { ok: false, refuse: "SCHEMA_MISSING_FIELD", detail: `sessions.${key}` };
    for (const f of ["tmux", "starttime_jiffies", "pid", "pgid"] as const) {
      if (!(f in s[key])) return { ok: false, refuse: "SCHEMA_MISSING_FIELD", detail: `sessions.${key}.${f}` };
    }
  }
  const currentBoot = readBootId();
  if (parsed.boot_id !== currentBoot) return { ok: false, refuse: "STALE_BOOT_ID", detail: `file=${parsed.boot_id} current=${currentBoot}` };
  return { ok: true, marker: parsed as CopresenceMarker };
}

export function deleteMarker(nodesDir: string, nodeId: string): void {
  try { unlinkSync(markerFilePath(nodesDir, nodeId)); } catch { /* best-effort */ }
}

/**
 * Scan /proc/PID/environ for processes carrying our marker.
 * Returns pids as numbers. Silently skips permission errors / gone-pids
 * (kernel enumeration under scan may race).
 */
export function scanEnvironForMarker(uuid: string): number[] {
  const needle = `ANET_NODE_MARKER=${uuid}`;
  const found: number[] = [];
  let entries: string[];
  try { entries = readdirSync("/proc"); }
  catch { return []; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    let env: Buffer;
    try { env = readFileSync(`/proc/${name}/environ`); }
    catch { continue; }
    // environ is nul-separated KEY=VAL pairs.
    // Fast path: search for the needle as a substring.
    if (env.toString("utf-8").split("\0").includes(needle)) {
      found.push(pid);
    }
  }
  return found;
}

/**
 * Given a set of marker-verified pids, return a map of pgid -> pids-in-that-pgid.
 * Uses OS-truth PGID from /proc/PID/stat, not the (possibly stale) marker file hint.
 */
export function groupPidsByCurrentPgid(pids: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const pid of pids) {
    let pgid: number;
    try { pgid = readPgid(pid); }
    catch { continue; /* pid gone under scan */ }
    if (!out.has(pgid)) out.set(pgid, []);
    out.get(pgid)!.push(pid);
  }
  return out;
}

/**
 * For a given PGID, list all live members (via `ps -o pid= --pgid <pgid>`).
 * Returns pids as numbers.
 */
export function listPgidMembers(pgid: number): number[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "pid=", "--pgid", String(pgid)], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  } catch { return []; }
  return out.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
}

export interface GroupHomogeneity {
  ok: boolean;
  foreign?: number[];
}

export function verifyGroupHomogeneity(pgid: number, markedPids: Set<number>): GroupHomogeneity {
  const members = listPgidMembers(pgid);
  const foreign = members.filter((m) => !markedPids.has(m));
  if (foreign.length === 0) return { ok: true };
  return { ok: false, foreign };
}

export interface ReapResult {
  killed_pgids: number[];
  skipped_pgids: { pgid: number; foreign: number[] }[];
  residual_marker_pids: number[];
}

/**
 * Reap: for each verified PGID group, send TERM → grace → KILL. After each
 * group is signalled, do a global rescan of the marker to check no residual.
 */
export async function reapVerifiedGroups(
  markerUuid: string,
  graceMs: number,
): Promise<ReapResult> {
  const pids = scanEnvironForMarker(markerUuid);
  const marked = new Set(pids);
  const byPgid = groupPidsByCurrentPgid(pids);
  const toKill: number[] = [];
  const skipped: { pgid: number; foreign: number[] }[] = [];
  for (const pgid of byPgid.keys()) {
    if (pgid <= 1) continue; // don't kill pgid 0/1 pathological
    const homo = verifyGroupHomogeneity(pgid, marked);
    if (homo.ok) toKill.push(pgid);
    else skipped.push({ pgid, foreign: homo.foreign! });
  }
  // TERM phase
  for (const pgid of toKill) {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* group gone */ }
  }
  // Grace
  await new Promise((r) => setTimeout(r, graceMs));
  // KILL any still alive
  for (const pgid of toKill) {
    try { process.kill(-pgid, 0); process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  }
  // Small settle window before rescan.
  await new Promise((r) => setTimeout(r, 200));
  const residual = scanEnvironForMarker(markerUuid);
  return { killed_pgids: toKill, skipped_pgids: skipped, residual_marker_pids: residual };
}

/**
 * Read a tmux session's ANET_NODE_MARKER env. Returns undefined if session
 * missing, marker missing, or tmux errors.
 */
export function readTmuxSessionMarker(sessionName: string): string | undefined {
  let out: string;
  try {
    out = execFileSync("tmux", ["show-environment", "-t", sessionName, "ANET_NODE_MARKER"], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  } catch { return undefined; }
  const m = out.match(/^ANET_NODE_MARKER=(.+)$/m);
  return m ? m[1].trim() : undefined;
}
