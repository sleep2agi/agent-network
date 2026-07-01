// RFC-025 P1.1 — pure renderers for `anet goal wake-log`.
//
// Extracted from cli.ts so unit tests can import these functions
// without triggering cli.ts's top-level command dispatch (which
// prints help text on any load with no args). Zero I/O, zero
// state; just goal shape → string/object shape.

export interface WakeLogEntryShape {
  ts?: string;
  status?: string;
  summary?: string;
  task_id?: string;
}

export interface WakeLogGoalShape {
  goal_id: string;
  progress_log?: WakeLogEntryShape[];
}

export interface WakeLogRenderOpts {
  /** Trim to the last N entries. undefined = all. */
  tail?: number;
}

/**
 * Format progress_log as a JSON object suitable for `--json` output.
 * Pure. Never reads/writes filesystem. Legacy goals without
 * progress_log render as empty array (not error).
 */
export function renderWakeLogJson(
  goal: WakeLogGoalShape,
  opts: WakeLogRenderOpts = {},
): { goal_id: string; total: number; returned: number; entries: WakeLogEntryShape[] } {
  const all = Array.isArray(goal.progress_log) ? goal.progress_log : [];
  const entries = typeof opts.tail === "number" && opts.tail > 0 ? all.slice(-opts.tail) : all;
  return {
    goal_id: goal.goal_id,
    total: all.length,
    returned: entries.length,
    entries,
  };
}

/**
 * Format progress_log as a table for human console output.
 * Column layout mirrors printGoalShow so the two commands read
 * consistently. Empty log renders a single "(none)" line, not an error.
 */
export function renderWakeLogText(
  goal: WakeLogGoalShape,
  opts: WakeLogRenderOpts = {},
): string {
  const all = Array.isArray(goal.progress_log) ? goal.progress_log : [];
  const entries = typeof opts.tail === "number" && opts.tail > 0 ? all.slice(-opts.tail) : all;
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Goal:     ${goal.goal_id}`);
  if (all.length === 0) {
    lines.push("  Progress: (none)");
    lines.push("");
    return lines.join("\n");
  }
  const suffix = entries.length < all.length
    ? ` (showing last ${entries.length} of ${all.length})`
    : ` (${all.length} total)`;
  lines.push(`  Progress${suffix}:`);
  for (const entry of entries) {
    const ts = (entry.ts || "").slice(0, 19).padEnd(19);
    const st = (entry.status || "").padEnd(13);
    const sm = (entry.summary || "").replace(/\s+/g, " ").slice(0, 100);
    lines.push(`    ${ts}  ${st}  ${sm}`);
  }
  lines.push("");
  return lines.join("\n");
}
