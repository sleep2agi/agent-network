// #758 —— 「孤儿任务」:任务还停在 acked / running,接收节点却已经回到 idle(或 offline)、
// 并且在任务开工之后还报过状态 —— 节点转去干别的了,没回这一条。
//
// 生产只读实测:17 条任务 acked / running 超过 1 小时,接收节点早已 idle;最长一条(admin 的 P0)挂了 15.7 小时。
// 以前巡检只对 delivered 记警告(task-lifecycle-watcher.ts),acked / running 这一段谁都看不见。
//
// 规则(每次 5 分钟任务巡检跑一遍,server.ts runTaskPatrol):
//   status ∈ {acked, running}
//   ∧ 开工时刻 = COALESCE(started_at, delivered_at, created_at) 早于 COMMHUB_ORPHAN_TASK_MINUTES(默认 60;0 = 关)
//   ∧ 开工时刻在最近 COMMHUB_ORPHAN_TASK_LOOKBACK_HOURS 内(默认 72;0 = 不设上限)—— 首次部署不爆发历史通知
//   ∧ 接收节点(sessions 同网络同别名)当前 status ∈ {idle, offline}
//   ∧ 节点最后一次报状态 COALESCE(last_seen_at, updated_at) 晚于开工时刻
// 命中后对每条任务**只做一次**:
//   - task_events 写一行 event_type = event_key = task.orphan_suspected(唯一索引 (task_id, event_key) 兜底,
//     ON CONFLICT DO NOTHING;只有真插进去的那一次才往下走)。
//   - 通知派活的一方,与过期通知同一条路(task-expiry-notice.ts 的 classifyExpirySender / deliver):
//     agent → inbox reply + new_reply;人 → user_inbox;scheduler / hub / api → 不发。
//   - **不改任务状态**:不 fail、不关、不碰过期语义。

import { db } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { classifyExpirySender, deliver, type ExpiredTaskRow } from "./task-expiry-notice.js";

export const ORPHAN_TASK_ENV = "COMMHUB_ORPHAN_TASK_MINUTES";
export const ORPHAN_DEFAULT_MINUTES = 60;
export const ORPHAN_LOOKBACK_ENV = "COMMHUB_ORPHAN_TASK_LOOKBACK_HOURS";
export const ORPHAN_DEFAULT_LOOKBACK_HOURS = 72;
export const ORPHAN_EVENT_TYPE = "task.orphan_suspected";
export const ORPHAN_NOTICE_KIND = "task_orphan_suspected";
const BATCH_LIMIT = 200;

/** 未设 / 非数字 → 默认 60;0 或负数 → 关闭(null)。 */
export function orphanTaskMinutes(env: Record<string, string | undefined> = process.env): number | null {
  const raw = (env[ORPHAN_TASK_ENV] ?? "").trim();
  if (!raw) return ORPHAN_DEFAULT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return ORPHAN_DEFAULT_MINUTES;
  return n > 0 ? n : null;
}

/** 只看开工时刻在最近 N 小时内的任务:未设 / 非数字 / 负数 → 默认 72;0 → 不设上限。
 *  首次部署时不把几周前的历史 acked / running 一次性全标出来、给派活方(包括 owner)刷一屏通知。 */
export function orphanLookbackHours(env: Record<string, string | undefined> = process.env): number | null {
  const raw = (env[ORPHAN_LOOKBACK_ENV] ?? "").trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return ORPHAN_DEFAULT_LOOKBACK_HOURS;
  return n === 0 ? null : n;
}

type OrphanRow = ExpiredTaskRow & { status: string; started: string; node_status: string; node_seen: string };

export type OrphanFlagged = { task_id: string; notified: "agent" | "user" | null };

export function orphanNoticeText(r: Pick<OrphanRow, "task_id" | "to_name" | "status" | "content" | "node_status">, openMin: number | null): { title: string; text: string } {
  const preview = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const m = openMin === null ? "?" : String(openMin);
  return {
    title: "任务可能没人收尾",
    text: `[Hub] 任务可能没人收尾:你派给 ${r.to_name} 的任务 ${r.task_id} 停在 ${r.status} 已 ${m} 分钟,但 ${r.to_name} 之后已回到 ${r.node_status},一直没有回复。`
      + `Hub 没有改这条任务的状态。\n内容:${preview}\n`
      + `建议:问 ${r.to_name} 一句,或 cancel_task 后换个节点重派。\n`
      + `Task ${r.task_id} to ${r.to_name} has been ${r.status} for ${m} min while ${r.to_name} went ${r.node_status} without replying. Its status was not changed.`,
  };
}

