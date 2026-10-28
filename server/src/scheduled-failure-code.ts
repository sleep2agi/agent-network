// #1879 —— 定时任务失败分类（纯函数，不 import db，便于单测）。
//
// 生产 24h（2026-10-28）：144 条 failed run 的 error_code 全是 `task_failed`，
// 但其中 125 条（66%）的真实原因是「共享会话被人的 TUI 占着，任务 30 分钟内没提交上去」。
// 混在一个桶里，报表分不出来，也没法给它们配不同策略。
//
// 只做分类，**不改等待语义**：近 24h 有 108 个任务是等到 >25 分钟才成功的，
// 「忙就立刻失败」会打掉它们。
//
// `failureStreak()` 按 status='failed' 计数（不是按 error_code），所以新增一个 code
// 不影响「连续 N 次失败告警 / 自动暂停」的阈值。
export function scheduledFailureCode(status: string, result: string | null): string | null {
  if (status === "replied") return null;
  const base = `task_${status}`;
  if (status !== "failed") return base;
  const text = result ?? "";
  if (/共享会话/.test(text) && /忙碌|一直处于|未获提交/.test(text)) return "task_failed_busy";
  if (/仍在节点的 TUI 会话里运行|等待回复已达\s*30\s*分钟/.test(text)) return "task_failed_busy";
  return base;
}

// #2884 —— 「排了多久」和「会话等了多久」是两个量，别用同一个数字代表。
//
// 现场（2026-10-27 实测，tasks 表 created_at → started_at → completed_at）：
//   一条 412 分钟才失败的任务，拆开是 **排队 382 分钟 + 会话等待 30.1 分钟**。
//   失败文案只说了「30 分钟」，因为 30 分钟是「轮到它之后等共享会话空出来」的预算；
//   在轮到自己**之前**的排队既没有上限、也没有被写进文案。
//
// 后果不是文案不好看，是报表失真：按 error_code 聚合时这 180 条（94%）都被算成
// 「共享会话忙」，于是「排队几小时」这一层被彻底掩盖 —— 而它才是能操作的那一层
// （加节点 / 减排程 / 拉间隔），会话忙只能等人离开 TUI。
//
// 这里只做**如实测量与上报**，不改等待语义：fail fast 会改变派发行为，
// 要单独定阈值（排队上限独立成卡）。阈值是不变量，得先有数再选。

function parseDbTime(v: string | null | undefined): number | null {
  if (!v) return null;
  // 库里是 `YYYY-MM-DD HH:MM:SS`（UTC，无 Z），直接 Date.parse 会按本地时区解释。
  const ms = Date.parse(`${String(v).replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function fmtMinutes(ms: number): string {
  const min = ms / 60_000;
  if (min >= 100) return `${Math.round(min)} 分钟`;
  return `${(Math.round(min * 10) / 10).toString()} 分钟`;
}

/**
 * 把一条失败任务拆成「排队 / 会话等待」两段，供 run 记录展示。#2884
 *
 * 读不出时刻就不编：宁可只说总计，也不把两段硬凑成 30 分钟。
 */
export function busyElapsedNote(
  createdAt: string | null | undefined,
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string | null {
  const created = parseDbTime(createdAt);
  const completed = parseDbTime(completedAt);
  if (created === null || completed === null) return null;
  const total = completed - created;
  if (!(total >= 0)) return null;
  const started = parseDbTime(startedAt);
  if (started === null) {
    return `实测总耗时 ${fmtMinutes(total)}（节点未上报开始处理的时刻，无法拆出排队与会话等待）`;
  }
  const queued = Math.max(0, started - created);
  const waited = Math.max(0, completed - started);
  return `实测总耗时 ${fmtMinutes(total)}：排队 ${fmtMinutes(queued)}（任务创建→节点开始处理）`
    + ` + 会话等待 ${fmtMinutes(waited)}（节点开始处理→失败）。`
    + `失败文案里的等待上限只代表后一段，不代表总共等了多久。`;
}
