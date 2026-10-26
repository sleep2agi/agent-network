import { db } from "./db.js";

export const DELIVERED_STALE_THRESHOLDS = [30, 60] as const;

export type DeliveredStalePatrolResult = {
  inserted: number;
  by_threshold_seconds: Record<(typeof DELIVERED_STALE_THRESHOLDS)[number], number>;
};

function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Persist Hub-authoritative warnings for tasks which are still delivered.
 *
 * The task row, not an agent-local timer, is the source of truth. event_key is
 * equal to the stable event name and protected by a unique index, so every
 * threshold is write-once across restarts, patrols, and multiple Hub workers.
 */
/**
 * #2571 —— 把「慢」和「坏」分开：目标正在跑别的任务时，事件写成 `queued_behind_busy_*`；
 * 目标空闲/离线/未知时，才写成 `delivered_stale_*`。
 *
 * 为什么是一条 SQL（而不是两条 INSERT）：`test683` 的 mutation 门用**字符串锚点**钉住
 * “write-once 冲突门”“只认 delivered”“网络字段透传”三件事；拆成两条 INSERT 会让锚点
 * 命中次数变成 0 或让 mutation 只命中一半 —— 那就把“可被变异测试覆盖”这条性质弄丢了。
 * 因此这里仍然只保留**一条** INSERT，用 CASE 选择事件名与文案。
 */
function recordStale(thresholdSeconds: 30 | 60, cutoff: string): number {
  const busyType = `task.warning.queued_behind_busy_${thresholdSeconds}s`;
  const staleType = `task.warning.delivered_stale_${thresholdSeconds}s`;
  const busyDetail = `queued after ${thresholdSeconds}s; target is working on another task`;
  const staleDetail = thresholdSeconds === 30
    ? "still delivered after 30s; target is not working on another task and has not started"
    : "still delivered after 60s; target is idle or offline and not consuming";
  const result = db.run(
    `INSERT INTO task_events
       (task_id, from_status, to_status, event_type, event_key, actor, detail, network_id)
     SELECT task_id, 'delivered', 'delivered',
            CASE WHEN COALESCE((SELECT s.status FROM sessions s
                                  WHERE s.alias = tasks.to_name AND s.network_id = tasks.network_id), 'unknown') = 'working'
                 THEN ?4 ELSE ?5 END,
            CASE WHEN COALESCE((SELECT s.status FROM sessions s
                                  WHERE s.alias = tasks.to_name AND s.network_id = tasks.network_id), 'unknown') = 'working'
                 THEN ?4 ELSE ?5 END,
            'patrol',
            CASE WHEN COALESCE((SELECT s.status FROM sessions s
                                  WHERE s.alias = tasks.to_name AND s.network_id = tasks.network_id), 'unknown') = 'working'
                 THEN ?6 ELSE ?7 END,
            network_id
     FROM tasks
     WHERE status = 'delivered'
       AND delivered_at IS NOT NULL
       AND delivered_at <= ?3
     ON CONFLICT(task_id, event_key) DO NOTHING`,
    [staleType, staleDetail, cutoff, busyType, staleType, busyDetail, staleDetail],
  );
  return result.changes;
}

export function recordDeliveredStaleEvents(now = new Date()): DeliveredStalePatrolResult {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid lifecycle patrol time");

  const byThreshold = { 30: 0, 60: 0 };
  let inserted = 0;

  for (const thresholdSeconds of DELIVERED_STALE_THRESHOLDS) {
    const cutoff = sqliteUtcTimestamp(new Date(now.getTime() - thresholdSeconds * 1000));
    const changes = recordStale(thresholdSeconds, cutoff);
    byThreshold[thresholdSeconds] = changes;
    inserted += changes;
  }

  return { inserted, by_threshold_seconds: byThreshold };
}
