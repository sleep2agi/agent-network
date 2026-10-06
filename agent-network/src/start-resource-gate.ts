// #612 — one admission gate before a heavy `codex app-server` is exec'd.
//
// Callers (same function, not the daemon, not a `codex` wrapper):
//   - agent-node's owned spawn (runtime.ts)
//   - anet's copresence `-appsrv`, external-appserver `-appsrv`, and Windows copresence appsrv
//   - agent-node's copresence watchdog relaunch of `-appsrv` (cli.ts)
// Not covered, and this file must not claim otherwise:
//   - a script that starts a bare app-server on its own
//   - ANET_CODEX_STDIO_DIRECT=1 (stdio app-server)
//   - the default per-task `codex exec`
// anet keeps a byte copy at agent-network/src/start-resource-gate.ts so a
// Docker image that copies only agent-network/ can still resolve the import.
//
// While MemAvailable (the smaller of /proc and a real cgroup limit) or load
// is short, wait and report 「等待内存」. The floor uses the same cgroup limit
// as the free-memory reading: min(4 GiB, 15% of min(MemTotal, cgroup limit)).
// Page cache (inactive_file) is not usage. Leases live in
// ~/.anet/run/start-slots/ keyed by node id. A lease records pid plus the
// process start time from /proc/<pid>/stat field 22, and it expires.
// After the max wait, concurrency drops to 1 and the log/status say
// 「已超时，按单路放行」. That wait never skips the lease. One waiter takes
// the slot only when the holder is actually stuck (the lease expired, or its
// pid and start time do not match). Takeover is atomic and admits one; the
// log says 「接管卡死租约」. A live matching holder stays one-at-a-time.
// The directory lock records pid, start time, and a random token. A live pid
// whose start time does not match is reclaimed at once. A live pid that still
// matches is an orphan only when the monotonic timestamp inside the lock is
// older than 60s. A wall-clock step does not age a stamped lock. Before a
// lease is written, the token is read again: a stolen lock writes nothing
// and the waiter retries. Re-entering a lease cancels this process's pending
// release of that same key and refreshes the expiry.
// ANET_START_MEM_GATE=0 disables the gate entirely. --force does not.
// Never throws.

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { cpus, homedir } from "os";
import { dirname, join } from "path";

export const START_GATE_DEFAULT_MIN_MEM_MB = 4096;
export const START_GATE_DEFAULT_MEM_FRACTION = 0.15;
export const START_GATE_DEFAULT_MAX_LOAD_PER_CPU = 2;
export const START_GATE_DEFAULT_MAX_WAIT_SEC = 600;
export const START_GATE_DEFAULT_MAX_CONCURRENT = 2;
export const START_GATE_SINGLE_LANE_CONCURRENT = 1;
export const START_GATE_RECHECK_MS = 15_000;
/** Jitter added to each re-check while still inside the max wait: uniform [0, RECHECK_JITTER_MS). */
export const START_GATE_RECHECK_JITTER_MS = 5_000;
export const START_GATE_WAITING_STATUS = "等待内存";
export const START_GATE_SINGLE_LANE_STATUS = "已超时，按单路放行";
/** Logged when one waiter atomically replaces a stuck lease. The wait cap must not admit without this. */
export const START_GATE_TAKEOVER_STATUS = "接管卡死租约";
/** Startup leases older than this are not live. ANET_START_LEASE_TTL_SEC overrides it. */
export const START_GATE_LEASE_TTL_MS = 10 * 60 * 1000;
/** An empty or unreadable lock younger than this is still being published, not dead. */
export const START_GATE_LOCK_STALE_MS = 30_000;
/**
 * A live matching lock is an orphan when the monotonic timestamp stored in
 * the lock is older than this. Legacy locks with no stamp still use wall
 * mtime, which a clock step can age out. The critical section only renames
 * and writes a few files, so a live holder past this window is stuck.
 */
export const START_GATE_LOCK_ORPHAN_MS = 60_000;

/**
 * Mutation anchor for tests/test612-start-admission. true publishes the lock
 * by linking a file that already has its payload. false is the old race:
 * O_EXCL creates an empty file, the pid is written afterwards with no pause,
 * and an empty file is unlinked as a dead holder.
 */
const LOCK_PUBLISH_ATOMIC = true;

/** Above this, a cgroup "limit" is the v1 unlimited sentinel (or similar), not a real cap. */
const CGROUP_UNLIMITED_BYTES = 2 ** 50;

