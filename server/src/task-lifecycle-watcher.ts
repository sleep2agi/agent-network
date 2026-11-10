import { db } from "./db.js";
import { ALIAS_BASELINE_TABLE, BASELINE_MAX_SECONDS, BASELINE_P99_FACTOR, ensureAliasBaselineTable } from "./alias-baseline.js";

export const DELIVERED_STALE_THRESHOLDS = [600, 1800] as const;

export type DeliveredStalePatrolResult = {
  inserted: number;
  by_threshold_seconds: Record<(typeof DELIVERED_STALE_THRESHOLDS)[number], number>;
};

function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// #2571（第二轮）—— 阈值从 30s/60s 提到 10min/30min。
//
// 第一轮只做了“按目标忙/闲分流”，上线后（19:45–22:30）实测**告警量反而翻倍**
// （33/h → 73/h，33/h → 104/h），因为同一个任务会先在忙时写 busy、目标转闲后
// 再写一次 stale（46 个任务两类都出现）。而被标 stale 的任务里仍有 73.5%
// 最终成功。真正的病因不是“忙 vs 闲”，是**阈值本身离真实分布太远**：
// 7 天 11877 个成功任务，delivered → 首次活动 p50 = 1 秒、p90 = 6 秒、
// p95 = 57 秒、p99 = 12 分钟。
// ⇒ 30 秒的判据会命中 6.4% 的**正常**任务，60 秒命中 4.9%，等于把 p95–p99
//   的长尾全报警。改成 10 分钟（p99 之下）才有意义：超过它的比例 1.2%，
//   30 分钟是 0.2%，只留真异常。
//
// event_key 里带秒数 ⇒ 改阈值会产生新的 key，历史事件不受影响、可并存对比。
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
function thresholdLabel(thresholdSeconds: 600 | 1800): string {
  return thresholdSeconds === 600 ? "10m" : "30m";
}

function recordStale(thresholdSeconds: 600 | 1800, cutoff: string, referenceIso: string): number {
  const busyType = `task.warning.queued_behind_busy_${thresholdSeconds}s`;
  const staleType = `task.warning.delivered_stale_${thresholdSeconds}s`;
  const label = thresholdLabel(thresholdSeconds);
  const busyDetail = `queued after ${label}; target is working on another task`;
  const staleDetail = thresholdSeconds === 600
    ? `still delivered after ${label}; target is not working on another task and has not started`
    : `still delivered after ${label}; target is idle or offline and not consuming`;
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
     -- 这个子查询把列名改成 b_* 前缀：SELECT 列表里的 network_id 必须继续是 tasks 的
     -- （test683 的 L9 变异门用 network_id + FROM tasks 相邻两行当锚点，裸列名一改锚点就失效）。
     LEFT JOIN (SELECT alias AS b_alias, network_id AS b_network, p99_seconds AS b_p99
                  FROM alias_latency_baseline) b
            ON b.b_alias = tasks.to_name AND b.b_network = tasks.network_id
     WHERE status = 'delivered'
       AND delivered_at IS NOT NULL
       AND delivered_at <= ?3
       -- #2571 第三轮：目标自己的 p99 基线比全局下限更宽时，用它（全队变慢不炸屏，
       -- 单节点卡住仍会显形）。没有基线行 ⇒ 与 .163 行为完全一致。
       AND (
         b.b_p99 IS NULL
         OR delivered_at <= datetime(?8, '-' || CAST(b.b_p99 * 1.5 AS INTEGER) || ' seconds')
         -- 上限：再慢的节点，等满 30 分钟也必须报（否则 p99=50min 的节点永远不响）。
         OR delivered_at <= datetime(?8, '-' || CAST(?9 AS INTEGER) || ' seconds')
       )
     ON CONFLICT(task_id, event_key) DO NOTHING`,
    [staleType, staleDetail, cutoff, busyType, staleType, busyDetail, staleDetail, referenceIso, BASELINE_MAX_SECONDS],
  );
  return result.changes;
}

export function recordDeliveredStaleEvents(now = new Date()): DeliveredStalePatrolResult {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid lifecycle patrol time");

  ensureAliasBaselineTable();
  const byThreshold = { 600: 0, 1800: 0 };
  let inserted = 0;

  for (const thresholdSeconds of DELIVERED_STALE_THRESHOLDS) {
    const cutoff = sqliteUtcTimestamp(new Date(now.getTime() - thresholdSeconds * 1000));
    const changes = recordStale(thresholdSeconds, cutoff, now.toISOString());
    byThreshold[thresholdSeconds] = changes;
    inserted += changes;
  }

  return { inserted, by_threshold_seconds: byThreshold };
}
