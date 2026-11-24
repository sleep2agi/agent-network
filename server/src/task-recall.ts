// #5502 —— 聊天消息撤回（未回复任务原子撤单 + 写 meta_json.recalled 标记）。
import type { db as HubDb } from "./db.js";
import { logTaskEvent, syncScheduledRunForTask } from "./db.js";

const RECALLABLE_STATUSES = new Set(["created", "delivered", "acked", "running"]);

export interface RecallableTaskRow {
  task_id: string;
  from_node_id?: string | null;
  from_name?: string | null;
  to_node_id?: string | null;
  to_name?: string | null;
  status: string;
  result?: string | null;
  meta_json?: string | null;
  network_id?: string | null;
}

export type RecallTaskOutcome =
  | {
      ok: true;
      recalled: true;
      already_recalled: boolean;
      task_id: string;
      previous_status: string;
      recalled_at: string | null;
    }
  | {
      ok: false;
      httpStatus: 409;
      error: "task_already_terminal";
      task_id: string;
      task_status: string;
    };

function parseMetaObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function isMetaRecalled(raw: string | null | undefined): { recalled: boolean; recalled_at: string | null } {
  const meta = parseMetaObject(raw);
  if (meta.recalled === true) {
    return {
      recalled: true,
      recalled_at: typeof meta.recalled_at === "string" ? meta.recalled_at : null,
    };
  }
  return { recalled: false, recalled_at: null };
}

/**
 * 原子撤回一条未终结任务：
 * - 已撤回 ⇒ 幂等返回 ok:true, already_recalled:true；
 * - 已终结（replied/failed/expired/普通 cancelled）⇒ 409 task_already_terminal；
 * - 排队或运行中（created/delivered/acked/running）⇒ 同事务内把 tasks.status 置 cancelled、
 *   保留现有 meta_json 并写入 recalled/recalled_at/recalled_by、ack 对应 inbox 行防 Agent 再领走。
 */
export function recallTaskRecord(
  database: typeof HubDb,
  opts: { task: RecallableTaskRow; actor: string; now?: Date },
): RecallTaskOutcome {
  const { task, actor } = opts;
  const already = isMetaRecalled(task.meta_json);
  if (already.recalled) {
    return {
      ok: true,
      recalled: true,
      already_recalled: true,
      task_id: task.task_id,
      previous_status: task.status,
      recalled_at: already.recalled_at,
    };
  }
  if (!RECALLABLE_STATUSES.has(task.status)) {
    return {
      ok: false,
      httpStatus: 409,
      error: "task_already_terminal",
      task_id: task.task_id,
      task_status: task.status,
    };
  }

  const recalledAt = (opts.now ?? new Date()).toISOString();
  const nextMeta = JSON.stringify({
    ...parseMetaObject(task.meta_json),
    recalled: true,
    recalled_at: recalledAt,
    recalled_by: actor,
  });

  const netId = typeof task.network_id === "string" && task.network_id ? task.network_id : null;
  const updatedChanges = database.transaction(() => {
    const updateParams: unknown[] = [nextMeta, task.task_id];
    let updateSql = `UPDATE tasks SET status = 'cancelled', completed_at = datetime('now'), meta_json = ?1
       WHERE task_id = ?2 AND status IN ('created', 'delivered', 'acked', 'running')`;
    if (netId) {
      updateSql += ` AND network_id = ?3`;
      updateParams.push(netId);
    }
    const updated = database.run(updateSql, updateParams);
    if (updated.changes > 0) {
      const inboxParams: unknown[] = [task.task_id];
      let inboxSql = "UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1 AND acked = 0";
      if (netId) {
        inboxSql += " AND network_id = ?2";
        inboxParams.push(netId);
      }
      database.run(inboxSql, inboxParams);
      syncScheduledRunForTask(task.task_id, netId);
    }
    return updated.changes;
  });

  if (updatedChanges === 0) {
    const fresh = database.get<{ status: string; meta_json: string | null }>(
      "SELECT status, meta_json FROM tasks WHERE task_id = ?1 LIMIT 1",
      task.task_id,
    );
    const freshRecalled = isMetaRecalled(fresh?.meta_json);
    if (freshRecalled.recalled) {
      return {
        ok: true,
        recalled: true,
        already_recalled: true,
        task_id: task.task_id,
        previous_status: fresh?.status ?? task.status,
        recalled_at: freshRecalled.recalled_at,
      };
    }
    return {
      ok: false,
      httpStatus: 409,
      error: "task_already_terminal",
      task_id: task.task_id,
      task_status: fresh?.status ?? task.status,
    };
  }

  logTaskEvent(task.task_id, task.status, "cancelled", actor, "recalled");
  return {
    ok: true,
    recalled: true,
    already_recalled: false,
    task_id: task.task_id,
    previous_status: task.status,
    recalled_at: recalledAt,
  };
}
