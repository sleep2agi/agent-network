// #2880 / #2881 —— 「空转排程」：先记录，默认**不**自动暂停。
//
// 现场（2026-10-28 生产只读）：
//   · TMA云盘欧 24h 接 44 单 **0 成功**，两个 180s 排程各跳过 147 / 68 次，占用 ~30.9h/天
//   · 另有若干排程 24h 内 129 次执行 / 129 次跳过 / 0 次成功
//   · 这些排程的 schedule_stuck 通知 7 天 1162 条（单个排程 220 条）⇒ 没人再看（#3161 正在限流）
//
// 治本不是「再多发一条通知」，而是让一直产不出东西的排程**停下来**。
// 但「自动停别人的排程」是行为变更，必须由人开启 —— 所以这里做成**默认关闭**的开关，
// 并在关闭状态下照样把「本来会被暂停哪些」打进日志：先让人看见候选，再决定要不要动手。
//
//   COMMHUB_SCHEDULE_STARVED_AUTOPAUSE=1     开启真正的暂停（默认关）
//   COMMHUB_SCHEDULE_STARVED_MIN_RUNS=20     窗口内至少这么多次执行才判定（默认 20）
//   COMMHUB_SCHEDULE_STARVED_WINDOW_HOURS=24 统计窗口（默认 24）
//
// 判据只用「窗口内执行次数 ≥ N 且成功 0 次」——不参杂跳过比例：
// 一个真在干活的排程不会 20 次全不成功；而「一天只跑一次且失败」的排程达不到 20，不会误伤。
import { db } from "./db.js";
import { sendAgentNotice } from "./agent-notice.js";

export const SCHEDULE_STARVED_KIND = "schedule_starved_paused";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function autopauseEnabled(): boolean {
  return String(process.env.COMMHUB_SCHEDULE_STARVED_AUTOPAUSE ?? "").trim() === "1";
}
export function starvedMinRuns(): number { return envInt("COMMHUB_SCHEDULE_STARVED_MIN_RUNS", 20, 1); }
export function starvedWindowHours(): number { return envInt("COMMHUB_SCHEDULE_STARVED_WINDOW_HOURS", 24, 1); }

export type ScheduleStats = { schedule_id: string; total: number; replied: number };

/** 纯函数：是否判定为空转。便于单测，不做任何 IO。 */
export function isStarved(s: { total: number; replied: number }, minRuns = starvedMinRuns()): boolean {
  return s.total >= minRuns && s.replied === 0;
}

export type StarvedScanResult = { paused: string[]; candidates: string[]; enabled: boolean };

/**
 * 扫一遍窗口内的排程产出。开启开关才真暂停；未开启只返回候选（供日志观察）。
 * 纯读 + 可选的一次状态写 + 一条通知，不改任务。
 */
export function scanStarvedSchedules(now = new Date()): StarvedScanResult {
  const windowHours = starvedWindowHours();
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = db.all<ScheduleStats>(
    `SELECT schedule_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied
       FROM scheduled_task_runs
      WHERE created_at >= ?1
      GROUP BY schedule_id`,
    since,
  );
  const candidates = rows.filter((r) => isStarved(r)).map((r) => r.schedule_id);
  if (!autopauseEnabled() || candidates.length === 0) {
    return { paused: [], candidates, enabled: autopauseEnabled() };
  }
  const paused: string[] = [];
  for (const scheduleId of candidates) {
    const info = db.get<{ network_id: string; created_by: string | null; name: string; target_alias: string | null }>(
      `SELECT network_id, created_by, name, target_alias FROM scheduled_tasks
        WHERE schedule_id = ?1 AND status = 'active'`,
      scheduleId,
    );
    if (!info) continue; // 已暂停/已完成/已取消：不重复处理
    const stats = rows.find((r) => r.schedule_id === scheduleId)!;
    db.run("UPDATE scheduled_tasks SET status = 'paused', updated_at = datetime('now') WHERE schedule_id = ?1", [scheduleId]);
    console.log(`[commhub schedule-starved] paused ${scheduleId} (${info.name}) — ${stats.total} 次执行 / 0 成功 in ${windowHours}h`);
    if (info.created_by) {
      try {
        sendAgentNotice({
          networkId: info.network_id,
          userId: info.created_by,
          fromAlias: info.target_alias ?? "hub",
          kind: SCHEDULE_STARVED_KIND,
          title: "定时任务已自动暂停（一直产不出结果）",
          text:
            `定时任务「${info.name}」在最近 ${windowHours} 小时内执行了 ${stats.total} 次，**没有一次成功**，已自动暂停。\n\n`
            + `常见原因：目标节点被人的 TUI 长期占着，任务根本没提交上去。\n`
            + `处理：确认节点可用后在排程页恢复；如果确实不需要了，直接停用。\n\n`
            + `（此动作由 COMMHUB_SCHEDULE_STARVED_AUTOPAUSE=1 开启；不设该变量时只记录不暂停。）`,
          severity: "warning",
          meta: { schedule_starved: { schedule_id: scheduleId, total: stats.total, replied: 0, window_hours: windowHours } },
          idPrefix: "dm_sstarved_",
        });
      } catch { /* 通知失败不影响已做出的暂停决定 */ }
    }
    paused.push(scheduleId);
  }
  return { paused, candidates, enabled: true };
}
