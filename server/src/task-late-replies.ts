import type { DbAdapter } from "./db-adapter";

type StoredLateReply = {
  late_reply_id: string;
  task_id: string;
  from_node_id: string;
  thread_id: string;
  turn_id: string;
  status: "replied" | "failed" | "cancelled";
  result: string;
  meta_json: string | null;
  created_at: string;
};

function parsedMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Stable detail projection. Storage routing ids stay private. */
export function listTaskLateReplies(database: DbAdapter, taskId: string, networkId: string | null) {
  const params: unknown[] = [taskId];
  let sql = `SELECT late_reply_id,task_id,from_node_id,thread_id,turn_id,status,result,meta_json,created_at
    FROM task_late_replies WHERE task_id=?1`;
  if (networkId) {
    params.push(networkId);
    sql += " AND network_id=?2";
  } else {
    sql += " AND network_id IS NULL";
  }
  sql += " ORDER BY created_at,late_reply_id";
  return database.all<StoredLateReply>(sql, ...params).map((row) => {
    const meta = parsedMeta(row.meta_json);
    return {
      late_reply_id: row.late_reply_id,
      task_id: row.task_id,
      from_node_id: row.from_node_id,
      thread_id: row.thread_id,
      turn_id: row.turn_id,
      status: row.status,
      result: row.result,
      created_at: row.created_at,
      late: true as const,
      ...(meta ? { meta } : {}),
    };
  });
}
