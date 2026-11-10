// #1511 — 「本节点正在做的工作」的唯一计数口径（任务在飞，不是 MCP 请求在飞 ——
// 后者见 mcp-inflight.ts，两者无关，别混）。
//
// 为什么单独一个模块：stop_node 与 restart_node 两个闸门必须用**同一份 SQL**，
// 客户端要显示的 `restart_readiness.in_flight` 也只能来自这里。
// 三处各自写一份 SQL 会漂移，而漂移的后果是「客户端说空闲、实际拒绝重启」。
//
// 计数规则（#2022/#2029 修订，判据本身未变）：
//   · 只算能成为「本节点正在做的工作」的行：`inbox.acked = 0` 且是本会话；
//   · tasks 行按状态判，终态（replied/failed/cancelled/expired）不算，且**不设龄上限**；
//   · 没有对应 tasks 行的（无状态）按 60 分钟龄判，超过就不算。
import { db } from "./db.js";

export const IN_FLIGHT_MAX_AGE_MINUTES = 60;

export function countInFlightTasks(alias: string, networkId: string | null): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM inbox i
       LEFT JOIN tasks t
         ON i.type = 'task'
        AND t.task_id = COALESCE(i.task_id, i.id)
      WHERE i.session_name = ?1 AND i.acked = 0
        AND COALESCE(i.network_id, ?2) = ?2
        AND ((t.task_id IS NOT NULL
              AND t.status NOT IN ('replied', 'failed', 'cancelled', 'expired'))
          OR (t.task_id IS NULL
              AND i.created_at >= datetime('now', ?3)))`,
    alias, networkId, `-${IN_FLIGHT_MAX_AGE_MINUTES} minutes`,
  );
  return row?.n ?? 0;
}
