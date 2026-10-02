// #464 —— 定时任务被一次没结束的执行卡住:告警 + 超时放行。
//
// 现场:overlap=skip 的排程,上一次派出的任务节点一直没有终态回复 → 之后每一次都记成
//   skipped / previous_run_active,没有超时、也没人被告诉(当天 ~25 分钟,10-01 ~7 小时)。
//
// 1. 告警:同一个「卡住的任务」(blocked_by_task_id)连续挡掉 N 次 → 给排程的创建者发**一条**通知
//    (agent-notice.ts,与 #462 同一条路,出现在与目标节点的会话里)。按挡路的任务计数,所以
//    一段卡住只发一次;任务一换(下一次真派出去了)自然重新上膛。不依赖内存,Hub 重启不会重发。
// 2. 超时:挡路的任务开着超过 stuckTimeoutMs(间隔)就按**已有的** expired 状态结束它(同 TTL 巡检:
//    tasks.status='expired' + 收件箱行置 acked + db.ts 的镜像把这次 run 记成 expired / task_expired),
//    然后这一次照常派发。任务行不删,照样能查;晚到的回复被 send_reply 以 reply_task_terminal 拒掉,
//    什么都不改(不重开 run、不碰新派出去的那条)。
//    如果超时发生在 N 次之前(长间隔的排程,比如每天一次),那一刻补发一条「已超时结束」—— 每段卡住
//    恰好一条通知。
//
// 默认值(PR 里有推导):N=3;超时 = clamp(6 × 间隔, 下限 1 小时, 上限 24 小时)。
//   下限 1 小时:一轮 agent 任务正常要跑几十分钟,不能因为排程间隔短就把还在干活的任务掐掉。
//   上限 24 小时:Hub 本来就给定时任务 24 小时的 expires_at(没被取走时由巡检过期),开着超过一天的
//   定时任务不是「还在做」。6 × 间隔:间隔长的排程(每小时一次)给它 6 小时,而不是 1 小时。
// 环境变量可改(运维 / 测试):COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS、COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR、
//   COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC、COMMHUB_SCHEDULE_STUCK_TIMEOUT_CAP_SEC。

import { db, syncScheduledRunForTask } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { sendAgentNotice } from "./agent-notice.js";

export const SCHEDULE_STUCK_NOTICE_KIND = "schedule_stuck";

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function stuckNoticeSkips(): number {
  return Math.floor(envNumber("COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS", 3, 1));
}

/** 排程的名义间隔(秒):interval 取 every_seconds;daily / weekly 取一天(两次之间最短一天);once 取 0。 */
export function nominalIntervalSeconds(scheduleJson: string): number {
  try {
    const spec = JSON.parse(scheduleJson) as { type?: string; every_seconds?: number };
    if (spec.type === "interval" && Number.isFinite(spec.every_seconds)) return Number(spec.every_seconds);
    if (spec.type === "daily" || spec.type === "weekly") return 86_400;
  } catch {}
  return 0;
}

export function stuckTimeoutMs(scheduleJson: string): number {
  const factor = envNumber("COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR", 6, 0);
  const floor = envNumber("COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC", 3_600, 1);
  const cap = Math.max(floor, envNumber("COMMHUB_SCHEDULE_STUCK_TIMEOUT_CAP_SEC", 86_400, 1));
  return Math.min(cap, Math.max(floor, factor * nominalIntervalSeconds(scheduleJson))) * 1000;
}

type Blocker = { task_id: string; created_at: string; status: string };

/** 挡路的任务开了多久已经到超时 → true。读不出时间 = 不超时(宁可多挡一次,不错杀)。 */
export function blockerTimedOut(blocker: Pick<Blocker, "created_at">, scheduleJson: string, now: Date): boolean {
  const started = parseDbTimestampMs(blocker.created_at);
  if (!Number.isFinite(started)) return false;
  return now.getTime() - started >= stuckTimeoutMs(scheduleJson);
}

