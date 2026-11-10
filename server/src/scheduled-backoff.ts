import { db } from "./db.js";

type WakeHook = (id: string, network: string, now: Date) => boolean;
let requirementWakeHook: WakeHook | null = null;
export function setRequirementWakeHook(hook: WakeHook): void { requirementWakeHook = hook; }

export function parseBackoffPolicy(raw: unknown, type: string, fallback = false): boolean {
  if (raw !== undefined && typeof raw !== "boolean") throw new Error("invalid_no_change_backoff");
  const enabled = raw === undefined ? fallback : raw as boolean;
  if (enabled && type !== "interval") throw new Error("no_change_backoff_requires_interval");
  return enabled;
}

/** SQLite only. Called in the reply/dispatch transaction; no catch-and-continue
 * on state-write failure. Deriving a capped streak from authoritative runs
 * makes duplicate or out-of-order callbacks unable to increment it twice. */
export function refreshScheduledBackoff(scheduleId: string, networkId: string, now = new Date()): void {
  if (db.transactionalFeaturesRefusal !== null) return;
  if (requirementWakeHook?.(scheduleId, networkId, now)) return;
  const row = db.get<any>(`SELECT status, revision, target_node_id, schedule_json,
    no_change_backoff, overlap_policy, requirement_wake_json, backoff_streak, backoff_effective_seconds,
    backoff_last_run_id, next_run_at FROM scheduled_tasks
    WHERE schedule_id = ?1 AND network_id = ?2`, scheduleId, networkId);
  if (!row || row.status !== "active" || row.no_change_backoff !== 1 || row.overlap_policy !== "skip") return;
  // A DB-only process with no watcher loaded may not bypass its fence.
  if (row.requirement_wake_json && !requirementWakeHook) return;
  const spec = JSON.parse(row.schedule_json);
  if (spec.type !== "interval") return;
  // Include failures/skips/unknowns: excluding them would turn separated
  // successes into a fictitious consecutive empty sequence. Six is a cap.
  const runs = db.all<any>(`SELECT r.run_id, r.status, r.work_outcome,
    r.schedule_revision, r.work_outcome_node_id, r.backoff_excluded,
    t.status AS task_status, t.to_node_id, t.from_name
    FROM scheduled_task_runs r LEFT JOIN tasks t
      ON t.task_id = r.task_id AND t.network_id = r.network_id
    WHERE r.schedule_id = ?1 AND r.network_id = ?2
    ORDER BY r.scheduled_for DESC, r.created_at DESC, r.run_id DESC LIMIT 6`, scheduleId, networkId);
  const latest = runs[0];
  if (!latest || latest.schedule_revision !== row.revision
    || latest.run_id === row.backoff_last_run_id
    || ["claiming", "queued", "delivered"].includes(latest.status)) return;
  let streak = 0;
  for (const run of runs) {
    if (run.schedule_revision !== row.revision || run.status !== "replied"
      || run.task_status !== "replied" || run.work_outcome !== "no_changes"
      || run.work_outcome_node_id !== row.target_node_id || run.to_node_id !== row.target_node_id
      || run.from_name !== "scheduler" || run.backoff_excluded !== 0) break;
    streak++;
  }
  const effective = Math.max(spec.every_seconds, streak >= 6 ? 1800 : streak >= 3 ? 600 : 0);
  const previous = row.backoff_effective_seconds ?? spec.every_seconds;
  let next = row.next_run_at;
  if (effective !== previous && next) {
    const candidate = now.getTime() + effective * 1000;
    next = new Date(effective > previous ? Math.max(Date.parse(next), candidate)
      : Math.min(Date.parse(next), candidate)).toISOString();
  }
  const result = db.run(`UPDATE scheduled_tasks SET backoff_streak = ?1,
    backoff_effective_seconds = ?2, backoff_last_run_id = ?3, next_run_at = ?4,
    updated_at = datetime('now') WHERE schedule_id = ?5 AND network_id = ?6
    AND revision = ?7 AND status = 'active' AND no_change_backoff = 1`,
    [streak, effective, latest.run_id, next, scheduleId, networkId, row.revision]);
  if (result.changes !== 1) throw new Error("scheduled_backoff_atomic_write_failed");
}
