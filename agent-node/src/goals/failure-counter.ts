// RFC-025 P0.3 — poison-goal auto-pause counter helpers.
//
// A loop that fails every wake (bad config / dead vendor / spec bug)
// used to keep firing every tick forever — log flood + LLM-token
// burn + no operator signal beyond `grep goals.json`. This module
// implements a "3-strikes"-style backstop:
//
//   - Every wake failure (LLM error / codex thread crash / tick-wide
//     catch) increments `consecutive_failures` on the goal.
//   - When it reaches MAX_CONSECUTIVE_FAILURES (default 5, env-
//     overridable via COMMHUB_MAX_CONSECUTIVE_FAILURES), the goal
//     is auto-paused (status="paused") + a progress_log note is
//     written. The scheduler tick's `decideTickWork` already skips
//     paused goals, so no further wakes fire.
//   - Any successful wake (report / complete) resets the counter to
//     0. `edit_my_loop({paused: false})` unpause also resets — giving
//     the agent/operator a fresh 5-strike window post-fix.
//
// Semantics choice: **auto-pause, NOT auto-cancel**. Cancel is a
// terminal decision made by the agent/user; auto-pause is a reversible
// safety net so the operator can `edit_my_loop --paused false` after
// fixing the root cause. Cancel is `edit`-immune (terminal); pause is not.
//
// **Legacy compat**: goals without `consecutive_failures` (every goal
// in every goals.json before this ship) read as `undefined` → treated
// as 0 by `getFailureCount`. Zero migration needed; no schema bump.

import type { AgentGoal } from "./types";

/** Auto-pause threshold. Env-overridable for tests + rare operator tuning. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export function resolveMaxConsecutiveFailures(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.COMMHUB_MAX_CONSECUTIVE_FAILURES || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_CONSECUTIVE_FAILURES;
}

/** Legacy-safe read: undefined → 0. */
export function getFailureCount(g: AgentGoal): number {
  return g.consecutive_failures ?? 0;
}

/**
 * Mutate a goal object to record ONE failure.
 * Returns { newCount, shouldPause } — caller decides how to react.
 * Never throws. Pure.
 */
export function bumpFailure(
  g: AgentGoal,
  max: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): { newCount: number; shouldPause: boolean } {
  const newCount = getFailureCount(g) + 1;
  g.consecutive_failures = newCount;
  const shouldPause = newCount >= max;
  return { newCount, shouldPause };
}

/**
 * Mutate a goal object to reset the failure counter to 0.
 * Called on successful wake OR on unpause. Idempotent.
 */
export function resetFailure(g: AgentGoal): void {
  if (g.consecutive_failures !== 0 && g.consecutive_failures !== undefined) {
    g.consecutive_failures = 0;
  }
}

/**
 * Compose the auto-pause mutation: set status=paused, keep the
 * `consecutive_failures` count intact (for observability — operator
 * grepping goals.json can see WHY it paused).
 * Caller invokes this inside a `goalStore.mutate` callback after
 * `bumpFailure` returns `shouldPause=true`.
 */
export function applyAutoPause(g: AgentGoal, reasonSummary: string): void {
  g.status = "paused";
  g.progress_log.push({
    ts: new Date().toISOString(),
    status: "auto-paused",
    summary: `auto-paused after ${getFailureCount(g)} consecutive failures: ${reasonSummary.slice(0, 300)}`,
    task_id: g.parent_task_id,
  });
}