export interface StartGateDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Returns file contents, or null when unreadable. */
  readFile?: (path: string) => string | null;
  cpuCount?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Hub/task text. Errors are swallowed so a report failure cannot block a start. */
  report?: (text: string) => void;
  /** Host lease directory. Tests must inject this; the default is ~/.anet/run/start-slots. */
  slotsDir?: string;
  /** Lease key. Alias is not unique across workspaces; pass the node id. */
  nodeId?: string;
  /** Pid written into the lease. Default: this process. */
  holderPid?: number;
  /** ESRCH = dead, EPERM = alive. Injected so tests never signal a real pid. */
  isPidAlive?: (pid: number) => boolean;
  /** /proc/<pid>/stat field 22. null means unknown — do not treat that as a mismatch. */
  readProcessStartTicks?: (pid: number) => string | null;
  /** Override the 15s re-check. With jitterMs 0 the single-lane retry uses this as-is. */
  recheckMs?: number;
  /** Override the 0–5s jitter span. 0 keeps the sleep exactly recheckMs. */
  jitterMs?: number;
  /** Lease lifetime. Default 10 minutes, or ANET_START_LEASE_TTL_SEC. */
  leaseTtlMs?: number;
  /** Empty/unreadable locks younger than this are held, not dead. */
  lockStaleMs?: number;
  /** A live matching lock older than this is an orphan. Default 60s. */
  lockOrphanMs?: number;
  /**
   * Monotonic milliseconds shared by every process on this host.
   * Default reads /proc/uptime. null means unknown: a stamped lock is kept.
   */
  monotonicNow?: () => number | null;
}

export type StartGateOutcome = "disabled" | "unsupported" | "ok" | "waited" | "single-lane";

export interface StartGateResult {
  outcome: StartGateOutcome;
  waitedMs: number;
  checks: number;
  /** Always callable and idempotent. Drops the lease only if this call created it. */
  release: () => void;
}

export interface HostSample {
  /** Effective free MiB: min(MemAvailable, cgroup free) when a real cgroup limit exists. */
  memAvailableMb: number;
  /** /proc MemAvailable, before the cgroup min. */
  procAvailableMb: number;
  /** Cgroup free MiB, or null when there is no real limit. */
  cgroupFreeMb: number | null;
  /** Cgroup limit MiB, or null when there is no real limit. The floor uses this, not the host alone. */
  cgroupLimitMb: number | null;
  /** 0 when MemTotal could not be read (the floor then falls back to 4096). */
  memTotalMb: number;
  load1: number;
  cpuCount: number;
}

interface HolderRecord {
  pid: number | null;
  /** null when the file has no start time (legacy pid-only, or "-"). */
  start: string | null;
  /** null when the file has no expiry (legacy). A number is an absolute ms timestamp. */
  expiresAt: number | null;
  /** Lock attempts only. Distinguishes two publishes by the same pid and start. */
  token: string | null;
  /** Monotonic ms from the lock body. null on leases and on legacy locks. */
  monoMs: number | null;
}

interface PendingDrop {
  cancelled: boolean;
  timer?: ReturnType<typeof setInterval>;
  run: () => boolean;
}

const slotQueues = new Map<string, Promise<unknown>>();
const pendingDrops = new Map<string, PendingDrop>();
let exitHooked = false;
let anonSeq = 0;

/** MemAvailable in MiB from /proc/meminfo text, or null. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  if (!m) return null;
  return Number(m[1]) / 1024;
}

/** MemTotal in MiB from /proc/meminfo text, or null. */
export function parseMemTotalMb(meminfo: string): number | null {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(meminfo);
  if (!m) return null;
  return Number(m[1]) / 1024;
}

/** 1-minute load average from /proc/loadavg text, or null. */
export function parseLoad1(loadavg: string): number | null {
  const first = loadavg.trim().split(/\s+/)[0];
  if (!first) return null;
  const v = Number(first);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Field 22 of /proc/<pid>/stat (starttime, clock ticks since boot).
 * The comm field is in parentheses and may contain spaces; everything after the
 * last ")" is field 3 onward, so field 22 is index 19 of that tail.
 */
export function parseProcStartTicks(statText: string): string | null {
  const end = statText.lastIndexOf(")");
  if (end < 0) return null;
  const rest = statText.slice(end + 1).trim().split(/\s+/);
  const v = rest[19];
  return v && /^[0-9]+$/.test(v) ? v : null;
}

/**
 * Default free-memory floor. A fixed 4 GiB is too high for a small machine
 * or a small container, so the floor is min(4 GiB, 15% of the effective total).
 * The effective total is min(MemTotal, cgroup limit) when a real cgroup limit
 * exists — a container must not be judged against the host's MemTotal.
 * Missing/invalid numbers fall back to 4 GiB. ANET_START_MIN_MEM_MB replaces
 * this when set.
 */
export function defaultStartMinMemMb(memTotalMb: number, cgroupLimitMb?: number | null): number {
  const totalOk = Number.isFinite(memTotalMb) && memTotalMb > 0;
  const cgOk = cgroupLimitMb != null && Number.isFinite(cgroupLimitMb) && cgroupLimitMb > 0;
  const base = totalOk && cgOk ? Math.min(memTotalMb, cgroupLimitMb as number) : cgOk ? (cgroupLimitMb as number) : totalOk ? memTotalMb : 0;
  if (!(base > 0)) return START_GATE_DEFAULT_MIN_MEM_MB;
  return Math.min(START_GATE_DEFAULT_MIN_MEM_MB, base * START_GATE_DEFAULT_MEM_FRACTION);
}

function formatMb(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function positiveNumberEnv(env: NodeJS.ProcessEnv, name: string, def: number, warn: (m: string) => void): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  warn(`[start-gate] ignoring ${name}=${JSON.stringify(raw)} (expected a positive number); using default ${def}`);
  return def;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM: the pid exists but we may not signal it. ESRCH: it is gone.
    return e?.code !== "ESRCH";
  }
}

