import { db } from "./db.js";
import { resolveNodeCaller } from "./create-node.js";

type Context = { task_id: string; thread_id: string; turn_id: string };

/** Renew only an already-consumed, exact original turn. No alias/content/heartbeat inference. */
export function markTaskActivity(input: {
  tokenId: string | null | undefined;
  networkId: string | null | undefined;
  nodeToken: boolean;
  identityRejected: boolean;
  taskIds: string[];
  contexts: Context[];
}) {
  const deny = (error: string, task_id?: string) => ({ ok: false as const, error, ...(task_id ? { task_id } : {}) });
  if (!input.nodeToken || !input.networkId || input.identityRejected) return deny("node_token_required");
  if (db.transactionalFeaturesRefusal !== null) return deny("task_runtime_evidence_backend_unsupported");
  if (new Set(input.taskIds).size !== input.taskIds.length) return deny("duplicate_task_id");
  const contexts = new Map(input.contexts.map((c) => [c.task_id, c]));
  if (contexts.size !== input.contexts.length) return deny("duplicate_task_context");
  const foreign = input.contexts.find((c) => !input.taskIds.includes(c.task_id));
  if (foreign) return deny("task_context_not_requested", foreign.task_id);
  const missing = input.taskIds.find((id) => !contexts.has(id));
  if (missing) return deny("task_activity_context_required", missing);

  return db.transaction(() => {
    // Resolve inside the transaction: renamed sessions and same-name rows cannot substitute for the token.
    const caller = resolveNodeCaller(input.tokenId);
    if (!caller.ok || caller.kind !== "node" || caller.networkId !== input.networkId) return deny("node_token_required");
    const placeholders = input.taskIds.map((_, i) => `?${i + 2}`).join(", ");
    const rows = db.all<{ task_id: string; to_node_id: string | null; status: string; consumed_at: string | null; thread_id: string | null; turn_id: string | null }>(
      `SELECT task_id, to_node_id, status, consumed_at, thread_id, turn_id FROM tasks
       WHERE network_id = ?1 AND task_id IN (${placeholders})`, input.networkId, ...input.taskIds,
    );
    const byId = new Map(rows.map((row) => [row.task_id, row]));
    for (const id of input.taskIds) {
      const row = byId.get(id);
      if (!row || row.to_node_id !== caller.nodeId) return deny("task_not_owned", id);
      if (!["created", "delivered", "acked", "running"].includes(row.status)) return deny("task_activity_terminal", id);
      if (!row.consumed_at || !row.thread_id || !row.turn_id) return deny("task_activity_not_consumed", id);
      const context = contexts.get(id)!;
      if (row.thread_id !== context.thread_id || row.turn_id !== context.turn_id) return deny("task_runtime_context_conflict", id);
    }
    for (const id of input.taskIds) {
      const context = contexts.get(id)!;
      const changed = db.run(
        `UPDATE tasks SET last_activity_at = datetime('now')
         WHERE task_id = ?1 AND network_id = ?2 AND to_node_id = ?3
           AND thread_id = ?4 AND turn_id = ?5 AND consumed_at IS NOT NULL
           AND status IN ('created', 'delivered', 'acked', 'running')`,
        [id, input.networkId, caller.nodeId, context.thread_id, context.turn_id],
      );
      if (changed.changes !== 1) throw new Error(`task_activity_write_race:${id}`);
    }
    return { ok: true as const, tasks: db.all<{ task_id: string; last_activity_at: string }>(
      `SELECT task_id, last_activity_at FROM tasks WHERE network_id = ?1 AND task_id IN (${placeholders})`,
      input.networkId, ...input.taskIds,
    ) };
  });
}
