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
import { parseHubTimestamp } from "./hub-timestamp.js";

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

/**
 * #2622 —— 失败退避：连续失败达到 N 次后把**间隔翻倍**（上限 1 小时），成功一次立刻恢复原节奏。
 *
 * 为什么不是「暂停」：`#523` 已经有 `COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS`（默认关），
 * 但它会把排程**停下来**，需要人来恢复。对“上游额度暂时打满”这类外部原因，暂停太久同样是损失；
 * 退避只是**放慢重试**，外部原因一恢复就会自己跑回原节奏。
 *
 * 现场（2026-10-27 生产 24h）：一个 `every_seconds=180` 的排程失败 351 次、成功 24 次 ——
 * 失败与成功交替出现，所以“连续失败”很少攒到暂停阈值，而**每次失败都在按 3 分钟原速重试**。
 *
 * 存储复用 `backoff_effective_seconds`（派发时按 `max(every_seconds, backoff_effective_seconds)` 生效），
 * 与 `no_change_backoff` 互斥：那套逻辑自己会写这一列，这里只在 `no_change_backoff = 0` 时介入。
 *
 * 环境变量：`COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS`（默认 6；0 = 关闭）。
 */
export function failureBackoffRuns(): number { return envInt("COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS", 6, 0); }

const FAILURE_BACKOFF_CAP_SECONDS = 3600;

export function applyFailureBackoff(scheduleId: string, now = new Date()): { streak: number; effective_seconds: number | null } | null {
  const from = failureBackoffRuns();
  if (from <= 0) return null;
  const row = db.get<any>(
    `SELECT schedule_id, revision, status, schedule_type, schedule_json, no_change_backoff,
            backoff_effective_seconds, next_run_at
       FROM scheduled_tasks WHERE schedule_id = ?1`,
    scheduleId,
  );
  if (!row || row.status !== "active" || row.no_change_backoff === 1) return null;
  if (row.schedule_type !== "interval") return null;
  let spec: any = null;
  try { spec = JSON.parse(row.schedule_json || "{}"); } catch { spec = null; }
  const base = spec && spec.type === "interval" ? Number(spec.every_seconds) : NaN;
  if (!Number.isFinite(base) || base <= 0) return null;

  const streak = failureStreak(scheduleId).consecutiveFailures;
  const effective = streak >= from
    ? Math.min(FAILURE_BACKOFF_CAP_SECONDS, base * 2 ** Math.min(streak - from + 1, 6))
    : null;
  const target = effective ?? base;
  const previous = row.backoff_effective_seconds ?? base;
  let next = row.next_run_at;
  if (target !== previous && next) {
    // 放大：至少推到 now + target（不把已经更远的 next 拉近）；
    // 恢复：至少拉回 now + target（不把已经更近的 next 推远）。
    const candidate = new Date(now.getTime() + target * 1000).toISOString();
    const existing = Date.parse(next);
    if (Number.isFinite(existing)) {
      next = new Date(target > previous ? Math.max(existing, Date.parse(candidate)) : Math.min(existing, Date.parse(candidate))).toISOString();
    }
  }
  db.run(
    `UPDATE scheduled_tasks SET backoff_streak = ?1, backoff_effective_seconds = ?2, next_run_at = ?3,
       updated_at = datetime('now') WHERE schedule_id = ?4 AND revision = ?5 AND status = 'active'`,
    [streak, effective, next, scheduleId, row.revision],
  );
  return { streak, effective_seconds: effective };
}

/**
 * #2622（第二轮）—— 「跑不起来」的两类跳过也要退避。
 *
 * 生产 24h（2026-10-27）：`previous_run_active` 2286 条、`target_offline` 1951 条，
 * 而 `failureStreak()` 只数 `status='failed'`，**skipped 完全不计**，
 * 于是一个 `every_seconds=180` 的排程可以在目标永久离线的状态下每 3 分钟写一行 skip，
 * 一天 470 条，永不减速。
 *
 * 这里只做「放慢」，不改变派发语义：
 *   · 同一 error_code 连续出现 ≥ N（默认 3）⇒ 间隔按 2 倍放大，上限 1800 秒；
 *   · `target_offline` 的链用更长的上限（7200 秒 = 2 小时）——目标不在时没有理由每 3 分钟试一次；
 *   · 换链（原因变了）或出现成功 ⇒ 立刻回到原间隔；
 *   · 与 `no_change_backoff=1` 的排程互斥（那套逻辑自己拥有 backoff_* 三列）。
 */
const NO_PROGRESS_CODES = ["previous_run_active", "target_offline"] as const;
/** 统计窗口：看最近多少次 run 里同因跳过出现了几次（默认 10）。 */
const NO_PROGRESS_WINDOW = 10;
export type NoProgressCause = (typeof NO_PROGRESS_CODES)[number];

function noProgressFromRuns(runs: Array<{ status: string; error_code: string | null }>): { cause: NoProgressCause | null; streak: number } {
  const first = runs[0];
  if (!first) return { cause: null, streak: 0 };
  let cause: NoProgressCause | null = null;
  if (first.status === "failed") cause = null; // 由 applyFailureBackoff 负责，避免两套逻辑抢同一列
  else if (first.status === "skipped" && (NO_PROGRESS_CODES as readonly string[]).includes(first.error_code ?? "")) {
    cause = first.error_code as NoProgressCause;
  }
  if (!cause) return { cause: null, streak: 0 };
  // #2622（实测修正）—— **按窗口计数，不按连续链**。
  // 生产 4.3 小时实测：一批排程的模式是「跳过 → 跳过 → 成功 → 跳过…」，
  // 成功会把连续链打断，于是 streak 永远攒不到阈值，退避一次都没触发
  // （previous_run_active 24h 从 2397/天 只降到 2258/天）。
  // 改成「最近 N 次里同因跳过出现几次」：仍然要求最新一次是同因跳过（不干扰成功后的恢复），
  // 但如果它在这 N 次里反复出现，就按窗口值放慢。
  const window = runs.slice(0, NO_PROGRESS_WINDOW);
  let streak = 0;
  for (const r of window) {
    if (r.status === "skipped" && r.error_code === cause) streak++;
  }
  return { cause, streak };
}