function defaultReadProcessStartTicks(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** Reasons the host is too busy to start, empty when it is fine. */
export function startGateReasons(s: HostSample, minMemMb: number, maxLoadPerCpu: number): string[] {
  const reasons: string[] = [];
  if (s.memAvailableMb < minMemMb) {
    const floor = formatMb(minMemMb);
    if (s.cgroupFreeMb != null && s.cgroupFreeMb + 1 < s.procAvailableMb) {
      reasons.push(
        `free ${Math.round(s.memAvailableMb)} MiB < ${floor} MiB (cgroup ${Math.round(s.cgroupFreeMb)} MiB tighter than MemAvailable ${Math.round(s.procAvailableMb)} MiB; ANET_START_MIN_MEM_MB)`,
      );
    } else {
      reasons.push(`MemAvailable ${Math.round(s.memAvailableMb)} MiB < ${floor} MiB (ANET_START_MIN_MEM_MB)`);
    }
  }
  const maxLoad = maxLoadPerCpu * s.cpuCount;
  if (s.load1 > maxLoad) {
    reasons.push(`load1 ${s.load1.toFixed(2)} > ${maxLoad} (${maxLoadPerCpu} x ${s.cpuCount} CPUs, ANET_START_MAX_LOAD_PER_CPU)`);
  }
  return reasons;
}

function cgroupMemoryFiles(text: string): { maxPath: string; currentPath: string; statPath: string; v1: boolean } | null {
  const lines = text.split(/\r?\n/);
  let rel: string | null = null;
  let v1 = false;
  for (const line of lines) {
    const v2 = /^0::(.*)$/.exec(line.trim());
    if (v2) {
      rel = v2[1] || "/";
      v1 = false;
      break;
    }
  }
  if (rel === null) {
    for (const line of lines) {
      const m = /^\d+:memory:(.*)$/.exec(line.trim());
      if (m) {
        rel = m[1] || "/";
        v1 = true;
        break;
      }
    }
  }
  if (rel === null) return null;
  if (rel.includes("\0") || rel.split("/").includes("..")) return null;
  if (!rel.startsWith("/")) rel = `/${rel}`;
  const base = v1
    ? `/sys/fs/cgroup/memory${rel === "/" ? "" : rel}`
    : `/sys/fs/cgroup${rel === "/" ? "" : rel}`;
  return {
    maxPath: v1 ? `${base}/memory.limit_in_bytes` : `${base}/memory.max`,
    currentPath: v1 ? `${base}/memory.usage_in_bytes` : `${base}/memory.current`,
    statPath: `${base}/memory.stat`,
    v1,
  };
}

function statNumber(statText: string, key: string): number | null {
  const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, "m").exec(statText);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Reclaimable page cache. v1 prefers total_inactive_file; v2 prefers inactive_file. */
function inactiveFileBytes(statText: string | null, v1: boolean): number {
  if (!statText) return 0;
  const preferred = v1 ? "total_inactive_file" : "inactive_file";
  const fallback = v1 ? "inactive_file" : "total_inactive_file";
  const first = statNumber(statText, preferred);
  if (first !== null) return first;
  return statNumber(statText, fallback) ?? 0;
}

function realCgroupLimitBytes(maxText: string, memTotalMb: number): number | null {
  const maxRaw = maxText.trim();
  if (maxRaw === "max" || maxRaw === "") return null;
  const limit = Number(maxRaw);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (limit >= CGROUP_UNLIMITED_BYTES) return null;
  if (memTotalMb > 0 && limit > memTotalMb * 1024 * 1024 * 1.5) return null;
  return limit;
}

/**
 * Free MiB inside a real cgroup limit, or null when the limit is missing/unlimited.
 * `memory.current` counts page cache; inactive_file (v1: total_inactive_file) is subtracted.
 * statText null keeps the old arithmetic so existing fixtures stay valid.
 */
export function cgroupFreeMb(
  maxText: string,
  currentText: string,
  memTotalMb: number,
  statText: string | null = null,
  v1 = false,
): number | null {
  const limit = realCgroupLimitBytes(maxText, memTotalMb);
  if (limit === null) return null;
  const current = Number(currentText.trim());
  if (!Number.isFinite(current)) return null;
  const used = Math.max(0, current - inactiveFileBytes(statText, v1));
  return Math.max(0, limit - used) / (1024 * 1024);
}

/** Real cgroup limit in MiB, or null when the limit is missing/unlimited. */
export function cgroupLimitMb(maxText: string, memTotalMb: number): number | null {
  const limit = realCgroupLimitBytes(maxText, memTotalMb);
  return limit === null ? null : limit / (1024 * 1024);
}

function emptyRecord(): HolderRecord {
  return { pid: null, start: null, expiresAt: null, token: null, monoMs: null };
}

function parseRecord(text: string): HolderRecord {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !/^[0-9]+$/.test(parts[0])) return emptyRecord();
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return emptyRecord();
  const start = parts.length >= 2 && parts[1] !== "-" ? parts[1] : null;
  let expiresAt: number | null = null;
  let token: string | null = null;
  let monoMs: number | null = null;
  for (const part of parts.slice(2)) {
    if (part.startsWith("t:")) token = part.slice(2);
    else if (part.startsWith("m:") && /^[0-9]+$/.test(part.slice(2))) monoMs = Number(part.slice(2));
    else if (expiresAt === null && /^[0-9]+$/.test(part)) {
      const n = Number(part);
      if (Number.isFinite(n)) expiresAt = n;
    }
  }
  return { pid, start, expiresAt, token, monoMs };
}

