// #500 step 2 —— 派活之前 / 派活那一刻,让发送方看见目标节点的队列。
//
// 第一步(#2322)在任务过期时通知发送方;这一步在 send_task / POST /api/task 的响应里直接告诉它
// 「前面还有几个、目标正在忙没有、大概要等多久」,并在 /api/status(全量)和 get_all_status 的每一行
// 带上 queue_depth。只是建议:**从不拒绝派活**,老客户端不认识的字段直接忽略。
//
// 定义(与 task-expiry-notice.ts 的 openTasksAhead 同一组状态):
//   开着的任务 = tasks 行,status ∈ {created, delivered, acked, running},且 created_at 在最近 24 小时内。
//     - created / delivered:还没被消费的,以及已经被运行时取走(consumed_at)但状态还没前移的;
//     - acked / running:已经开工、还没出终态的。
//     - 消息(send_message / broadcast)只写 inbox、不写 tasks,天然不算。终态(replied / failed / cancelled /
//       expired)不算。
//     - 24 小时窗口:TTL 上限就是 24 小时,超过 24 小时还没终态的行几乎都是被遗弃的(节点重启丢了、
//       running 从来没回来;#2322 起 consumed 的 delivered 行也不再被巡检过期),不算进队列,否则队列只增不减。
//   queue_ahead = 派这一条**之前**目标上开着的任务数(按网络;没有网络 = 不加网络条件,与 pending 计数同口径)。
//   target_busy = 目标上有一条已开工(acked / running,或带 started_at / consumed_at)的开着的任务,或者会话状态是
//                 working / busy / running。
//   est_wait_minutes = 目标最近 24 小时 replied 任务的耗时中位数 × queue_ahead,四舍五入、上限 1440;
//                 样本 < 3 条 → null(不知道);queue_ahead = 0 → 0(前面没人)。
//                 耗时 = completed_at − (started_at ?? 不晚于 completed_at 的 consumed_at ?? delivered_at ?? created_at)。
//                 开工时间戳很稀疏,回落到派出时间就把排队也算进去了 —— 所以只是**粗估**,偏大。
//   warning = queue_ahead ≥ 3 或 est_wait_minutes > 30 时给一句人话,建议换个空闲节点 / 合并请求 / 加长 ttl_seconds。
//
// 查询:派活时一条(计数)+ 必要时一条(耗时样本,LIMIT 200,走 idx_tasks_to_created);状态读一条 GROUP BY。
// 条件分支各自拼占位符,PostgreSQL 上不会有「绑了没用」的参数。

import { db } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";

export const QUEUE_OPEN_STATUSES_SQL = "('created', 'delivered', 'acked', 'running')";
/** 开着的任务只看最近这么久派出的(= TTL 上限)。 */
export const QUEUE_HORIZON_SQL = "datetime('now', '-86400 seconds')";
export const QUEUE_WARN_AHEAD = 3;
export const QUEUE_WARN_WAIT_MINUTES = 30;
export const EST_WAIT_MIN_SAMPLES = 3;
export const EST_WAIT_CAP_MINUTES = 1440;
const EST_WAIT_SAMPLE_LIMIT = 200;
const BUSY_SESSION_STATUSES = new Set(["working", "busy", "running"]);

export type DispatchQueueInfo = {
  queue_ahead: number;
  target_busy: boolean;
  est_wait_minutes: number | null;
  warning?: string;
};

function scoped(sql: string, params: any[], networkId: string | null | undefined): string {
  if (!networkId) return sql;
  params.push(networkId);
  return `${sql} AND network_id = ?${params.length}`;
}

/** 目标上开着的任务数 + 其中已开工的数。一条查询。 */
export function openTaskCounts(alias: string, networkId: string | null | undefined): { open: number; started: number } {
  const q = openTaskCountsQuery(alias, networkId);
  const row = db.get<{ open_n: number | string | null; started_n: number | string | null }>(q.sql, ...q.params);
  return { open: Number(row?.open_n ?? 0) || 0, started: Number(row?.started_n ?? 0) || 0 };
}

/**
 * The statement openTaskCounts runs (exported for the plan assertion). Unlike queueDepthQuery below it needs no
 * index hint: the to_name equality + created_at range always wins idx_tasks_to_created, even for a node with tens of
 * thousands of stuck `acked` rows (task-queue-ahead-scale.test.ts pins that plan).
 */
