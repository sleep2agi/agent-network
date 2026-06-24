// P1a of /loop SDK plan v0.4 — pure scheduler-tick decision logic.
//
// `runGoalSchedulerTick` (cli.ts) does I/O — it persists state, calls
// processTask, sends replies. To keep that loop testable and reasoning
// about wake-fairness simple, the *decision* of "which goals are due
// this tick" is factored out into a pure function here. The cli-side
// loop then just iterates over the result and performs the side effects.
//
// Pure inputs in, pure list out — no Date.now() reads inside, no I/O,
// no module-level state. The tick caller passes its own `now`, which
// also makes deterministic unit tests trivial.

import type { AgentGoal } from "./types";

export interface TickDecision {
  /** Goals whose `next_wake_at` is at or before `now` AND `status === "active"`. Wake order is the input goal order — stable across calls. */
  due: AgentGoal[];
  /** Total active goals seen (`status === "active"`). Useful for telemetry / overdue tracking. */
  active: number;
  /** Active goals NOT due yet — their next_wake_at is still in the future. */
  pending: number;
  /** Non-active goals skipped this tick (`complete`, `cancelled`, `failed`, `paused`). */
  skipped: number;
}

/**
 * Decide which active goals are due to wake at `now`. Pure.
 *
 * Selection rules (intentionally narrow — the cli-side tick loop is
 * already guarded by `goalTickRunning` against overlap, so we don't
 * need fancy fairness here):
 *
 * - `status === "active"` AND `next_wake_at <= now`  → due
 * - `status === "active"` AND `next_wake_at >  now`  → pending
 * - any other status                                → skipped
 *
 * Invalid `next_wake_at` (missing / unparseable) is treated as "due
 * NOW" so a corrupted record gets attention on the next tick rather
 * than silently being skipped forever.
 */
export function decideTickWork(goals: AgentGoal[], now: Date): TickDecision {
  const nowMs = now.getTime();
  const due: AgentGoal[] = [];
  let active = 0;
  let pending = 0;
  let skipped = 0;

  for (const g of goals) {
    if (g.status !== "active") {
      skipped++;
      continue;
    }
    active++;
    const wakeMs = parseWakeTime(g.next_wake_at);
    if (wakeMs === null) {
      // Treat un-parseable timestamps as overdue — better to surface
      // the goal to the wake handler (which logs + writes a progress
      // entry) than to silently leave it dangling forever.
      due.push(g);
      continue;
    }
    if (wakeMs <= nowMs) due.push(g);
    else pending++;
  }

  return { due, active, pending, skipped };
}

function parseWakeTime(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
