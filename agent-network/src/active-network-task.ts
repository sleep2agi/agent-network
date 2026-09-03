// #1770 —— outbound-only 模式下,模型对「当前网络任务的发起方」自己再发一遍
// send_task / send_message,会让发起方收到同一句话三次(其中一条还是 high)。
//
// node-server 进程本来不知道运行时正替谁跑哪条任务(任务是运行时注入 PTY 的文本)。
// 运行时把当前网络任务写进一个标记文件(agent-node 的 active-network-task-marker.ts),
// 这里只做两件纯函数的事:读懂那个文件、决定要不要把出站改写成对该任务的进度上报。
//
// 改写成的是 **report_status(非终态、不推送)**,和模型显式调 commhub_reply(status=in_progress)
// 走的是同一条路;运行时随后发的终态 reply 仍是唯一推到发起方的那条。

export interface ActiveNetworkTask {
  taskId: string;
  from: string;
  startedAt: number;
}

/** 运行时崩溃没来得及删标记时的兜底:超过这个年龄的标记当不存在。 */
export const ACTIVE_NETWORK_TASK_MAX_AGE_MS = 30 * 60_000;

export function parseActiveNetworkTask(
  raw: string | null | undefined,
  now: number,
  maxAgeMs: number = ACTIVE_NETWORK_TASK_MAX_AGE_MS,
): ActiveNetworkTask | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  const from = typeof record.from === "string" ? record.from.trim() : "";
  const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : NaN;
  if (!taskId || !from || !Number.isFinite(startedAt)) return null;
  if (now - startedAt > maxAgeMs || startedAt - now > 60_000) return null;
  return { taskId, from, startedAt };
}

export type OutboundTool = "commhub_send_task" | "commhub_send_message";

export type OutboundRewrite =
  | { kind: "pass" }
  | { kind: "progress_of_active_task"; taskId: string; from: string; text: string };

/**
 * 只在「目标 alias 恰好是当前网络任务的发起方」时改写;发给别人的照常放行——
 * 模型替任务派活给第三方是合法的协作,不能一刀切。
 */
export function decideOutboundRewrite(
  tool: OutboundTool,
  args: { alias?: unknown; task?: unknown; message?: unknown } | null | undefined,
  active: ActiveNetworkTask | null,
): OutboundRewrite {
  if (!active) return { kind: "pass" };
  const alias = typeof args?.alias === "string" ? args.alias.trim() : "";
  if (!alias || alias !== active.from) return { kind: "pass" };
  const body = tool === "commhub_send_task" ? args?.task : args?.message;
  const text = typeof body === "string" ? body : String(body ?? "");
  return { kind: "progress_of_active_task", taskId: active.taskId, from: active.from, text };
}

/** outbound-only 模式下模型不能自选 high(#1770 第三条):降为 normal,其余原样。 */
export function clampOutboundPriority(
  priority: unknown,
  outboundOnly: boolean,
): "high" | "normal" | "low" | undefined {
  if (priority !== "high" && priority !== "normal" && priority !== "low") return undefined;
  if (outboundOnly && priority === "high") return "normal";
  return priority;
}
