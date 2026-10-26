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
 * #2571 —— 写一条 stale 事件，按目标节点**此刻**的状态做过滤。
 *
 * `only` 取值：
 *   - "working"     → 只命中「目标正在跑别的任务」的任务；
 *   - "not-working" → 只命中「目标不在跑（idle/offline/未知）」的任务。
 *
 * 保持不变的两件事：event_key 唯一（每个阈值只写一次）、只对 `status='delivered'` 写。
 */
function recordStale(
  thresholdSeconds: number,
  eventType: string,
  detail: string,
  cutoff: string,
  only: "working" | "not-working",
): number {
  const statusExpr = `COALESCE((SELECT s.status FROM sessions s
                               WHERE s.alias = t.to_name AND s.network_id = t.network_id), 'unknown')`;
  const predicate = only === "working" ? `${statusExpr} = 'working'` : `${statusExpr} <> 'working'`;
  const result = db.run(
    `INSERT INTO task_events
       (task_id, from_status, to_status, event_type, event_key, actor, detail, network_id)
     SELECT t.task_id, 'delivered', 'delivered', ?1, ?1, 'patrol', ?2, t.network_id
     FROM tasks t
     WHERE t.status = 'delivered'
       AND t.delivered_at IS NOT NULL
       AND t.delivered_at <= ?3
       AND ${predicate}
     ON CONFLICT(task_id, event_key) DO NOTHING`,
    [eventType, detail, cutoff],
  );
  return result.changes;
}

export function recordDeliveredStaleEvents(now = new Date()): DeliveredStalePatrolResult {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid lifecycle patrol time");

  const byThreshold = { 30: 0, 60: 0 };
  let inserted = 0;

  for (const thresholdSeconds of DELIVERED_STALE_THRESHOLDS) {
    const cutoff = sqliteUtcTimestamp(new Date(now.getTime() - thresholdSeconds * 1000));
    // #2571 —— 关键区别：**“慢”与“坏”不是一回事**。
    // 生产实测（24h）：出现过 delivered_stale 的任务里 83% 最终成功；等待中位数 2.9 分钟、
    // p90 27 分钟——**事件事实成立，但把“目标正忙着跑别的任务”写成“可能离线”会制造告警疲劳**。
    // 因此按目标节点**告警时刻**的状态分两类：
    //   · working（含 busy 语义）→ 归入 `queued_behind_busy_*`：这是排队，不是故障；
    //   · idle / offline / unknown → 保留 `delivered_stale_*`：空闲却不消费、或掉线，都值得人看。
    // 两类都**照常写事件**（不静默真实延迟），只是让仪表盘/值班可以分别过滤。
    const busy = recordStale(
      thresholdSeconds,
      `task.warning.queued_behind_busy_${thresholdSeconds}s`,
      `queued after ${thresholdSeconds}s; target is working on another task`,
      cutoff,
      "working",
    );
    const stale = recordStale(
      thresholdSeconds,
      `task.warning.delivered_stale_${thresholdSeconds}s`,
      thresholdSeconds === 30
        ? "still delivered after 30s; target is not working on another task and has not started"
        : "still delivered after 60s; target is idle or offline and not consuming",
      cutoff,
      "not-working",
    );
    byThreshold[thresholdSeconds] = busy + stale;
    inserted += busy + stale;
  }

  return { inserted, by_threshold_seconds: byThreshold };
}