/** 一次巡检的孤儿阶段。返回本次新标记的任务(测试 / 日志用)。调用方负责吞异常。 */
export function flagOrphanTasks(opts: { minutes?: number | null; lookbackHours?: number | null; nowMs?: number } = {}): OrphanFlagged[] {
  const minutes = opts.minutes === undefined ? orphanTaskMinutes() : opts.minutes;
  if (!minutes || minutes <= 0) return [];
  const cutoff = `datetime('now', '-${Math.max(1, Math.round(minutes * 60))} seconds')`;
  const started = "COALESCE(t.started_at, t.delivered_at, t.created_at)";
  const lookback = opts.lookbackHours === undefined ? orphanLookbackHours() : opts.lookbackHours;
  const lookbackSql = lookback && lookback > 0
    ? `AND ${started} >= datetime('now', '-${Math.max(1, Math.round(lookback * 3600))} seconds')`
    : "";
  const rows = db.all<OrphanRow>(
    `SELECT t.task_id, t.network_id, t.from_name, t.from_node_id, t.to_name, t.content, t.created_at, t.expires_at,
            t.parent_task_id, t.meta_json, t.status, ${started} AS started,
            s.status AS node_status, COALESCE(s.last_seen_at, s.updated_at) AS node_seen
       FROM tasks t
       JOIN sessions s ON s.alias = t.to_name AND s.network_id = COALESCE(t.network_id, 'default')
      WHERE t.status IN ('acked', 'running')
        AND ${started} < ${cutoff}
        ${lookbackSql}
        AND s.status IN ('idle', 'offline')
        AND COALESCE(s.last_seen_at, s.updated_at) > ${started}
        AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.task_id AND e.event_key = '${ORPHAN_EVENT_TYPE}')
      ORDER BY t.created_at ASC LIMIT ${BATCH_LIMIT}`,
  );
  const nowMs = opts.nowMs ?? Date.now();
  const flagged: OrphanFlagged[] = [];
  for (const r of rows) {
    const route = classifyExpirySender(r);
    const who = route.kind === "none" ? `none (${route.reason})` : `${route.kind} ${route.kind === "agent" ? route.alias : route.username}`;
    const detail = `${r.to_name} is ${r.node_status} (last status ${r.node_seen}) since ${r.status} at ${r.started}; notify: ${who}`;
    const res = db.run(
      `INSERT INTO task_events (task_id, from_status, to_status, event_type, event_key, actor, detail, network_id)
       VALUES (?1, ?2, ?2, '${ORPHAN_EVENT_TYPE}', '${ORPHAN_EVENT_TYPE}', 'patrol', ?3, ?4)
       ON CONFLICT(task_id, event_key) DO NOTHING`,
      [r.task_id, r.status, detail, r.network_id ?? null],
    );
    if (res.changes < 1) continue; // 只做一次:别的巡检 / 别的 Hub worker 已经标过了
    let notified: OrphanFlagged["notified"] = null;
    if (route.kind !== "none") {
      try {
        const startedMs = parseDbTimestampMs(r.started);
        const openMin = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 60_000)) : null;
        const meta = { task_orphan_suspected: { task_id: r.task_id, target: r.to_name, status: r.status, node_status: r.node_status } };
        const id = deliver(route, r.network_id, r.to_name, r.task_id, orphanNoticeText(r, openMin), meta,
          { kind: ORPHAN_NOTICE_KIND, status: "orphan_suspected", agentPrefix: "orph_", userPrefix: "dm_orphan_" });
        if (id) notified = route.kind;
      } catch (e: any) {
        console.error(`[patrol] orphan notice failed task=${r.task_id}: ${e?.message || e}`);
      }
    }
    flagged.push({ task_id: r.task_id, notified });
  }
  return flagged;
}
