// #612 step 1 — wait for memory/CPU headroom before spawning an OWNED codex
// app-server.
//
// Why: restarting 14 codex-app-server nodes on one 16-core / 62.6 GB host
// within 7 minutes pushed load1 to 146–325 with 0.2–0.5 GB free; the whole
// host froze and 34 nodes dropped. Each app-server start is a burst of memory
// and CPU. This gate makes a node wait (re-checking every ~15 s with jitter)
// while the host is short on memory or heavily loaded, and gives up waiting
// after a bounded time so a node never stays down forever.
//
// Env:
//   ANET_START_MEM_GATE=0              disable the gate
//   ANET_START_MIN_MEM_MB              MemAvailable floor in MiB (default 4096)
//   ANET_START_MAX_LOAD_PER_CPU        load1 ceiling per CPU (default 2)
//   ANET_START_GATE_MAX_WAIT_SEC       give up waiting after N s (default 600)
//
// Non-Linux (no /proc) or unreadable /proc: the gate is a no-op.

import { cpus } from "os";
import { readFileSync } from "fs";

export const START_GATE_DEFAULT_MIN_MEM_MB = 4096;
export const START_GATE_DEFAULT_MAX_LOAD_PER_CPU = 2;
export const START_GATE_DEFAULT_MAX_WAIT_SEC = 600;
export const START_GATE_RECHECK_MS = 15_000;
/** Jitter added to each re-check: uniform [0, RECHECK_JITTER_MS). */
export const START_GATE_RECHECK_JITTER_MS = 5_000;

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
}

export type StartGateOutcome = "disabled" | "unsupported" | "ok" | "waited" | "timeout";

export interface StartGateResult {
  outcome: StartGateOutcome;
  waitedMs: number;
  checks: number;
}

export interface HostSample {
  memAvailableMb: number;
  load1: number;
  cpuCount: number;
}

/** MemAvailable in MiB from /proc/meminfo text, or null. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
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

/** Reasons the host is too busy to start, empty when it is fine. */
export function startGateReasons(s: HostSample, minMemMb: number, maxLoadPerCpu: number): string[] {
  const reasons: string[] = [];
  if (s.memAvailableMb < minMemMb) {
    reasons.push(`MemAvailable ${Math.round(s.memAvailableMb)} MiB < ${minMemMb} MiB (ANET_START_MIN_MEM_MB)`);
  }
  const maxLoad = maxLoadPerCpu * s.cpuCount;
  if (s.load1 > maxLoad) {
    reasons.push(`load1 ${s.load1.toFixed(2)} > ${maxLoad} (${maxLoadPerCpu} x ${s.cpuCount} CPUs, ANET_START_MAX_LOAD_PER_CPU)`);
  }
  return reasons;
}

/**
 * Block until the host has headroom to start a codex app-server, or until the
 * max wait elapses (then proceed with a warning). Never throws.
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

  if (env.ANET_START_MEM_GATE?.trim() === "0") return { outcome: "disabled", waitedMs: 0, checks: 0 };
  if (platform !== "linux") return { outcome: "unsupported", waitedMs: 0, checks: 0 };

  const minMemMb = positiveNumberEnv(env, "ANET_START_MIN_MEM_MB", START_GATE_DEFAULT_MIN_MEM_MB, warn);
  const maxLoadPerCpu = positiveNumberEnv(env, "ANET_START_MAX_LOAD_PER_CPU", START_GATE_DEFAULT_MAX_LOAD_PER_CPU, warn);
  const maxWaitMs = positiveNumberEnv(env, "ANET_START_GATE_MAX_WAIT_SEC", START_GATE_DEFAULT_MAX_WAIT_SEC, warn) * 1000;

  const sample = (): HostSample | null => {
    const meminfo = readFile("/proc/meminfo");
    const loadavg = readFile("/proc/loadavg");
    if (meminfo === null || loadavg === null) return null;
    const mem = parseMemAvailableMb(meminfo);
    const load1 = parseLoad1(loadavg);
    if (mem === null || load1 === null) return null;
    return { memAvailableMb: mem, load1, cpuCount: Math.max(1, cpuCount()) };
  };

  const started = now();
  let checks = 0;
  let lastLogAt = -Infinity;
  for (;;) {
    const s = sample();
    checks++;
    if (!s) {
      if (checks === 1) return { outcome: "unsupported", waitedMs: 0, checks };
      // /proc went unreadable mid-wait: do not keep the node down on it.
      warn(`[start-gate] ${label}: /proc unreadable while waiting; starting anyway`);
      return { outcome: "timeout", waitedMs: now() - started, checks };
    }
    const reasons = startGateReasons(s, minMemMb, maxLoadPerCpu);
    const waitedMs = now() - started;
    if (reasons.length === 0) {
      if (checks > 1) {
        log(`[start-gate] ${label}: host has headroom after ${Math.round(waitedMs / 1000)}s (MemAvailable ${Math.round(s.memAvailableMb)} MiB, load1 ${s.load1.toFixed(2)}, ${s.cpuCount} CPUs); starting`);
        return { outcome: "waited", waitedMs, checks };
      }
      return { outcome: "ok", waitedMs: 0, checks };
    }
    if (waitedMs >= maxWaitMs) {
      warn(`[start-gate] ${label}: still short on resources after ${Math.round(waitedMs / 1000)}s (${reasons.join("; ")}); giving up waiting and starting anyway (ANET_START_GATE_MAX_WAIT_SEC=${maxWaitMs / 1000})`);
      return { outcome: "timeout", waitedMs, checks };
    }
    // One line on the first check, then at most one per minute.
    if (checks === 1 || waitedMs - lastLogAt >= 60_000) {
      lastLogAt = waitedMs;
      log(`[start-gate] ${label}: ${checks === 1 ? "waiting before start" : `still waiting (${Math.round(waitedMs / 1000)}s)`}: ${reasons.join("; ")}; re-checking every ~${START_GATE_RECHECK_MS / 1000}s, giving up after ${maxWaitMs / 1000}s (set ANET_START_MEM_GATE=0 to disable)`);
    }
    const jitter = Math.floor(random() * START_GATE_RECHECK_JITTER_MS);
    await sleep(Math.min(START_GATE_RECHECK_MS + jitter, Math.max(1, maxWaitMs - waitedMs)));
  }
}