export function openTaskCountsQuery(alias: string, networkId: string | null | undefined): { sql: string; params: any[] } {
  const params: any[] = [alias];
  let sql = `SELECT COUNT(*) AS open_n,
      SUM(CASE WHEN status IN ('acked', 'running') OR started_at IS NOT NULL OR consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS started_n
    FROM tasks WHERE to_name = ?1 AND status IN ${QUEUE_OPEN_STATUSES_SQL} AND created_at >= ${QUEUE_HORIZON_SQL}`;
  sql = scoped(sql, params, networkId);
  return { sql, params };
}

/** 目标最近 24 小时 replied 任务的耗时中位数(分钟);样本不够 → null。一条查询。 */
export function medianTaskMinutes(alias: string, networkId: string | null | undefined): number | null {
  const params: any[] = [alias];
  let sql = `SELECT created_at, delivered_at, started_at, consumed_at, completed_at FROM tasks
    WHERE to_name = ?1 AND status = 'replied' AND completed_at IS NOT NULL AND created_at >= ${QUEUE_HORIZON_SQL}`;
  sql = scoped(sql, params, networkId);
  sql += ` ORDER BY created_at DESC LIMIT ${EST_WAIT_SAMPLE_LIMIT}`;
  const rows = db.all<{ created_at: string | null; delivered_at: string | null; started_at: string | null; consumed_at: string | null; completed_at: string | null }>(sql, ...params);
  const mins: number[] = [];
  for (const r of rows) {
    const end = r.completed_at ? parseDbTimestampMs(r.completed_at) : NaN;
    if (!Number.isFinite(end)) continue;
    const consumed = r.consumed_at ? parseDbTimestampMs(r.consumed_at) : NaN;
    const startText = r.started_at ?? (Number.isFinite(consumed) && consumed <= end ? r.consumed_at : null) ?? r.delivered_at ?? r.created_at;
    const start = startText ? parseDbTimestampMs(startText) : NaN;
    if (!Number.isFinite(start) || end < start) continue;
    mins.push((end - start) / 60_000);
  }
  if (mins.length < EST_WAIT_MIN_SAMPLES) return null;
  mins.sort((a, b) => a - b);
  const mid = mins.length >> 1;
  return mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
}

export function queueWarning(alias: string, info: Omit<DispatchQueueInfo, "warning">, ttlSeconds: number): string | undefined {
  const waitHigh = info.est_wait_minutes != null && info.est_wait_minutes > QUEUE_WARN_WAIT_MINUTES;
  if (info.queue_ahead < QUEUE_WARN_AHEAD && !waitHigh) return undefined;
  const ttlMin = Math.round(ttlSeconds / 60);
  const wait = info.est_wait_minutes == null ? "unknown wait" : `rough wait ~${info.est_wait_minutes} min`;
  const expiry = info.est_wait_minutes != null && info.est_wait_minutes >= ttlMin
    ? ` It may expire before it starts (ttl ${ttlMin} min).`
    : ` It expires if not started within ${ttlMin} min.`;
  return `${alias} already has ${info.queue_ahead} open task(s) ahead of this one (${wait}${info.target_busy ? ", busy now" : ""}). `
    + `Your task is queued, not refused.${expiry} Consider an idle node instead (get_all_status: status=idle, queue_depth=0), `
    + `merging your asks, or a longer ttl_seconds. Do not resend the same task.`;
}

/**
 * 派活那一刻的队列信息。在写 inbox / tasks **之前**调:那时开着的就是排在它前面的。
 * 任何异常都吞掉、返回 null —— 这些字段只是建议,不能让派活失败。
 */
export function dispatchQueueInfo(alias: string, networkId: string | null | undefined, sessionStatus: string | null | undefined, ttlSeconds: number): DispatchQueueInfo | null {
  try {
    const { open, started } = openTaskCounts(alias, networkId);
    const target_busy = started > 0 || BUSY_SESSION_STATUSES.has(String(sessionStatus ?? "").toLowerCase());
    let est_wait_minutes: number | null = 0;
    if (open > 0) {
      const median = medianTaskMinutes(alias, networkId);
      est_wait_minutes = median == null ? null : Math.min(EST_WAIT_CAP_MINUTES, Math.round(median * open));
    }
    const base = { queue_ahead: open, target_busy, est_wait_minutes };
    const warning = queueWarning(alias, base, ttlSeconds);
    return warning ? { ...base, warning } : base;
  } catch {
    return null;
  }
}

