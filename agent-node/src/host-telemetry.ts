// Host telemetry sampler for #119 — appended to report_status payload so the
// commhub server (step 2, 通信牛) can aggregate per-server stats for the
// dashboard /api/servers sidebar (step 3, N站马).
//
// Linux → read /proc/loadavg + /proc/meminfo (kernel-accurate; MemAvailable is
// the kernel's own estimate of reclaimable memory, which is what users care
// about and is more accurate than freemem + buffers/cache heuristics).
//
// macOS/Win → node:os fallback (os.loadavg / os.totalmem / os.freemem). On
// Windows os.loadavg() returns [0,0,0] — we keep it null in that case to
// signal "unavailable" rather than a misleading zero.
//
// Every field can be null independently — payload always contains the `host`
// key with all fields present, so downstream aggregation logic doesn't need
// to handle a missing-host scenario.
//
// Cache 10s to amortize fs reads. agent-node's heartbeat is every 3min so the
// cache is mostly defensive against bursts (working/idle transitions in
// quick succession after a task completes).
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import {
  hostname as osHostname,
  loadavg as osLoadavg,
  totalmem as osTotalmem,
  freemem as osFreemem,
  cpus as osCpus,
  networkInterfaces as osNetworkInterfaces,
  platform as osPlatform,
} from "os";

export interface HostTelemetry {
  hostname: string;
  ip: string | null;
  cpu_load_1min: number | null;
  cpu_cores: number | null;
  mem_total_gb: number | null;
  mem_used_gb: number | null;
  mem_avail_gb: number | null;
  disk_total_gb: number | null;
  disk_used_gb: number | null;
  disk_avail_gb: number | null;
}

let _cache: { ts: number; value: HostTelemetry } | null = null;
const CACHE_MS = 10_000;

function firstNonInternalIPv4(): string | null {
  try {
    const ifaces = osNetworkInterfaces();
    for (const ifs of Object.values(ifaces)) {
      if (!ifs) continue;
      for (const i of ifs) {
        if (i.family === "IPv4" && !i.internal) return i.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function readLoadavg1Min(): number | null {
  if (osPlatform() === "linux") {
    try {
      const raw = readFileSync("/proc/loadavg", "utf-8");
      const v = parseFloat(raw.split(/\s+/)[0]);
      if (Number.isFinite(v)) return v;
    } catch { /* fall through to os.loadavg */ }
  }
  // os.loadavg() returns [0,0,0] on Windows — coerce that to null so callers
  // can distinguish "unsupported" from "actually idle".
  try {
    const arr = osLoadavg();
    if (!arr || arr.length === 0) return null;
    if (osPlatform() === "win32" && arr[0] === 0 && arr[1] === 0 && arr[2] === 0) {
      return null;
    }
    const v = arr[0];
    return Number.isFinite(v) ? v : null;
  } catch { /* ignore */ }
  return null;
}

interface MemStats { total: number | null; used: number | null; avail: number | null }

function readMemoryStats(): MemStats {
  if (osPlatform() === "linux") {
    try {
      const raw = readFileSync("/proc/meminfo", "utf-8");
      const parseKB = (key: string): number | null => {
        // /proc/meminfo lines look like "MemTotal:       65978540 kB"
        const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
        return m ? parseInt(m[1], 10) * 1024 : null;
      };
      const total = parseKB("MemTotal");
      const avail = parseKB("MemAvailable");
      if (total != null && avail != null && avail <= total) {
        return { total, used: total - avail, avail };
      }
    } catch { /* fall through to os.* */ }
  }
  try {
    const total = osTotalmem();
    const free = osFreemem();
    // On non-Linux we can only approximate avail≈free (kernel doesn't expose
    // MemAvailable). Mark used = total - free.
    return { total, used: total - free, avail: free };
  } catch {
    return { total: null, used: null, avail: null };
  }
}

interface DiskStats { total: number | null; used: number | null; avail: number | null }

// RFC-014 §2.1 — disk telemetry via execFileSync('df', ['-k', '/']).
// `-k` is POSIX-standard and reports KB on both Linux and macOS, so the
// parse logic is unified — no `-B1` (Linux-only) vs `-k` (macOS) divergence.
// execFileSync (not execSync + shell pipe) per repo shell-pipe audit hygiene.
// Windows: graceful null (dashboard shows "—" rather than misleading 0).
function readDiskStats(): DiskStats {
  if (osPlatform() === "linux" || osPlatform() === "darwin") {
    try {
      const out = execFileSync("df", ["-k", "/"], { encoding: "utf-8", timeout: 1000 });
      // df output: header line + one data row. Format:
      //   <fs> <1K-blocks> <used> <available> <use%> <mountpoint>
      // Take last non-empty line to skip the header.
      const lines = out.trim().split(/\n/);
      const lastLine = lines[lines.length - 1] || "";
      const fields = lastLine.split(/\s+/);
      const totalKb = parseInt(fields[1], 10);
      const usedKb  = parseInt(fields[2], 10);
      const availKb = parseInt(fields[3], 10);
      if (Number.isFinite(totalKb) && Number.isFinite(usedKb) && Number.isFinite(availKb)) {
        return { total: totalKb * 1024, used: usedKb * 1024, avail: availKb * 1024 };
      }
    } catch { /* fall through to null */ }
  }
  return { total: null, used: null, avail: null };
}

const toGb = (bytes: number | null): number | null =>
  bytes == null ? null : Math.round((bytes / (1024 ** 3)) * 10) / 10;

function cpuCores(): number | null {
  try {
    const n = osCpus().length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function getHostTelemetry(): HostTelemetry {
  const now = Date.now();
  // `delta >= 0` guard: NTP step / VM live-migrate can jump the wall clock
  // backward. Without this, `now - _cache.ts` goes negative and we'd serve
  // a stale value forever (until the clock catches back up past CACHE_MS).
  // Re-sampling on backward skew costs at most one extra /proc read + df.
  if (_cache) {
    const delta = now - _cache.ts;
    if (delta >= 0 && delta < CACHE_MS) return _cache.value;
  }
  const mem = readMemoryStats();
  const disk = readDiskStats();
  const value: HostTelemetry = {
    hostname: osHostname() || "unknown",
    ip: firstNonInternalIPv4(),
    cpu_load_1min: readLoadavg1Min(),
    cpu_cores: cpuCores(),
    mem_total_gb: toGb(mem.total),
    mem_used_gb: toGb(mem.used),
    mem_avail_gb: toGb(mem.avail),
    disk_total_gb: toGb(disk.total),
    disk_used_gb: toGb(disk.used),
    disk_avail_gb: toGb(disk.avail),
  };
  _cache = { ts: now, value };
  return value;
}

// Test-only: clear the cache. Not exported in the public API surface but
// available for unit tests that want to verify cache behaviour.
export function _clearHostTelemetryCache(): void {
  _cache = null;
}
