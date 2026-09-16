// #1900(2026-09-16,TMHR鲸 实测 + 生产 hub 库核对):codex-app-server 是串行队列,任务排队期间 agent 用
// list_tasks/get_inbox 看到并提前回了,轮到它时运行时照常提交 ⇒ 已终态任务又跑一轮;这一轮的终态还会
// 覆写邻近任务(ca9d5ca4 由 acked 翻 failed)、让子任务回件替答人类提问(#1896)。出队提交前先问 hub
// 一次:已终态就不起 turn。hub 查不到/查询失败 → 不拦(fail-open:宁可多跑一轮,不能把真任务吞掉)。
export const TERMINAL_TASK_STATUSES = new Set(["replied", "failed", "cancelled", "expired"]);

export function isTerminalTaskStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_TASK_STATUSES.has(status);
}

export interface TerminalGuardVerdict {
  skip: boolean;
  status: string | null;
  reason: "terminal" | "open" | "not-found" | "lookup-failed" | "no-task-id";
}

export async function shouldSkipTerminalTask(
  getTask: (taskId: string) => Promise<{ ok?: boolean; task?: { status?: unknown } | null } | null | undefined>,
  taskId: string | null | undefined,
): Promise<TerminalGuardVerdict> {
  if (!taskId) return { skip: false, status: null, reason: "no-task-id" };
  let res: Awaited<ReturnType<typeof getTask>>;
  try { res = await getTask(taskId); } catch { return { skip: false, status: null, reason: "lookup-failed" }; }
  if (!res || res.ok === false || !res.task) return { skip: false, status: null, reason: "not-found" };
  const status = typeof res.task.status === "string" ? res.task.status : null;
  return isTerminalTaskStatus(status) ? { skip: true, status, reason: "terminal" } : { skip: false, status, reason: "open" };
}