function readRecord(path: string): HolderRecord {
  try {
    return parseRecord(readFileSync(path, "utf8"));
  } catch {
    return emptyRecord();
  }
}

function holderAlive(
  rec: HolderRecord,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
): boolean {
  if (rec.pid === null || !isPidAlive(rec.pid)) return false;
  if (rec.start === null) return true;
  const live = readStart(rec.pid);
  // Can't read starttime: don't steal. A mismatch means the pid was reused.
  if (live === null) return true;
  return live === rec.start;
}

function leaseIsLive(
  rec: HolderRecord,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
): boolean {
  if (rec.pid === null) return false;
  if (rec.expiresAt !== null && now() >= rec.expiresAt) return false;
  return holderAlive(rec, isPidAlive, readStart);
}

function leaseKey(nodeId: string | undefined, holderPid: number): string {
  const raw = nodeId?.trim() ? nodeId.trim() : `anon-${holderPid}-${++anonSeq}`;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 120);
  if (!cleaned || cleaned === ".lock" || cleaned === "." || cleaned === "..") {
    return `n-${holderPid}-${++anonSeq}`;
  }
  return cleaned;
}

function enqueueSlot<T>(dir: string, fn: () => T): Promise<T> {
  const prev = slotQueues.get(dir) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  slotQueues.set(dir, run.then(() => undefined, () => undefined));
  return run;
}