let queueDepthOffForTest = false;
/**
 * Test-only: queueDepthByNode answers an empty map without querying (every row's queue_depth = 0), i.e. a full
 * /api/status read does exactly the pre-#2325 work. The scale test alternates reads with it on and off against the
 * same server so the queue_depth share is measured A/B in the same time window (robust to a busy CI runner).
 */
export function __setQueueDepthOffForTest(on: boolean): void { queueDepthOffForTest = on; }

export const queueDepthKey = (networkId: string | null | undefined, alias: string) => `${networkId ?? ""}\u0000${alias}`;

/** 别名不多于这个数时按别名查(走 idx_tasks_to_created);多了就扫最近 24 小时派出的任务(走覆盖索引 idx_tasks_created_queue)。 */
export const QUEUE_DEPTH_ALIAS_LIST_MAX = 50;

/**
 * 每个 (网络, 别名) 上开着的任务数。一条 GROUP BY;没有开着任务的节点不在表里(= 0)。
 * `aliases` = 这次要标注的行:App 的 `?alias=` / `?node_id=` 单行读只查那一两个别名,不扫全库的开着任务。
 * 返回的计数按 (network_id, to_name) 分组,调用方按行自己的 network_id 取,所以别的网络的同名节点不会串。
 */
export function queueDepthByNode(aliases?: Array<string | null | undefined>): Map<string, number> {
  const out = new Map<string, number>();
  if (queueDepthOffForTest) return out;
  const q = queueDepthQuery(aliases);
  if (!q) return out;
  const rows = db.all<{ network_id: string | null; to_name: string; n: number | string }>(q.sql, ...q.params);
  for (const r of rows) out.set(queueDepthKey(r.network_id, r.to_name), Number(r.n) || 0);
  return out;
}

/** The statement queueDepthByNode runs (exported so the scale test can EXPLAIN exactly this SQL). null = nothing to ask. */
export function queueDepthQuery(aliases?: Array<string | null | undefined>): { sql: string; params: any[] } | null {
  const wanted = aliases ? [...new Set(aliases.filter((a): a is string => typeof a === "string" && a.length > 0))] : null;
  if (wanted && wanted.length === 0) return null;
  const params: any[] = [];
  // 🔴 The `|| ''` wrappers are deliberate — they are index hints, not data transforms (#500 follow-up to #2325).
  // On a production-shaped DB (57k tasks, 31k stuck in `acked` for weeks, ~1.9k created in the last 24 h) the
  // planner picked idx_tasks_status for `status IN (…)` and walked every open-status row ever written (~32k) to
  // keep the 24 h window: full /api/status went from ~8 ms to ~70 ms p50. Wrapping `status` makes that index
  // unusable, so the scan is driven by the 24 h range on the covering idx_tasks_created_queue (created_at, status,
  // network_id, to_name) (EXPLAIN: `SEARCH tasks USING COVERING INDEX idx_tasks_created_queue (created_at>?)`, plus a
  // temp b-tree for the GROUP BY; no task row is read) — or, for the alias list, by idx_tasks_to_created. Without the
  // covering index it falls back to idx_tasks_created + one row lookup per task: ~3 ms on the production copy, which
  // was still +50 % on a full /api/status read; covering, ~0.3 ms. The GROUP BY must be wrapped too: grouping on the bare columns lets SQLite pick
  // idx_tasks_network to avoid the sort, which is another full walk. `|| ''` is portable (SQLite and PostgreSQL;
  // a CTE/subquery gets flattened back, `+status` / `LIMIT -1` are SQLite-only). NULL || '' stays NULL on both, and
  // the selected expressions are the grouped ones (PostgreSQL requires that). task-queue-ahead-scale.test.ts pins
  // the plan and a latency budget.
  let sql = `SELECT (network_id || '') AS network_id, (to_name || '') AS to_name, COUNT(*) AS n FROM tasks
      WHERE (status || '') IN ${QUEUE_OPEN_STATUSES_SQL} AND created_at >= ${QUEUE_HORIZON_SQL}`;
  if (wanted && wanted.length <= QUEUE_DEPTH_ALIAS_LIST_MAX) {
    sql += ` AND to_name IN (${wanted.map((_, i) => `?${i + 1}`).join(", ")})`;
    params.push(...wanted);
  }
  sql += " GROUP BY (network_id || ''), (to_name || '')";
  return { sql, params };
}
