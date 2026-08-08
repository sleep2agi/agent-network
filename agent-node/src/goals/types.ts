// Phase 1 of #184 — codex-sdk /goal scheduler types.
//
// `AgentGoal` is the persisted unit: each agent-node owns its own
// `~/.anet/nodes/<alias>/goals.json` file, the authoritative source per the
// v0.2 feasibility note (`docs/research/codex-sdk-goal-feasibility.md`).
// codex thread context is work-state continuation; goal state is data.
//
// Schema is versioned via `GoalsFile.version` so future migrations can
// distinguish formats. Phase 1 ships `version: 1`.

export type GoalStatus =
  | "active"      // wakes on interval
  | "paused"      // skipped by scheduler but kept in store
  | "complete"    // terminal (goal achieved)
  | "failed"      // terminal (unrecoverable)
  | "cancelled"   // terminal (user-stopped)
  ;

export interface GoalProgressEntry {
  ts: string;        // ISO-8601 timestamp
  status: string;    // short status label (e.g. "wake", "report", "error")
  summary: string;   // human-readable line
  task_id?: string;  // optional link to the commhub task this entry came from
}

// RFC-025 M1 — cron-lite schedule for wall-clock cadences ("每天 9 点",
// 每周一 etc.). Backward compatible: existing goals with only
// `interval_ms` continue to work unchanged (schedule = undefined →
// scheduler falls back to interval_ms + last next_wake_at math, which
// is what it already does).
//
// Union members:
//   - `interval` — pure cadence ("every N ms"). Equivalent to legacy
//     interval_ms; provided for new-format consistency.
//   - `time_of_day` — fires at a specific clock time each day (e.g.
//     "09:00"). Uses node's `flags.timezone` (default Asia/Shanghai
//     per RFC-025 §11.8).
//   - `weekday` — same as time_of_day but on specific weekdays only
//     (e.g. "mon 09:00" or "mon,wed,fri 18:30").
export type AgentGoalSchedule =
  | { type: "interval"; interval_ms: number }
  | { type: "time_of_day"; time: string /* "HH:MM" */; timezone?: string }
  | { type: "weekday"; days: string[] /* ["mon","wed","fri"] */; time: string; timezone?: string };

export interface AgentGoal {
  goal_id: string;                   // UUID, stable across renames + restarts
  text: string;                      // goal body (parsed from /agoal or /aloop)
  status: GoalStatus;
  // **Legacy load-bearing**: every existing goal in goals.json across
  // the install base has `interval_ms`. RFC-025 keeps this field
  // required so the parser, scheduler, and store all stay
  // back-compat. New cron-lite schedule modes (time_of_day /
  // weekday) populate `schedule` AND set interval_ms to the natural
  // cadence (e.g. 24h for daily, 7d for weekly) — that way any
  // code path that only reads interval_ms still sees something
  // reasonable.
  interval_ms: number;
  // Optional cron-lite schedule (RFC-025 M1, P0a). `undefined` =
  // legacy interval-only behaviour (scheduler uses interval_ms).
  // Present = scheduler uses computeNextWakeAt(schedule, now) for
  // next_wake_at calculation.
  schedule?: AgentGoalSchedule;
  next_wake_at: string;              // ISO-8601 timestamp
  last_wake_at?: string;
  last_report_at?: string;
  parent_task_id?: string;           // upstream task that spawned this goal
  report_to?: string;                // CommHub alias/session to receive loop reports
  codex_thread_id?: string;          // populated on `thread.started` (Phase 2)
  runtime: string;                   // e.g. "codex-sdk" / "claude-agent-sdk"
  created_at: string;
  updated_at: string;
  progress_log: GoalProgressEntry[];
  // RFC-025 P0.3 — poison-goal auto-pause counter. Incremented every
  // time a wake fails (LLM error, thread crash, tick-wide catch).
  // Reset to 0 on any successful wake (report/complete) OR on
  // `edit_my_loop({paused: false})` unpause. When the counter reaches
  // MAX_CONSECUTIVE_FAILURES (default 5, env-overridable), the goal
  // is auto-paused instead of continuing to fire — protects against
  // log flood + LLM-token burn from a poison goal (bad config, dead
  // vendor, spec bug). Legacy goals load with undefined, treated as
  // 0 by the tick path; no migration needed. See RFC-025 §7 P0.3.
  consecutive_failures?: number;
}

export interface GoalsFile {
  version: 1;
  goals: AgentGoal[];
}

export const GOALS_SCHEMA_VERSION = 1 as const;
