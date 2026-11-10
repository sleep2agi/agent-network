// #2668 —— 投给**已离线**节点的任务不该躺满 24 小时。
//
// 现场（2026-10-27，生产）：
//   任务 3b3c63e0 → TM基建鲸，投递后目标 session 立刻 offline，任务以 `delivered` 状态挂了 **2 小时 56 分**；
//   10 分钟 / 30 分钟两档告警都按时报了，然后**没有任何处置**；`expires_at` 是创建后 24 小时。
//   同期队列里还有几个同类任务。
//
// 为什么这是问题（三条，都实测过）：
//   1. 队列里挂着**不可能被执行**的任务（目标不在），却计入“在途/积压”；与 #2363 的 in-flight 判读混在一起；
//   2. 发送方（常常是另一个 Agent）在自己 30 分钟超时后早已放弃，Hub 侧看起来还在“投递中”；
//   3. 目标重新上线后会消费这个陈旧任务 —— 可能做三小时前的工作。
//
// 本模块只做一件最小的事：**目标明确不在（session=offline 或没有 session 行）且投递已超过 TTL** ⇒ 过期。
// 「目标忙」不算（那走 queued_behind_busy，不做处置）；`created` 状态不算（还没投递）；
// 已经被节点取走（`consumed_at` 有值）的不算（那是节点在处理，交给 #758 的 orphan 判据）。

import { db } from "./db.js";

export const OFFLINE_DELIVERY_TTL_ENV = "COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES";
export const OFFLINE_DELIVERY_TTL_DEFAULT_MINUTES = 30;

export function offlineDeliveryTtlMinutes(): number {
  const raw = process.env[OFFLINE_DELIVERY_TTL_ENV];
  if (raw === undefined || raw.trim() === "") return OFFLINE_DELIVERY_TTL_DEFAULT_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : OFFLINE_DELIVERY_TTL_DEFAULT_MINUTES;
}

export type OfflineDroppedTask = {
  task_id: string;
  network_id: string | null;
  from_name: string | null;
  from_node_id: string | null;
  to_name: string | null;
  content: string;
  created_at: string;
  expires_at: string | null;
  parent_task_id: string | null;
  meta_json: string | null;
  waited_minutes: number;
};

/**
 * 找出并过期「投给离线目标的陈年投递」。返回被过期的行（调用方负责发事件与通知，与 TTL 那条路径一致）。
 * 同步执行：调用点在 5 分钟一次的 patrol 里，单次量级是几十行。
 */
export function expireDeliveredToOfflineTargets(now = new Date()): OfflineDroppedTask[] {
  const ttl = offlineDeliveryTtlMinutes();
  if (ttl <= 0) return [];
  const nowIso = now.toISOString();
  const ageClause = `datetime(delivered_at) <= datetime(?1, '-${ttl} minutes')`;

  const due = db.all<OfflineDroppedTask>(
    `SELECT t.task_id, t.network_id, t.from_name, t.from_node_id, t.to_name, t.content,
            t.created_at, t.expires_at, t.parent_task_id, t.meta_json,
            CAST((julianday(?1) - julianday(t.delivered_at)) * 1440 AS INTEGER) AS waited_minutes
       FROM tasks t
      WHERE t.status = 'delivered'
        AND t.delivered_at IS NOT NULL
        AND t.consumed_at IS NULL
        AND ${ageClause}
        AND COALESCE((SELECT s.status FROM sessions s
                       WHERE s.alias = t.to_name AND s.network_id = t.network_id), 'offline') = 'offline'`,
    [nowIso],
  );
  if (due.length === 0) return [];

  const dropped: OfflineDroppedTask[] = [];
  for (const task of due) {
    const changed = db.run(
      `UPDATE tasks SET status = 'expired', completed_at = datetime('now')
        WHERE task_id = ?1 AND status = 'delivered' AND consumed_at IS NULL`,
      [task.task_id],
    );
    if (changed.changes < 1) continue;
    // 与 TTL 过期一致：把 inbox 行 ack 掉，否则 unread 徽标与 stop/delete 门会一直看到它。
    db.run(`UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1 AND acked = 0`, [task.task_id]);
    dropped.push(task);
  }
  return dropped;
}