export function noProgressBackoffRuns(): number {
  return envInt("COMMHUB_SCHEDULE_NO_PROGRESS_BACKOFF_RUNS", 3, 1);
}

export function applyNoProgressBackoff(scheduleId: string, now = new Date()): { streak: number; effective_seconds: number | null; cause: NoProgressCause } | null {
  const from = noProgressBackoffRuns();
  if (from <= 0) return null;
  const row = db.get<any>(
    `SELECT schedule_id, revision, status, schedule_type, schedule_json, no_change_backoff,
            backoff_effective_seconds, next_run_at
       FROM scheduled_tasks WHERE schedule_id = ?1`,
    scheduleId,
  );
  if (!row || row.status !== "active" || row.no_change_backoff === 1) return null;
  if (row.schedule_type !== "interval") return null;
  let spec: any = null;
  try { spec = JSON.parse(row.schedule_json || "{}"); } catch { spec = null; }
  const base = spec && spec.type === "interval" ? Number(spec.every_seconds) : NaN;
  if (!Number.isFinite(base) || base <= 0) return null;

  const runs = db.all<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM scheduled_task_runs
      WHERE schedule_id = ?1 ORDER BY scheduled_for DESC, created_at DESC LIMIT 12`,
    scheduleId,
  );
  const { cause, streak } = noProgressFromRuns(runs);

  // 回到原间隔（成功 / 换链 / 未达阈值都走这里；只在真的退避过时才写）
  const restore = () => {
    if ((row.backoff_streak ?? 0) === 0 && row.backoff_effective_seconds == null) return;
    // next_run_at 是 hub 的 TEXT UTC（无时区标记），必须走 parseHubTimestamp
    const cur = parseHubTimestamp(row.next_run_at);
    const next = cur === null
      ? row.next_run_at
      : new Date(Math.min(cur, now.getTime() + base * 1000)).toISOString();
    db.run(
      `UPDATE scheduled_tasks SET backoff_streak = 0, backoff_effective_seconds = NULL, next_run_at = ?1,
         updated_at = datetime('now') WHERE schedule_id = ?2 AND revision = ?3 AND status = 'active'`,
      [next, scheduleId, row.revision],
    );
  };

  if (!cause) { restore(); return null; }

  // 上限按原因分开：
  //   previous_run_active —— 上一次还在跑，30 分钟足够等到它结束；
  //   target_offline      —— 目标连续 6 次不在（按 180s 基底已是 18 分钟），
  //                          再用 3 分钟一次的节奏去敲没有意义；2 小时一次仍能及时接住它回来。
  // 判据：#2622「同类原因日增量 ≤20」——180s 基底配 2 小时上限 ⇒ 12 次/天。
  const cap = cause === "target_offline" ? 7200 : 1800;
  if (streak < from) { restore(); return null; }

  const effective = Math.min(cap, base * 2 ** Math.min(streak - from + 1, 5));
  const previous = row.backoff_effective_seconds ?? base;
  let next = row.next_run_at;
  // 🔴 生产实测（2026-10-28，`.181` 的两行日志）：
  //   offline-backoff        effective=5760s next_before=+180s   ← 退避值没推进去
  //   offline-backoff-final  next_after=+360s                    ← 二次 advance 又加了一个 base
  // 根因就在这里：原来用 `effective !== previous` 做守卫，退避一旦进入**稳态**（例如已是 5760），
  // 这个条件恒为 false ⇒ 不再推 next_run_at；而调用方在此之前刚 `advance()` 把 next 重置成 +base。
  // 于是「退避值写着 5760，实际每 360s 跳一次」，且永远不会自愈。
  // 正确语义：只要这一步是「同因跳过」，next_run_at 至少要 ≥ now + effective（只能往后推，不往前拉）。
  if (next) {
    const candidate = now.getTime() + effective * 1000;
    const existing = parseHubTimestamp(next);
    if (existing !== null) {
      next = new Date(Math.max(existing, candidate)).toISOString();
    }
  }
  db.run(
    `UPDATE scheduled_tasks SET backoff_streak = ?1, backoff_effective_seconds = ?2, next_run_at = ?3,
       updated_at = datetime('now') WHERE schedule_id = ?4 AND revision = ?5 AND status = 'active'`,
    [streak, effective, next, scheduleId, row.revision],
  );
  return { streak, effective_seconds: effective, cause };
}

/** GET /runs 的附加字段。 */
export function failureSummary(scheduleId: string): { consecutive_failures: number; failure_alert_threshold: number; last_failure_alert_at: string | null } {
  const streak = failureStreak(scheduleId);
  const alertAt = db.get<{ failure_alert_at: string | null }>("SELECT failure_alert_at FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId)?.failure_alert_at ?? null;
  return { consecutive_failures: streak.consecutiveFailures, failure_alert_threshold: failureNoticeRuns(), last_failure_alert_at: alertAt };
}

setScheduledRunTerminalHook((scheduleId, status) => {
  if (status === "failed") evaluateScheduleFailures(scheduleId);
  // #2622 —— 成功一次就把间隔恢复原样；失败则按连续失败次数放大间隔。
  try {
    applyFailureBackoff(scheduleId);
  } catch (e: any) {
    console.error(`[scheduled-tasks] failure backoff failed schedule=${scheduleId}: ${e?.message || e}`);
  }
});
