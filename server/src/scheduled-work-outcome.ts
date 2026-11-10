import { db } from "./db.js";

export type ScheduledWorkOutcome = "changed" | "no_changes";
export function parseScheduledWorkOutcome(meta: unknown, status: string):
  { ok: true; outcome?: ScheduledWorkOutcome } | { ok: false; error: string } {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)
    || !Object.hasOwn(meta, "scheduled_work_outcome")) return { ok: true };
  const outcome = (meta as Record<string, unknown>).scheduled_work_outcome;
  if (outcome !== "changed" && outcome !== "no_changes")
    return { ok: false, error: "invalid_scheduled_work_outcome" };
  if (status !== "replied") return { ok: false, error: "scheduled_work_outcome_requires_success" };
  return { ok: true, outcome };
}

type Binding = { run_id: string; schedule_id: string; task_id: string; network_id: string; node_id: string };
/** Called within the normal reply transaction, after the existing sender and
 * recipient checks. Caller metadata never supplies schedule/run bindings. */
export function qualifyScheduledWorkOutcome(taskId: string, networkId: string, nodeId: string | null):
  { ok: true; binding: Binding } | { ok: false; error: string } {
  if (!nodeId) return { ok: false, error: "scheduled_work_outcome_bound_node_required" };
  if (db.transactionalFeaturesRefusal !== null)
    return { ok: false, error: "scheduled_work_outcome_backend_unsupported" };
  const task = db.get<{ to_node_id: string | null; from_name: string; status: string }>(
    "SELECT to_node_id, from_name, status FROM tasks WHERE task_id = ?1 AND network_id = ?2", taskId, networkId);
  if (!task || task.to_node_id !== nodeId || task.from_name !== "scheduler"
    || !["created", "delivered", "acked", "running"].includes(task.status))
    return { ok: false, error: "scheduled_work_outcome_task_not_owned" };
  const runs = db.all<{ run_id: string; schedule_id: string; status: string; work_outcome: string | null }>(
    `SELECT r.run_id, r.schedule_id, r.status, r.work_outcome FROM scheduled_task_runs r
     WHERE r.task_id = ?1 AND r.network_id = ?2`, taskId, networkId);
  if (runs.length !== 1 || !["queued", "delivered"].includes(runs[0].status) || runs[0].work_outcome !== null)
    return { ok: false, error: "scheduled_work_outcome_run_unresolved" };
  if (!db.get("SELECT schedule_id FROM scheduled_tasks WHERE schedule_id = ?1 AND network_id = ?2", runs[0].schedule_id, networkId))
    return { ok: false, error: "scheduled_work_outcome_run_unresolved" };
  return { ok: true, binding: { run_id: runs[0].run_id, schedule_id: runs[0].schedule_id,
    task_id: taskId, network_id: networkId, node_id: nodeId } };
}

/** The task has just reached replied in this same transaction. An outcome
 * write failure must roll back task, inbox and run together. No cadence write. */
export function saveScheduledWorkOutcome(binding: Binding, outcome: ScheduledWorkOutcome): void {
  const result = db.run(
    `UPDATE scheduled_task_runs SET work_outcome = ?1, work_outcome_node_id = ?6
     WHERE run_id = ?2 AND schedule_id = ?3 AND task_id = ?4 AND network_id = ?5
       AND work_outcome IS NULL AND status IN ('queued', 'delivered')
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = ?4 AND t.network_id = ?5
                   AND t.to_node_id = ?6 AND t.from_name = 'scheduler' AND t.status = 'replied')`,
    [outcome, binding.run_id, binding.schedule_id, binding.task_id, binding.network_id, binding.node_id]);
  if (result.changes !== 1) throw new Error("scheduled_work_outcome_atomic_write_failed");
}
