// #612 — one admission gate before a heavy `codex app-server` is exec'd.
//
// Callers (same function, not the daemon, not a `codex` wrapper):
//   - agent-node's owned spawn
//   - anet's copresence `-appsrv` tmux session
//   - anet's external-appserver `-appsrv` tmux session
//   - anet's Windows copresence appsrv process (no-op off Linux)
// A script that starts a bare app-server on its own does not pass through here.
//
// While MemAvailable (the smaller of /proc and a real cgroup limit) or load
// is short, wait and report 「等待内存」. Leases live in
// ~/.anet/run/start-slots/ keyed by node id; a dead holder pid is reaped.
// After the max wait, do not release the whole queue and do not wait forever:
// concurrency drops to 1 and the log/status say 「已超时，按单路放行」.
// ANET_START_MEM_GATE=0 disables the gate entirely. Never throws.

import { chmodSync, closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { cpus, homedir } from "os";
import { join } from "path";

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
  /** Override the 15s re-check. The single-lane retry uses this with no jitter. */
  recheckMs?: number;
  /** Override the 0–5s jitter span. */
  jitterMs?: number;
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
  /** 0 when MemTotal could not be read (the floor then falls back to 4096). */
  memTotalMb: number;
  load1: number;
  cpuCount: number;
}

const slotQueues = new Map<string, Promise<unknown>>();
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
 * Default free-memory floor. A fixed 4 GiB is too high for a small machine,
 * so the floor is min(4 GiB, 15% of MemTotal). Missing/invalid MemTotal
 * falls back to 4 GiB. ANET_START_MIN_MEM_MB replaces this when set.
 */
export function defaultStartMinMemMb(memTotalMb: number): number {
  if (!Number.isFinite(memTotalMb) || memTotalMb <= 0) return START_GATE_DEFAULT_MIN_MEM_MB;
  return Math.min(START_GATE_DEFAULT_MIN_MEM_MB, memTotalMb * START_GATE_DEFAULT_MEM_FRACTION);
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

function cgroupMemoryFiles(text: string): { maxPath: string; currentPath: string } | null {
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
  return v1
    ? { maxPath: `${base}/memory.limit_in_bytes`, currentPath: `${base}/memory.usage_in_bytes` }
    : { maxPath: `${base}/memory.max`, currentPath: `${base}/memory.current` };
}

/** Free MiB inside a real cgroup limit, or null when the limit is missing/unlimited. */
export function cgroupFreeMb(maxText: string, currentText: string, memTotalMb: number): number | null {
  const maxRaw = maxText.trim();
  if (maxRaw === "max" || maxRaw === "") return null;
  const limit = Number(maxRaw);
  const current = Number(currentText.trim());
  if (!Number.isFinite(limit) || !Number.isFinite(current) || limit <= 0) return null;
  if (limit >= CGROUP_UNLIMITED_BYTES) return null;
  if (memTotalMb > 0 && limit > memTotalMb * 1024 * 1024 * 1.5) return null;
  return Math.max(0, limit - current) / (1024 * 1024);
}

function readPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
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

function takeFileLock(dir: string, holderPid: number, isPidAlive: (pid: number) => boolean): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* umask already applied; best effort */ }
  } catch {
    return false;
  }
  const lockPath = join(dir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeSync(fd, `${holderPid}\n`); } finally { closeSync(fd); }
      try { chmodSync(lockPath, 0o600); } catch { /* best effort */ }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") return false;
      const holder = readPid(lockPath);
      // Dead holder, or a lock we ourselves left behind across a crash.
      if (holder !== null && holder !== holderPid && isPidAlive(holder)) return false;
      try { unlinkSync(lockPath); } catch { return false; }
    }
  }
  return false;
}

function releaseFileLock(dir: string, holderPid: number): void {
  const lockPath = join(dir, ".lock");
  if (readPid(lockPath) === holderPid) {
    try { unlinkSync(lockPath); } catch { /* the next acquire steals a dead lock */ }
  }
}

function reapSlots(dir: string, isPidAlive: (pid: number) => boolean): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === ".lock" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const pid = readPid(path);
    if (pid === null || !isPidAlive(pid)) {
      try { unlinkSync(path); } catch { /* next pass */ }
    }
  }
}

