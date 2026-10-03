// #519 —— 已开工(acked / running)却再也没有动静的任务,巡检把它结束为 expired。**默认关闭。**
//
// TTL 巡检(server.ts patrolExpiredTasks)从第一版起只看 created / delivered。任务一旦被 ack,
// 除非执行者带着这个 task_id 回终态(send_reply / report_completion / cancel_task),什么都不会再结束它:
//   - claude-code channel 注入任务后立刻 ack_inbox,模型用 send_task 回了对方却没有 commhub_reply 收尾;
//   - agent-node 跳过的任务(自派 / 低价值回复)也只 ack 不回;
//   - running 的那一轮中途重启,回复再也没来。
// 这些行永远留在 acked / running,在 App「正在运行」里显示「N 天」,在 /api/stats 里堆成几万。
//
// 规则(COMMHUB_STALE_OPEN_TASK_HOURS = H,> 0 才启用;建议 72):
//   status ∈ {acked, running},且「最近一次动静」早于 H 小时前 → status = expired,completed_at = now,
//   result(原来是空的才写)= "stale: no activity for <H>h (was <status>) — closed by hub patrol (#519)"。
//   最近一次动静 = created_at / delivered_at / started_at / consumed_at / runtime_submitted_at
//   和这条任务最新一条 task_events 的最大值。写成「每一列都早于截止点 + 没有更晚的事件」,
//   不用标量 MAX/GREATEST:SQLite 与 PostgreSQL 写法一致,NULL 列不参与。
//   - 每次巡检最多 STALE_OPEN_BATCH_LIMIT(500)行,最老的先结束;积压分多次巡检排空。
//   - 每行一个带同样条件的 UPDATE(守卫):选中之后又有动静 / 被回复了的行不会被改。
//   - 同一事务里把该任务的 inbox 行置 acked、同步定时任务运行行。
//   - task_events 记一条 event_type = task.stale_expired(不是 task.expired:统计「TTL 过期」的口径不变)。
//   - **不通知派活的一方**(多数情况下对方早已用 send_task 收到了答复;几天后再来一条通知只是噪音),
//     **不走 chainReplyToParent**(不改父任务)。
//   - 之后对这条任务的 send_reply 按现状被拒(reply_task_terminal),与任何终态任务一样。
//
// 为什么默认关:打开的那一刻会把历史积压一并结束(生产库上万行,且是与别的团队共享的 Hub)——
// 什么时候打开由 Hub 的负责人决定。

import { db, syncScheduledRunForTask } from "./db.js";

export const STALE_OPEN_TASK_ENV = "COMMHUB_STALE_OPEN_TASK_HOURS";
export const STALE_OPEN_RECOMMENDED_HOURS = 72;
export const STALE_OPEN_BATCH_LIMIT = 500;
export const STALE_OPEN_EVENT_TYPE = "task.stale_expired";

/** 读环境变量:未设 / 0 / 负数 / 非数字 → null(关闭)。每次巡检现读,改 env 不用重启测试进程。 */
export function staleOpenTaskHours(env: Record<string, string | undefined> = process.env): number | null {
  const raw = (env[STALE_OPEN_TASK_ENV] ?? "").trim();
  if (!raw) return null;
  const h = Number(raw);
  return Number.isFinite(h) && h > 0 ? h : null;
}

export function staleOpenReason(hours: number, status: string): string {
  return `stale: no activity for ${hours}h (was ${status}) — closed by hub patrol (#519)`;
}

/** 「最近一次动静早于截止点」的 WHERE 片段。截止点是字面量(datetime('now', '-N seconds')),不绑参数。 */
function staleWhere(cutoff: string, alias = "tasks"): string {
  return `${alias}.status IN ('acked', 'running')
      AND ${alias}.created_at < ${cutoff}
      AND (${alias}.delivered_at IS NULL OR ${alias}.delivered_at < ${cutoff})
      AND (${alias}.started_at IS NULL OR ${alias}.started_at < ${cutoff})
      AND (${alias}.consumed_at IS NULL OR ${alias}.consumed_at < ${cutoff})
      AND (${alias}.runtime_submitted_at IS NULL OR ${alias}.runtime_submitted_at < ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = ${alias}.task_id AND e.created_at >= ${cutoff})`;
}

export type StaleClosedRow = { task_id: string; network_id: string | null; status: string };

/**
 * 一次巡检的「陈旧开着的任务」阶段。关闭时什么都不做、返回 []。
 * 返回本次结束的行(测试 / 日志用)。调用方负责吞异常。
 */
export function expireStaleOpenTasks(opts: { hours?: number | null; limit?: number } = {}): StaleClosedRow[] {
  const hours = opts.hours === undefined ? staleOpenTaskHours() : opts.hours;
  if (!hours || hours <= 0) return [];
  const limit = Math.max(1, Math.floor(opts.limit ?? STALE_OPEN_BATCH_LIMIT));
  const seconds = Math.max(1, Math.round(hours * 3600));
  const cutoff = `datetime('now', '-${seconds} seconds')`;
  return db.transaction(() => {
    const due = db.all<StaleClosedRow>(
      `SELECT tasks.task_id, tasks.network_id, tasks.status FROM tasks
        WHERE ${staleWhere(cutoff)}
        ORDER BY tasks.created_at ASC LIMIT ${limit}`,
    );
    const closed: StaleClosedRow[] = [];
    for (const task of due) {
      const reason = staleOpenReason(hours, task.status);
      const res = db.run(
        `UPDATE tasks SET status = 'expired', completed_at = datetime('now'), result = COALESCE(result, ?2)
          WHERE task_id = ?1 AND ${staleWhere(cutoff)}`,
        [task.task_id, reason],
      );
      if (res.changes < 1) continue;
      db.run(
        `INSERT INTO task_events (task_id, from_status, to_status, event_type, actor, detail, network_id)
         VALUES (?1, ?2, 'expired', '${STALE_OPEN_EVENT_TYPE}', 'patrol', ?3, ?4)`,
        [task.task_id, task.status, reason, task.network_id ?? null],
      );
      closed.push(task);
    }
    if (closed.length === 0) return closed;
    // inbox 与 scheduled_task_runs 按 task_id 都没有可用索引(inbox 只能 COALESCE(task_id, id)):
    // 每行各查一次 = 每行一次全表扫,生产库上 500 行要 ~8 秒的写事务。所以整批各查**一次**。
    const ids = closed.map((t) => t.task_id);
    const inList = ids.map((_, i) => `?${i + 1}`).join(", ");
    db.run(`UPDATE inbox SET acked = 1 WHERE acked = 0 AND COALESCE(task_id, id) IN (${inList})`, ids);
    const scheduled = new Set(
      db.all<{ task_id: string }>(`SELECT task_id FROM scheduled_task_runs WHERE task_id IN (${inList})`, ...ids).map((r) => r.task_id),
    );
    for (const t of closed) if (scheduled.has(t.task_id)) syncScheduledRunForTask(t.task_id, t.network_id);
    return closed;
  });
}
