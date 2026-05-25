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

export interface AgentGoal {
  goal_id: string;                   // UUID, stable across renames + restarts
  text: string;                      // goal body (parsed from /goal command)
  status: GoalStatus;
  interval_ms: number;               // wake cadence; minimum enforced by parser
  next_wake_at: string;              // ISO-8601 timestamp
  last_wake_at?: string;
  last_report_at?: string;
  parent_task_id?: string;           // upstream task that spawned this goal
  codex_thread_id?: string;          // populated on `thread.started` (Phase 2)
  runtime: string;                   // e.g. "codex-sdk" / "claude-agent-sdk"
  created_at: string;
  updated_at: string;
  progress_log: GoalProgressEntry[];
}

export interface GoalsFile {
  version: 1;
  goals: AgentGoal[];
}

export const GOALS_SCHEMA_VERSION = 1 as const;
