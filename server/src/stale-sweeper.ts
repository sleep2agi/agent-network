// Round-2/4 review ③ — read-path write amplification fix.
//
// Before this module: GET /api/status, GET /api/servers, GET
// /api/server-health/:host, and the MCP `get_all_status` tool each
// fired:
//
//   UPDATE sessions SET status = 'offline'
//   WHERE updated_at < ?1 AND status != 'offline'
//
// on every call. With the dashboard polling /api/status every few
// seconds × N tabs × M users, that's a high-frequency WRITE on a
// heavily-read table just to maintain a derived field. Wait events
// stack up (WAL fsync, page locks) and the writes are 99% no-ops.
//
// Fix: move the stale-marking off the read path into a single
// background timer. Reads now SELECT only; the timer runs every 60s
// and applies the same UPDATE GLOBALLY (no per-network scope — stale
// is stale regardless of which tenant is asking). Worst-case delay
// between an agent crashing and going `offline` in the dashboard:
//
//   10min stale cutoff + 60s sweep = up to ~11min
//
// (unchanged from before the fix for any reader that wasn't actively
// polling).
//
// Same pattern as `src/retention.ts` for shutdown (clearInterval in
// the graceful shutdown handler).

import { db } from "./db.js";

export type StaleSweepResult = {
  startedAt: string;
  durationMs: number;
  markedOffline: number;
  staleCutoffMinutes: number;
};

// Stale window: an agent that hasn't reported in this many minutes is
// considered offline. Matches the pre-fix per-request cutoff so the
// observable behaviour from the dashboard's perspective is unchanged.
const DEFAULT_STALE_MINUTES = 10;
const DEFAULT_SWEEP_MS = 60 * 1000;

export function staleCutoffMinutes(): number {
  const raw = process.env.COMMHUB_STALE_CUTOFF_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_STALE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALE_MINUTES;
  return n;
}

function sqliteCutoff(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

// Single GLOBAL UPDATE — no per-network filtering. The pre-fix per-
// request stale marker WAS scoped (each REST call only saw its own
// network's stale rows), but the semantics of "this row hasn't been
// heard from in 10min" is global. A network that no one's looking at
// still wants its agents marked offline so an admin scanning all
// networks gets consistent state.
export function sweepStaleSessions(cutoffMinutes = staleCutoffMinutes()): StaleSweepResult {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let markedOffline = 0;
  try {
    const cutoff = sqliteCutoff(cutoffMinutes);
    const res = db.run(
      "UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'",
      [cutoff],
    );
    markedOffline = res.changes ?? 0;
  } catch (e: any) {
    console.log(`[commhub stale-sweep] failed: ${e?.message ?? e}`);
  }
  return {
    startedAt,
    durationMs: Date.now() - t0,
    markedOffline,
    staleCutoffMinutes: cutoffMinutes,
  };
}

export function startStaleSessionSweeper(
  intervalMs?: number,
): ReturnType<typeof setInterval> {
  const env = process.env.COMMHUB_STALE_SWEEP_SECONDS;
  const envMs = env && Number.isFinite(Number(env)) && Number(env) > 0
    ? Number(env) * 1000
    : undefined;
  const ms = intervalMs ?? envMs ?? DEFAULT_SWEEP_MS;
  const sweep = () => {
    try {
      const r = sweepStaleSessions();
      // Log only when something actually changed — quiet hubs stay quiet.
      if (r.markedOffline > 0) {
        console.log(
          `[commhub stale-sweep] marked ${r.markedOffline} session(s) offline in ${r.durationMs}ms ` +
            `(cutoff=${r.staleCutoffMinutes}min)`,
        );
      }
    } catch (e: any) {
      console.log(`[commhub stale-sweep] top-level failed: ${e?.message ?? e}`);
    }
  };
  // Fire once at boot via setImmediate so the very-first /api/status
  // after server start gets fresh stale state without blocking
  // startup.
  setImmediate(sweep);
  return setInterval(sweep, ms);
}