function countLiveSlots(dir: string, isPidAlive: (pid: number) => boolean): number {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (name === ".lock" || name.startsWith(".")) continue;
    const pid = readPid(join(dir, name));
    if (pid !== null && isPidAlive(pid)) n++;
  }
  return n;
}

type AcquireKind = "acquired" | "reentrant" | "no";

function acquireLease(
  dir: string,
  key: string,
  cap: number,
  holderPid: number,
  isPidAlive: (pid: number) => boolean,
): AcquireKind {
  if (!takeFileLock(dir, holderPid, isPidAlive)) return "no";
  try {
    reapSlots(dir, isPidAlive);
    const mine = join(dir, key);
    const existing = readPid(mine);
    // Same node, same live pid: the caller already holds this lease.
    if (existing === holderPid && isPidAlive(holderPid)) return "reentrant";
    // A different live pid is already starting this node.
    if (existing !== null && isPidAlive(existing)) return "no";
    if (existing !== null) {
      try { unlinkSync(mine); } catch { return "no"; }
    }
    if (countLiveSlots(dir, isPidAlive) >= cap) return "no";
    writeFileSync(mine, `${holderPid}\n`, { mode: 0o600 });
    try { chmodSync(mine, 0o600); } catch { /* best effort */ }
    return "acquired";
  } finally {
    releaseFileLock(dir, holderPid);
  }
}

function dropLease(
  dir: string,
  key: string,
  holderPid: number,
  isPidAlive: (pid: number) => boolean,
  warn: (m: string) => void,
): void {
  for (let i = 0; i < 25; i++) {
    if (!takeFileLock(dir, holderPid, isPidAlive)) {
      const until = Date.now() + 2;
      while (Date.now() < until) { /* the other process's critical section is short */ }
      continue;
    }
    try {
      const path = join(dir, key);
      if (readPid(path) === holderPid) unlinkSync(path);
      return;
    } catch (e) {
      warn(`[start-gate] could not release start slot ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      releaseFileLock(dir, holderPid);
    }
  }
  warn(`[start-gate] could not release start slot ${key}: lock busy`);
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
  const slotsDir = deps.slotsDir?.trim()
    || env.ANET_START_SLOTS_DIR?.trim()
    || join(homedir(), ".anet", "run", "start-slots");
  const key = leaseKey(deps.nodeId, holderPid);

  const minMemFor = (s: HostSample): number => envFloor ?? defaultStartMinMemMb(s.memTotalMb);

  const sample = (): HostSample | null => {
    const meminfo = readFile("/proc/meminfo");
    const loadavg = readFile("/proc/loadavg");
    if (meminfo === null || loadavg === null) return null;
    const procMb = parseMemAvailableMb(meminfo);
    const load1 = parseLoad1(loadavg);
    if (procMb === null || load1 === null) return null;
    const totalMb = parseMemTotalMb(meminfo) ?? 0;
    let cgroupMb: number | null = null;
    const self = readFile("/proc/self/cgroup");
    if (self) {
      const files = cgroupMemoryFiles(self);
      if (files) {
        const maxText = readFile(files.maxPath);
        const curText = readFile(files.currentPath);
        if (maxText !== null && curText !== null) cgroupMb = cgroupFreeMb(maxText, curText, totalMb);
      }
    }
    return {
      memAvailableMb: cgroupMb === null ? procMb : Math.min(procMb, cgroupMb),
      procAvailableMb: procMb,
      cgroupFreeMb: cgroupMb,
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
    try { releaseImpl(); } catch { /* a leaked lease is reaped when its pid dies */ }
  };
  const ownLease = () => {
    releaseImpl = () => dropLease(slotsDir, key, holderPid, isPidAlive, warn);
  };

  const tryAcquire = (cap: number): Promise<AcquireKind> =>
    enqueueSlot(slotsDir, () => {
      try {
        return acquireLease(slotsDir, key, cap, holderPid, isPidAlive);
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
        const jitter = Math.floor(random() * jitterSpan);
        const step = Math.max(1, recheckMs + jitter);
        await sleep(Math.min(step, Math.max(1, maxWaitMs - waitedMs)));
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
      if (timedOut) {
        await sleep(Math.max(1, recheckMs));
      } else {
        const jitter = Math.floor(random() * jitterSpan);
        const step = Math.max(1, recheckMs + jitter);
        await sleep(Math.min(step, Math.max(1, maxWaitMs - waitedMs)));
      }
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
