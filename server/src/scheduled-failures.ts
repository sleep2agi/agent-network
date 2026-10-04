// #523 —— 定时任务连续失败:告诉创建者(可选自动暂停)。
//
// 现场:一个每 2 分钟一次的排程,每一次派出去的任务都被节点以 failed 结束(上游模型拒绝),一天 720 次,
//   排程照样 active,创建者什么都不知道。#464 只管「被上一次卡住」(skipped),不管「每次都失败」。
//
// 1. 计数:consecutive_failures = 最近一次成功(run.status='replied')之后,status='failed' 的 run 数。
//    skipped / cancelled / expired / 还没结束的 run 不算失败,也不打断连续(expired 由 #464 的超时告警负责)。
//    失败有两种来源,都会走到这里:派发时就失败(节点不在 / 被停用 / 降级 / 创建者无权限,
//    scheduled-tasks.ts 提交后调用),以及派出去的任务以 failed 结束(db.ts 的 run 镜像触发钩子)。
// 2. 告警:连续失败 ≥ N(默认 5)→ 给排程创建者发**一条**通知(agent-notice.ts,与 #462/#464 同一条路,
//    出现在与目标节点的会话里)。去重落在 scheduled_tasks 两列上(条件写,一次只有一个调用方抢得到):
//    failure_alert_key = 告警那一刻「最近一次成功」的 run_id —— 之后又成功过,key 就变了,下一段失败重新上膛;
//    failure_alert_at  = 告警时间 —— 一直没成功过,24 小时后再提醒一次。Hub 重启不会重发。
// 3. 自动暂停:默认关。COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=M(≥1)时,连续失败 ≥ M 的 active 排程
//    被置为 paused(next_run_at 清空,revision+1,与用户手动暂停同形),并通知创建者。
//
// 环境变量:COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS(N,默认 5)、COMMHUB_SCHEDULE_FAILURE_RENOTICE_SEC
//   (默认 86400)、COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS(M,默认 0 = 关)。

import { db, setScheduledRunTerminalHook } from "./db.js";
import { sendAgentNotice } from "./agent-notice.js";

export const SCHEDULE_FAILING_NOTICE_KIND = "schedule_failing";
const ERROR_PREVIEW_CHARS = 300;

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function failureNoticeRuns(): number { return envInt("COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS", 5, 1); }
export function failureRenoticeMs(): number { return envInt("COMMHUB_SCHEDULE_FAILURE_RENOTICE_SEC", 86_400, 1) * 1000; }
/** 0 = 不自动暂停(默认)。 */
export function failureAutoPauseRuns(): number { return envInt("COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS", 0, 0); }

export type FailureStreak = { consecutiveFailures: number; lastSuccessRunId: string | null };

/** 最近一次成功之后的失败 run 数。scheduled_for 每个排程唯一(UNIQUE),按它排序是确定的。 */
export function failureStreak(scheduleId: string): FailureStreak {
  const lastSuccess = db.get<{ run_id: string; scheduled_for: string }>(
    "SELECT run_id, scheduled_for FROM scheduled_task_runs WHERE schedule_id = ?1 AND status = 'replied' ORDER BY scheduled_for DESC LIMIT 1",
    scheduleId,
  );
  const n = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE schedule_id = ?1 AND status = 'failed' AND scheduled_for > ?2",
    scheduleId, lastSuccess?.scheduled_for ?? "",
  )?.n ?? 0;
  return { consecutiveFailures: Number(n), lastSuccessRunId: lastSuccess?.run_id ?? null };
}

type ScheduleForAlert = {
  schedule_id: string;
  network_id: string;
  created_by: string | null;
  name: string;
  target_alias: string;
  status: string;
};

export type FailureNotice = {
  reason: "failing" | "paused";
  scheduleId: string;
  scheduleName: string;
  networkId: string;
  createdBy: string;
  alias: string;
  failures: number;
  errorCode: string | null;
  errorMessage: string | null;
};

