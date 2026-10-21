// #1879/#1566 ③ —— 排队项的**归属**与**终止**。
//
// 前两样已经在 main 上：
//   ① 可见状态：busy-note.ts 报「共享会话忙，任务还没提交，已等 3 分 20 秒」；
//   ② 上限与过期：runtime.ts 的 OpenCodeCopresenceTimeoutError 点名「共享会话忙」，
//      并说明「不是节点卡死」。
//
// 这一格是第三样：**排队项要绑定到具体的 task 与提交者；共享会话的负责人（TUI）
// 离开时，要重新提交或明确终止（owner_left），而不是沉默地等满 30 分钟后报一个
// 泛泛的「忙」。**
//
// 两条判定：
//   • 会话**还在**（GET /session/:id 还能拿到记录）⇒ 负责人只是暂时不在，等它空闲
//     后照常提交（这是「重新提交」那一半，行为不变）。
//   • 会话**不在了**（GET /session/:id 明确 404）⇒ 负责人已经离开且会话没了，
//     排队中的任务没有可投递的目标 ⇒ 明确终止，理由 owner_left。
//
// 404 的形状来自 http.ts：`OpenCode GET /session/x returned HTTP 404`。
// 这里用消息匹配而不是改 http.ts 的错误类型，是为了让这个纯函数模块不依赖网络层。
//
// 纯函数：不碰 react-native、不发请求、不读文件。

export interface QueueOwnerBinding {
  /** Hub 侧的任务 id；拿不到就是 null（不猜、不编）。 */
  taskId: string | null;
  /** 提交者 alias。 */
  sender: string | null;
  /** 开始等共享会话的时刻（ms）。 */
  sinceMs: number;
}

export interface QueueOwnerInput {
  taskId?: string | null;
  sender?: string | null;
  sinceMs: number;
}

/** 归一化：空串/空白/null 一律当作「不知道」，不把空值写进状态文本。 */
export function bindQueueOwner(input: QueueOwnerInput): QueueOwnerBinding {
  const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : null;
  const sender = typeof input.sender === "string" && input.sender.trim() ? input.sender.trim() : null;
  return { taskId, sender, sinceMs: input.sinceMs };
}

/** 「这条排队项是谁的」——给人看的一行，不给机器解析。 */
export function queueOwnerLabel(binding: QueueOwnerBinding): string {
  if (binding.taskId && binding.sender) return `任务 ${binding.taskId}（由 ${binding.sender} 提交）`;
  if (binding.taskId) return `任务 ${binding.taskId}`;
  if (binding.sender) return `由 ${binding.sender} 提交的任务`;
  return "任务";
}

/**
 * 判定「负责人是否已经离开」需要**连续**确认，不能靠一次 404。
 *
 * 两次门槛都要满足：
 *   • 连续观测次数 ≥ OWNER_LEFT_CONFIRM_POLLS（防单次抖动）；
 *   • 连续观测时长 ≥ OWNER_LEFT_CONFIRM_MS（防快速抖动）。
 *
 * 门槛不满足就继续等 —— 宁可多等，也不把一个还在的会话误判成「人走了」。
 */
export const OWNER_LEFT_CONFIRM_POLLS = 3;
export const OWNER_LEFT_CONFIRM_MS = 2_000;

export type OwnerLeftDecision = "keep_waiting" | "owner_left";

export function ownerLeftDecision(input: {
  missingPolls: number;
  missingSinceMs: number;
  nowMs?: number;
}): OwnerLeftDecision {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.missingPolls) || input.missingPolls < OWNER_LEFT_CONFIRM_POLLS) return "keep_waiting";
  if (!Number.isFinite(input.missingSinceMs)) return "keep_waiting";
  if (nowMs - input.missingSinceMs < OWNER_LEFT_CONFIRM_MS) return "keep_waiting";
  return "owner_left";
}

/** http.ts 抛的 404 形状：`OpenCode GET /session/x returned HTTP 404`。 */
export function isSessionGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bHTTP 404\b/.test(message);
}

/**
 * 终止文案。
 *
 * 要点：
 *   • 说清是**负责人离开了**、会话也不在了（不是节点卡死、不是模型问题）；
 *   • 点名这条排队项归谁（归属）；
 *   • 带上 owner_left 这个稳定标记，客户端/看板/日志都能按它归类；
 *   • 说明这一轮没有发出，可以重发。
 */
export function ownerLeftText(binding: QueueOwnerBinding): string {
  return `opencode 任务未提交：共享会话的负责人（TUI）已经离开，会话也不在了 —— 排队中的${queueOwnerLabel(binding)}已被明确终止（owner_left），不是节点卡死。这一轮没有发出，可稍后重发。`;
}