function randomToken(): string {
  return `${process.pid.toString(16)}${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

/** Shared across processes. Wall-clock steps do not move /proc/uptime. */
function defaultMonotonicNow(): number | null {
  try {
    const first = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
    const sec = Number(first);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.floor(sec * 1000);
  } catch {
    return null;
  }
}

function dropId(dir: string, key: string): string {
  return `${dir}\0${key}`;
}

function cancelPendingDrop(dir: string, key: string): boolean {
  const entry = pendingDrops.get(dropId(dir, key));
  if (!entry) return false;
  entry.cancelled = true;
  if (entry.timer) clearInterval(entry.timer);
  pendingDrops.delete(dropId(dir, key));
  return true;
}

function publishLock(
  dir: string,
  lockPath: string,
  holderPid: number,
  selfStart: string | null,
  monotonicNow: () => number | null,
): string | null {
  const token = randomToken();
  const mono = monotonicNow();
  const stamp = mono === null || !Number.isFinite(mono) ? "" : ` m:${Math.max(0, Math.floor(mono))}`;
  const payload = `${holderPid} ${selfStart ?? "-"} t:${token}${stamp}\n`;
  if (!LOCK_PUBLISH_ATOMIC) {
    // Dead path, kept so a one-token mutation reproduces the empty-file race.
    // The file is visible empty before the pid is written. No pause.
    let fd: number;
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch {
      return null;
    }
    try { writeSync(fd, payload); } finally { closeSync(fd); }
    try { chmodSync(lockPath, 0o600); } catch { /* best effort */ }
    return token;
  }
  const tmp = join(dir, `.lock.tmp.${holderPid}.${Date.now()}.${Math.floor(Math.random() * 1e9)}`);
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      linkSync(tmp, lockPath);
    } catch {
      return null;
    }
    try { chmodSync(lockPath, 0o600); } catch { /* best effort */ }
    return token;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* the lock, if linked, keeps the inode */ }
  }
}

type LockKind = "free" | "held" | "reclaim" | "orphan";

function classifyLock(
  lockPath: string,
  selfPid: number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  now: () => number,
  monotonicNow: () => number | null,
  staleMs: number,
  orphanMs: number,
): LockKind {
  let st: { mtimeMs: number };
  try { st = statSync(lockPath); } catch { return "free"; }
  const rec = readRecord(lockPath);
  if (rec.pid === null) {
    // Empty, junk, or unreadable. A just-created lock is not a dead holder.
    // The non-atomic mutation unlinks this case before classifyLock.
    const age = now() - st.mtimeMs;
    return age >= staleMs ? "reclaim" : "held";
  }
  // Our own pid is a leftover from this process, not a nested hold (the
  // critical section is synchronous). Always reclaim it.
  if (rec.pid === selfPid) return "reclaim";
  if (!holderAlive(rec, isPidAlive, readStart)) return "reclaim";
  if (rec.monoMs !== null) {
    const mono = monotonicNow();
    // Unknown monotonic clock: do not orphan a live holder because the wall clock jumped.
    if (mono === null || !Number.isFinite(mono)) return "held";
    return mono - rec.monoMs >= orphanMs ? "orphan" : "held";
  }
  const age = now() - st.mtimeMs;
  if (age >= orphanMs) return "orphan";
  return "held";
}

/** The pre-fix steal: drop an empty lock without comparing bytes, so a publisher still writing the pid loses it. */
function stealEmptyLock(lockPath: string): boolean {
  try { unlinkSync(lockPath); return true; } catch { return false; }
}

/** Rename the lock aside, and only then drop it if the bytes are still the ones we decided were dead. */
function reclaimLock(lockPath: string): boolean {
  const grave = join(dirname(lockPath), `.lock.grave.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e9)}`);
  let before: Buffer;
  try { before = readFileSync(lockPath); } catch { return false; }
  try { renameSync(lockPath, grave); } catch { return false; }
  let after: Buffer;
  try { after = readFileSync(grave); } catch { return false; }
  if (!before.equals(after)) {
    let restored = false;
    try { linkSync(grave, lockPath); restored = true; } catch { restored = existsSync(lockPath); }
    if (restored) { try { unlinkSync(grave); } catch { /* the grave is a dotfile and is not a lease */ } }
    return false;
  }
  try { unlinkSync(grave); } catch { /* next pass; dotfiles are not leases */ }
  return true;
}

function takeFileLock(
  dir: string,
  holderPid: number,
  selfStart: string | null,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  now: () => number,
  monotonicNow: () => number | null,
  staleMs: number,
  orphanMs: number,
  warn: (m: string) => void,
): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* umask already applied; best effort */ }
  } catch {
    return null;
  }
  const lockPath = join(dir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = publishLock(dir, lockPath, holderPid, selfStart, monotonicNow);
    if (token !== null) return token;
    if (!LOCK_PUBLISH_ATOMIC && readRecord(lockPath).pid === null) {
      if (!stealEmptyLock(lockPath)) return null;
      continue;
    }
    const kind = classifyLock(lockPath, holderPid, isPidAlive, readStart, now, monotonicNow, staleMs, orphanMs);
    if (kind === "held") return null;
    // The lock vanished between the failed publish and this check. Do not
    // reclaim whatever appears next — that file belongs to someone else.
    if (kind !== "reclaim" && kind !== "orphan") continue;
    const orphan = kind === "orphan" ? readRecord(lockPath) : null;
    if (!reclaimLock(lockPath)) return null;
    if (orphan && orphan.pid !== null) {
      warn(`[start-gate] 回收被活进程占住的孤儿锁 pid=${orphan.pid} start=${orphan.start ?? "-"}`);
    }
  }
  return null;
}

function lockStillOurs(dir: string, holderPid: number, selfStart: string | null, token: string): boolean {
  const rec = readRecord(join(dir, ".lock"));
  if (rec.pid !== holderPid || rec.token !== token) return false;
  if (rec.start !== null && selfStart !== null && rec.start !== selfStart) return false;
  return true;
}

function releaseFileLock(dir: string, holderPid: number, selfStart: string | null, token: string): void {
  if (!lockStillOurs(dir, holderPid, selfStart, token)) return;
  try { unlinkSync(join(dir, ".lock")); } catch { /* the next acquire steals a dead lock */ }
}

function reapSlots(
  dir: string,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  warn: (m: string) => void,
  stillOwns: () => boolean,
): string[] {
  const taken: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return taken; }
  for (const name of names) {
    if (!stillOwns()) return taken;
    if (name === ".lock" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const rec = readRecord(path);
    if (rec.pid === null) {
      if (!stillOwns()) return taken;
      try { unlinkSync(path); } catch { /* next pass */ }
      continue;
    }
    const expired = rec.expiresAt !== null && now() >= rec.expiresAt;
    if (!expired && holderAlive(rec, isPidAlive, readStart)) continue;
    if (!stillOwns()) return taken;
    try { unlinkSync(path); } catch { continue; }
    taken.push(name);
    if (expired) warn(`[start-gate] reaped expired start lease ${name}`);
  }
  return taken;
}

function countLiveSlots(
  dir: string,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
): number {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (name === ".lock" || name.startsWith(".")) continue;
    if (leaseIsLive(readRecord(join(dir, name)), now, isPidAlive, readStart)) n++;
  }
  return n;
}

type AcquireKind = "acquired" | "reentrant" | "no";

function acquireLease(
  dir: string,
  key: string,
  cap: number,
  holderPid: number,
  selfStart: string | null,
  ttlMs: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  staleMs: number,
  orphanMs: number,
  monotonicNow: () => number | null,
  warn: (m: string) => void,
): AcquireKind {
  const token = takeFileLock(
    dir, holderPid, selfStart, isPidAlive, readStart, now, monotonicNow, staleMs, orphanMs, warn,
  );
  if (token === null) return "no";
  const still = () => lockStillOurs(dir, holderPid, selfStart, token);
  try {
    if (!still()) return "no";
    const taken = reapSlots(dir, now, isPidAlive, readStart, warn, still);
    if (!still()) return "no";
    const mine = join(dir, key);
    const existing = readRecord(mine);
    if (
      existing.pid === holderPid
      && holderAlive(existing, isPidAlive, readStart)
      && (existing.expiresAt === null || now() < existing.expiresAt)
    ) {
      // The previous start of this same key is still trying to delete the lease.
      // Cancel that retry and keep the lease for this start.
      if (cancelPendingDrop(dir, key)) {
        if (!still()) return "no";
        const exp = now() + ttlMs;
        writeFileSync(mine, `${holderPid} ${selfStart ?? "-"} ${exp}\n`, { mode: 0o600 });
        try { chmodSync(mine, 0o600); } catch { /* best effort */ }
        if (!still()) {
          try { unlinkSync(mine); } catch { /* the next admit reaps a lease whose lock we lost */ }
          return "no";
        }
        if (taken.length > 0) warn(`[start-gate] ${START_GATE_TAKEOVER_STATUS} ${taken.join(",")}`);
        return "acquired";
      }
      return "reentrant";
    }
    if (leaseIsLive(existing, now, isPidAlive, readStart)) return "no";
    if (existing.pid !== null) {
      if (!still()) return "no";
      try { unlinkSync(mine); } catch { return "no"; }
    }
    if (!still()) return "no";
    if (countLiveSlots(dir, now, isPidAlive, readStart) >= cap) return "no";
    // The count may have stalled long enough for someone else to reclaim this lock.
    if (!still()) return "no";
    const exp = now() + ttlMs;
    writeFileSync(mine, `${holderPid} ${selfStart ?? "-"} ${exp}\n`, { mode: 0o600 });
    try { chmodSync(mine, 0o600); } catch { /* best effort */ }
    if (!still()) {
      try { unlinkSync(mine); } catch { /* the next admit reaps a lease whose lock we lost */ }
      return "no";
    }
    if (taken.length > 0) warn(`[start-gate] ${START_GATE_TAKEOVER_STATUS} ${taken.join(",")}`);
    return "acquired";
  } finally {
    releaseFileLock(dir, holderPid, selfStart, token);
  }
}

function tryDropLease(
  dir: string,
  key: string,
  holderPid: number,
  selfStart: string | null,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  staleMs: number,
  orphanMs: number,
  monotonicNow: () => number | null,
  warn: (m: string) => void,
  abandoned: () => boolean,
): boolean {
  const token = takeFileLock(
    dir, holderPid, selfStart, isPidAlive, readStart, now, monotonicNow, staleMs, orphanMs, warn,
  );
  if (token === null) return false;
  const still = () => lockStillOurs(dir, holderPid, selfStart, token);
  let ok = true;
  try {
    // Checked again under the lock: a re-entry may have cancelled this retry
    // while we were waiting to publish.
    if (abandoned()) return true;
    if (!still()) return false;
    const path = join(dir, key);
    const rec = readRecord(path);
    const ours = rec.pid === holderPid && (rec.start === null || selfStart === null || rec.start === selfStart);
    if (!ours) return true;
    if (!still()) return false;
    try { unlinkSync(path); }
    catch (e: any) {
      if (e?.code !== "ENOENT") {
        warn(`[start-gate] could not release start slot ${key}: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
      }
    }
    return ok;
  } finally {
    releaseFileLock(dir, holderPid, selfStart, token);
  }
}