function latestFailure(scheduleId: string): { error_code: string | null; error_message: string | null } {
  const row = db.get<{ error_code: string | null; error_message: string | null; result: string | null }>(
    `SELECT r.error_code, r.error_message, t.result
       FROM scheduled_task_runs r
       LEFT JOIN tasks t ON t.task_id = r.task_id AND t.network_id = r.network_id
      WHERE r.schedule_id = ?1 AND r.status = 'failed'
      ORDER BY r.scheduled_for DESC LIMIT 1`,
    scheduleId,
  );
  // 任务以 failed 结束时 run.error_message 为空,原因在任务的回复正文里。
  return { error_code: row?.error_code ?? null, error_message: row?.error_message || row?.result || null };
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function failureNoticeText(n: FailureNotice): { title: string; text: string } {
  const err = n.errorMessage ? truncate(n.errorMessage, ERROR_PREVIEW_CHARS) : "(没有错误详情)";
  const code = n.errorCode ? ` [${n.errorCode}]` : "";
  const head = `定时任务「${n.scheduleName}」(派给节点 ${n.alias})已经连续 ${n.failures} 次执行失败。\n\n最近一次的错误${code}:${err}\n\n`;
  if (n.reason === "paused") {
    return {
      title: "定时任务连续失败,已自动暂停",
      text: `${head}按 Hub 的设置,它已被自动暂停,不会再派发。处理好原因后,在定时任务里把它恢复为「启用」即可。`,
    };
  }
  return {
    title: "定时任务连续失败",
    text: `${head}它仍在按计划运行。如需停止,在定时任务里暂停它(或 PATCH /api/scheduled-tasks/${n.scheduleId},body 带 {"status":"paused","revision":<当前 revision>})。`
      + `在它重新成功之前,24 小时内不会再提醒。`,
  };
}

export function sendFailureNotice(n: FailureNotice): string | null {
  try {
    const { title, text } = failureNoticeText(n);
    return sendAgentNotice({
      networkId: n.networkId, userId: n.createdBy, fromAlias: n.alias, kind: SCHEDULE_FAILING_NOTICE_KIND, title, text, severity: "error",
      meta: { schedule_failing: { reason: n.reason, schedule_id: n.scheduleId, consecutive_failures: n.failures, error_code: n.errorCode } },
      idPrefix: "dm_sched_",
    });
  } catch (e: any) {
    console.error(`[scheduled-tasks] failure notice failed schedule=${n.scheduleId}: ${e?.message || e}`);
    return null;
  }
}

/**
 * 一个 run 以 failed 结束之后调用(派发时失败 / 任务 failed 都算)。返回发出的通知(测试用),没有则 null。
 * 告警与暂停都是条件写:并发的两个调用方只有一个写得进去,所以每段失败恰好一条通知。
 */
export function evaluateScheduleFailures(scheduleId: string, now = new Date()): FailureNotice | null {
  const row = db.get<ScheduleForAlert>(
    "SELECT schedule_id, network_id, created_by, name, target_alias, status FROM scheduled_tasks WHERE schedule_id = ?1",
    scheduleId,
  );
  if (!row) return null;
  const streak = failureStreak(scheduleId);
  const noticeAt = failureNoticeRuns();
  const pauseAt = failureAutoPauseRuns();
  const wantsPause = pauseAt > 0 && streak.consecutiveFailures >= pauseAt && row.status === "active";
  if (streak.consecutiveFailures < noticeAt && !wantsPause) return null;

  let paused = false;
  if (wantsPause) {
    paused = db.run(
      "UPDATE scheduled_tasks SET status = 'paused', next_run_at = NULL, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?1 AND status = 'active'",
      [scheduleId],
    ).changes === 1;
  }
  const key = streak.lastSuccessRunId ?? "";
  const cutoff = new Date(now.getTime() - failureRenoticeMs()).toISOString();
  // 去重:同一段失败(key 没变)且上次告警不到 24 小时 → 不写、不发。暂停是另一件事,照发。
  const claimed = db.run(
    `UPDATE scheduled_tasks SET failure_alert_at = ?1, failure_alert_key = ?2
      WHERE schedule_id = ?3
        AND (failure_alert_at IS NULL OR COALESCE(failure_alert_key, '') <> ?2 OR failure_alert_at <= ?4)`,
    [now.toISOString(), key, scheduleId, cutoff],
  ).changes === 1;
  if (paused && !claimed) {
    db.run("UPDATE scheduled_tasks SET failure_alert_at = ?1, failure_alert_key = ?2 WHERE schedule_id = ?3", [now.toISOString(), key, scheduleId]);
  }
  if (!paused && !claimed) return null;
  if (!row.created_by) return null;
  const latest = latestFailure(scheduleId);
  const notice: FailureNotice = {
    reason: paused ? "paused" : "failing",
    scheduleId, scheduleName: row.name, networkId: row.network_id, createdBy: row.created_by, alias: row.target_alias,
    failures: streak.consecutiveFailures, errorCode: latest.error_code, errorMessage: latest.error_message,
  };
  sendFailureNotice(notice);
  return notice;
}

/** GET /runs 的附加字段。 */
export function failureSummary(scheduleId: string): { consecutive_failures: number; failure_alert_threshold: number; last_failure_alert_at: string | null } {
  const streak = failureStreak(scheduleId);
  const alertAt = db.get<{ failure_alert_at: string | null }>("SELECT failure_alert_at FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId)?.failure_alert_at ?? null;
  return { consecutive_failures: streak.consecutiveFailures, failure_alert_threshold: failureNoticeRuns(), last_failure_alert_at: alertAt };
}

setScheduledRunTerminalHook((scheduleId, status) => {
  if (status === "failed") evaluateScheduleFailures(scheduleId);
});
