// Per-agent process telemetry for #142 (Track 2 of v0.10.0).
//
// Extends #119's host-telemetry.ts with metrics scoped to this agent-node
// process — RSS, CPU%, uptime, in-flight task count. Aggregated by commhub-
// server (T2.2, 通信牛) and rendered by dashboard sidebar/hover (T2.3,
// N站马) alongside the existing per-host fields.
//
// All fields are nullable independently. CPU% is null on the first sample
// because it needs a delta against a previous sample. After that it tracks
// the rate of cpuUsage growth over wall-clock time.
//
// The in-flight counter is incremented when think() begins processing a
// task and decremented when it returns (success or error). Race-free
// because think() serializes through thinkQueue.

export interface ProcessTelemetry {
  rss_bytes: number;
  rss_mb: number;
  cpu_pct: number | null;
  uptime_seconds: number;
  in_flight_count: number;
}

interface CpuSample {
  ts_ms: number;
  user_us: number;
  system_us: number;
}

let _lastCpu: CpuSample | null = null;
let _inFlight = 0;

export function incrementInFlight(): void {
  _inFlight++;
}

export function decrementInFlight(): void {
  _inFlight = Math.max(0, _inFlight - 1);
}

export function getInFlightCount(): number {
  return _inFlight;
}

export function getProcessTelemetry(): ProcessTelemetry {
  const now = Date.now();
  const cpu = process.cpuUsage();

  let cpu_pct: number | null = null;
  if (_lastCpu) {
    const wallDeltaMs = now - _lastCpu.ts_ms;
    const userDeltaUs = cpu.user - _lastCpu.user_us;
    const systemDeltaUs = cpu.system - _lastCpu.system_us;
    const cpuDeltaMs = (userDeltaUs + systemDeltaUs) / 1000;
    if (wallDeltaMs > 0) {
      // cpu% can exceed 100 on multi-core systems (e.g. parallel I/O).
      // Round to 1 decimal for readability.
      cpu_pct = Math.round((cpuDeltaMs / wallDeltaMs) * 100 * 10) / 10;
    }
  }
  _lastCpu = { ts_ms: now, user_us: cpu.user, system_us: cpu.system };

  const mem = process.memoryUsage();
  const rss_bytes = mem.rss;
  const rss_mb = Math.round((rss_bytes / (1024 * 1024)) * 10) / 10;

  return {
    rss_bytes,
    rss_mb,
    cpu_pct,
    uptime_seconds: Math.round(process.uptime()),
    in_flight_count: _inFlight,
  };
}

// Test-only: reset sampler state (cpu delta history + in-flight counter).
// Not part of public API but available for unit tests.
export function _resetProcessTelemetry(): void {
  _lastCpu = null;
  _inFlight = 0;
}