function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const entry of [...pendingDrops.values()]) {
      if (entry.cancelled) continue;
      try { entry.run(); } catch { /* the process is already leaving */ }
    }
  });
}

function scheduleDrop(
  dir: string,
  key: string,
  holderPid: number,
  selfStart: string | null,
  ttlMs: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  readStart: (pid: number) => string | null,
  staleMs: number,
  orphanMs: number,
  monotonicNow: () => number | null,
  warn: (m: string) => void,
): void {
  const entry: PendingDrop = { cancelled: false, run: () => false };
  const once = () => tryDropLease(
    dir, key, holderPid, selfStart, now, isPidAlive, readStart, staleMs, orphanMs, monotonicNow, warn,
    () => entry.cancelled,
  );
  entry.run = once;
  if (once()) return;
  // The critical section is synchronous. A few millisecond retries avoid parking
  // every contested release on the 250ms timer.
  for (let i = 0; i < 8; i++) {
    const until = Date.now() + 2;
    while (Date.now() < until) { /* the other process is still in the critical section */ }
    if (once()) return;
  }
  warn(`[start-gate] could not release start slot ${key}: lock busy; retrying`);
  ensureExitHook();
  const id = dropId(dir, key);
  const prev = pendingDrops.get(id);
  if (prev) {
    prev.cancelled = true;
    if (prev.timer) clearInterval(prev.timer);
  }
  pendingDrops.set(id, entry);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (entry.cancelled) {
      clearInterval(timer);
      if (pendingDrops.get(id) === entry) pendingDrops.delete(id);
      return;
    }
    if (once()) {
      clearInterval(timer);
      if (pendingDrops.get(id) === entry) pendingDrops.delete(id);
      return;
    }
    if (Date.now() - startedAt >= ttlMs) {
      clearInterval(timer);
      if (pendingDrops.get(id) === entry) pendingDrops.delete(id);
      warn(`[start-gate] could not release start slot ${key}: still locked after ${Math.round(ttlMs / 1000)}s`);
    }
  }, 250);
  entry.timer = timer;
  timer.unref();
}

