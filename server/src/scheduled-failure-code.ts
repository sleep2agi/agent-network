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