/**
 * 在调用方的事务里按超时结束挡路的任务。只动还开着的任务(条件写),返回是否真的结束了它。
 * 与 TTL 巡检(server.ts patrolExpiredTasks)同一套写法:status=expired、收件箱行置 acked、镜像到 run。
 */
export function expireStuckBlocker(taskId: string, networkId: string, ageMs: number, limitMs: number): boolean {
  const changed = db.run(
    `UPDATE tasks SET status = 'expired', completed_at = datetime('now')
      WHERE task_id = ?1 AND network_id = ?2 AND status IN ('created', 'delivered', 'acked', 'running')`,
    [taskId, networkId],
  );
  if (changed.changes < 1) return false;
  db.run("UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1 AND acked = 0", [taskId]);
  syncScheduledRunForTask(taskId, networkId);
  db.run(
    "UPDATE scheduled_task_runs SET error_message = ?1 WHERE task_id = ?2 AND network_id = ?3",
    [`timed out by the scheduler: open for ${Math.round(ageMs / 60_000)} min (limit ${Math.round(limitMs / 60_000)} min); the next occurrence was dispatched`, taskId, networkId],
  );
  return true;
}

/** 这个任务已经挡掉了几次(只算 previous_run_active 的跳过)。 */
export function skipsBlockedBy(scheduleId: string, taskId: string): number {
  return db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE schedule_id = ?1 AND blocked_by_task_id = ?2 AND error_code = 'previous_run_active'",
    scheduleId, taskId,
  )?.n ?? 0;
}

export type StuckNotice = {
  reason: "stuck" | "timed_out";
  scheduleId: string;
  scheduleName: string;
  networkId: string;
  createdBy: string | null;
  alias: string;
  timezone: string;
  taskId: string;
  taskCreatedAt: string;
  skips: number;
  timeoutMs: number;
};

function fmtTime(dbTs: string, timezone: string): string {
  const ms = parseDbTimestampMs(dbTs);
  if (!Number.isFinite(ms)) return dbTs;
  try {
    const s = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    return `${s} (${timezone})`;
  } catch { return dbTs; }
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export function stuckNoticeText(n: StuckNotice): { title: string; text: string } {
  const started = fmtTime(n.taskCreatedAt, n.timezone);
  if (n.reason === "stuck") {
    return {
      title: "定时任务被卡住",
      text: `定时任务「${n.scheduleName}」被上一次的执行卡住了:任务 ${n.taskId} 于 ${started} 派给节点 ${n.alias},到现在还没有完成,之后的 ${n.skips} 次执行都被跳过。\n\n`
        + `它开着超过 ${fmtDuration(n.timeoutMs)} 后会被自动按超时结束,下一次照常派发。等不及可以在任务列表里取消这条任务。`,
    };
  }
  return {
    title: "定时任务已超时放行",
    text: `定时任务「${n.scheduleName}」上一次的任务 ${n.taskId}(${started} 派给节点 ${n.alias})开着超过 ${fmtDuration(n.timeoutMs)} 还没有完成,已按超时结束,不再挡后面的执行。`,
  };
}

/** 提交之后调用。没有创建者 / 创建者不在网络里 → 不发。 */
export function sendStuckNotice(n: StuckNotice): string | null {
  if (!n.createdBy) return null;
  try {
    const { title, text } = stuckNoticeText(n);
    return sendAgentNotice({
      networkId: n.networkId, userId: n.createdBy, fromAlias: n.alias, kind: SCHEDULE_STUCK_NOTICE_KIND, title, text,
      meta: { schedule_stuck: { reason: n.reason, schedule_id: n.scheduleId, blocked_by_task_id: n.taskId, skips: n.skips } },
      idPrefix: "dm_sched_",
    });
  } catch (e: any) {
    console.error(`[scheduled-tasks] stuck notice failed schedule=${n.scheduleId}: ${e?.message || e}`);
    return null;
  }
}