function safeReport(report: ((text: string) => void) | undefined, text: string, warn: (m: string) => void): void {
  if (!report) return;
  try {
    const out = report(text) as unknown;
    if (out && typeof (out as Promise<void>).then === "function") {
      (out as Promise<void>).catch((e) => {
        warn(`[start-gate] status report failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  } catch (e) {
    warn(`[start-gate] status report failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function noopRelease(): void {}

/**
 * Block until this host may start one heavy process.
 * Returns a release() the caller must invoke once that process is up or has failed.
 * Never throws (except when the injected sleep rejects — tests use that to stop a wait).
 */
export async function waitForStartResources(label: string, deps: StartGateDeps = {}): Promise<StartGateResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const readFile = deps.readFile ?? defaultReadFile;
  const cpuCount = deps.cpuCount ?? (() => Math.max(1, cpus().length));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const holderPid = deps.holderPid ?? process.pid;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const readStart = deps.readProcessStartTicks ?? defaultReadProcessStartTicks;
  const selfStart = readStart(holderPid);

  const finish = (outcome: StartGateOutcome, waitedMs: number, checks: number, release: () => void): StartGateResult =>
    ({ outcome, waitedMs, checks, release });

  if (env.ANET_START_MEM_GATE?.trim() === "0") return finish("disabled", 0, 0, noopRelease);
  if (platform !== "linux") return finish("unsupported", 0, 0, noopRelease);

  const envFloorRaw = env.ANET_START_MIN_MEM_MB?.trim();
  const envFloor = envFloorRaw ? positiveNumberEnv(env, "ANET_START_MIN_MEM_MB", START_GATE_DEFAULT_MIN_MEM_MB, warn) : null;
  const maxLoadPerCpu = positiveNumberEnv(env, "ANET_START_MAX_LOAD_PER_CPU", START_GATE_DEFAULT_MAX_LOAD_PER_CPU, warn);
  const maxWaitMs = positiveNumberEnv(env, "ANET_START_GATE_MAX_WAIT_SEC", START_GATE_DEFAULT_MAX_WAIT_SEC, warn) * 1000;
  const maxConcurrent = Math.max(1, Math.floor(
    positiveNumberEnv(env, "ANET_START_MAX_CONCURRENT", START_GATE_DEFAULT_MAX_CONCURRENT, warn),
  ));
  const recheckMs = deps.recheckMs ?? START_GATE_RECHECK_MS;
  const jitterSpan = deps.jitterMs ?? START_GATE_RECHECK_JITTER_MS;
  const leaseTtlMs = deps.leaseTtlMs ?? positiveNumberEnv(env, "ANET_START_LEASE_TTL_SEC", START_GATE_LEASE_TTL_MS / 1000, warn) * 1000;
  const lockStaleMs = deps.lockStaleMs ?? START_GATE_LOCK_STALE_MS;
  const lockOrphanMs = deps.lockOrphanMs ?? START_GATE_LOCK_ORPHAN_MS;
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;
  const slotsDir = deps.slotsDir?.trim()
    || env.ANET_START_SLOTS_DIR?.trim()
    || join(homedir(), ".anet", "run", "start-slots");
  const key = leaseKey(deps.nodeId, holderPid);

  const minMemFor = (s: HostSample): number => envFloor ?? defaultStartMinMemMb(s.memTotalMb, s.cgroupLimitMb);

  const sample = (): HostSample | null => {
    const meminfo = readFile("/proc/meminfo");
    const loadavg = readFile("/proc/loadavg");
    if (meminfo === null || loadavg === null) return null;
    const procMb = parseMemAvailableMb(meminfo);
    const load1 = parseLoad1(loadavg);
    if (procMb === null || load1 === null) return null;
    const totalMb = parseMemTotalMb(meminfo) ?? 0;
    let cgroupMb: number | null = null;
    let limitMb: number | null = null;
    const self = readFile("/proc/self/cgroup");
    if (self) {
      const files = cgroupMemoryFiles(self);
      if (files) {
        const maxText = readFile(files.maxPath);
        const curText = readFile(files.currentPath);
        if (maxText !== null && curText !== null) {
          const statText = readFile(files.statPath);
          cgroupMb = cgroupFreeMb(maxText, curText, totalMb, statText, files.v1);
          limitMb = cgroupLimitMb(maxText, totalMb);
        }
      }
    }
    return {
      memAvailableMb: cgroupMb === null ? procMb : Math.min(procMb, cgroupMb),
      procAvailableMb: procMb,
      cgroupFreeMb: cgroupMb,
      cgroupLimitMb: limitMb,
      memTotalMb: totalMb,
      load1,
      cpuCount: Math.max(1, cpuCount()),
    };
  };

  let releaseImpl = noopRelease;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { releaseImpl(); } catch { /* a leaked lease expires, and the next admit reaps it */ }
  };
  const ownLease = () => {
    releaseImpl = () => scheduleDrop(
      slotsDir, key, holderPid, selfStart, leaseTtlMs, now, isPidAlive, readStart, lockStaleMs, lockOrphanMs, monotonicNow, warn,
    );
  };

  const tryAcquire = (cap: number): Promise<AcquireKind> =>
    enqueueSlot(slotsDir, () => {
      try {
        return acquireLease(
          slotsDir, key, cap, holderPid, selfStart, leaseTtlMs, now, isPidAlive, readStart, lockStaleMs, lockOrphanMs, monotonicNow, warn,
        );
      } catch (e) {
        warn(`[start-gate] lease error: ${e instanceof Error ? e.message : String(e)}`);
        return "no" as AcquireKind;
      }
    });

  const started = now();
  let checks = 0;
  let lastShortageLogAt = -Infinity;
  let lastSlotLogAt = -Infinity;
  let reportedWaiting = false;
  let announcedSingleLane = false;

  const slotSleepMs = (waitedMs: number, capToMaxWait: boolean): number => {
    const jitter = jitterSpan > 0 ? Math.floor(random() * jitterSpan) : 0;
    const step = Math.max(1, recheckMs + jitter);
    if (!capToMaxWait) return step;
    return Math.min(step, Math.max(1, maxWaitMs - waitedMs));
  };

  try {
    for (;;) {
      const s = sample();
      checks++;
      const waitedMs = now() - started;
      const timedOut = waitedMs >= maxWaitMs;
      const reasons = s ? startGateReasons(s, minMemFor(s), maxLoadPerCpu) : ["/proc unreadable"];
      const shortage = reasons.length > 0;

      if (timedOut && !announcedSingleLane) {
        announcedSingleLane = true;
        const why = reasons.join("; ");
        warn(
          `[start-gate] ${label}: ${START_GATE_SINGLE_LANE_STATUS} after ${Math.round(waitedMs / 1000)}s (${why}); concurrency forced to 1 until this start finishes or fails (ANET_START_GATE_MAX_WAIT_SEC=${maxWaitMs / 1000})`,
        );
        safeReport(deps.report, START_GATE_SINGLE_LANE_STATUS, warn);
      }

      if (!timedOut && shortage) {
        if (!reportedWaiting) {
          reportedWaiting = true;
          safeReport(deps.report, START_GATE_WAITING_STATUS, warn);
        }
        if (checks === 1 || waitedMs - lastShortageLogAt >= 60_000) {
          lastShortageLogAt = waitedMs;
          const phase = checks === 1 ? "waiting before start" : `still waiting (${Math.round(waitedMs / 1000)}s)`;
          log(
            `[start-gate] ${label}: ${phase}: ${reasons.join("; ")}; re-checking every ~${Math.round(recheckMs / 1000)}s, single-lane after ${maxWaitMs / 1000}s (set ANET_START_MEM_GATE=0 to disable)`,
          );
        }
        await sleep(slotSleepMs(waitedMs, true));
        continue;
      }

      const cap = timedOut ? START_GATE_SINGLE_LANE_CONCURRENT : maxConcurrent;
      const got = await tryAcquire(cap);
      if (got === "acquired" || got === "reentrant") {
        if (got === "acquired") ownLease();
        if (timedOut) return finish("single-lane", waitedMs, checks, release);
        if (checks > 1) {
          if (s && !shortage) {
            log(`[start-gate] ${label}: host has headroom after ${Math.round(waitedMs / 1000)}s (MemAvailable ${Math.round(s.memAvailableMb)} MiB, load1 ${s.load1.toFixed(2)}, ${s.cpuCount} CPUs); starting`);
          } else {
            log(`[start-gate] ${label}: start slot acquired after ${Math.round(waitedMs / 1000)}s; starting`);
          }
          return finish("waited", waitedMs, checks, release);
        }
        return finish("ok", 0, checks, release);
      }

      if (checks === 1 || waitedMs - lastSlotLogAt >= 60_000) {
        lastSlotLogAt = waitedMs;
        log(`[start-gate] ${label}: waiting for a start slot (cap ${cap}); re-checking every ~${Math.round(recheckMs / 1000)}s`);
      }
      await sleep(slotSleepMs(waitedMs, !timedOut));
    }
  } catch (e) {
    release();
    throw e;
  }
}

/** Run `fn` while holding one start lease. Release runs on success and on failure. */
export async function withHeavyStartAdmission<T>(label: string, deps: StartGateDeps, fn: () => Promise<T>): Promise<T> {
  const gate = await waitForStartResources(label, deps);
  try {
    return await fn();
  } finally {
    gate.release();
  }
}
