// B（止血）：acked 但 N 分钟内没有任何回复 ⇒ 判为「签收但没投递」，回退未读 + 告警。
//
// 背景（负责人 2026-11-20 真事故）：tmux 关窗后遗留的孤儿进程仍持有节点令牌，
// 它把消息 ack 了（Hub 记「已签收」），但已经没有活连接去真正投递进对话 ⇒
// admin 看到的是「acked 但一小时没人回」。SSE 层的「新连接踢旧连接」挡不住这条，
// 因为 ack 是一次性 HTTP 调用，Hub 不知道它来自哪条（甚至已死的）连接。
//
// 口径（负责人 定 ①）：以「该 alias 在窗口内是否产生过任何回复」作为投递证据，纯 Hub 侧可算。
// 这里只放判定与登记；扫描/回退/告警由调用方（Hub 的定时器 + inbox 表）执行。

export type AckRecord = {
  messageId: string;
  alias: string;
  networkId: string | null;
  ackedAtMs: number;
  hasReply: boolean;
  /**
   * 这条消息是否期待一个回复。
   *
   * 口径 ①（「该 alias 在窗口内是否产生过任何回复」作投递证据）只对**期待回复**的行成立：
   * 通知 / 节点间回执这类 `requires_response = 'none'` 的行，ack 本身就是终点，
   * 没有回复可等。把它们也拉进回退窗口 ⇒ ack 10 分钟后被回退成未读 ⇒ hub 重新投递 ⇒
   * 节点再 ack ⇒ 再回退……全网都在原地打转（生产实测：orphan 通知 50 条 / idem 262 条
   * 被反复回退，29,856 条 reply 型 inbox 行处于未读状态）。
   */
  expectsResponse: boolean;
  /** 这条 ack 对应的逻辑任务 id（task 行的 tasks.task_id；非任务行可能是 inbox 行 id）。 */
  taskId: string | null;
};

export type SweepVerdict =
  | { kind: "pending"; msLeft: number }
  | { kind: "delivered" }
  | { kind: "unconfirmed"; waitedMs: number };

/**
 * 这一行到底期不期待一个回复？（决定它要不要进 B 止血的回退窗口）
 *
 * 口径：
 *   - `requires_response = 'none'` ⇒ 不期待（通知 / 节点间回执的显式声明）；
 *   - `type = 'message'` ⇒ 不期待。普通聊天消息**不会被交给模型**（agent-node 的
 *     `inboxDeliveryPolicy`：message ⇒ deliverToRuntime=false），收件方只会 ack 一条，
 *     永远不会产出回复 ⇒ 等回复等于等一个永远不会来的东西 ⇒ 10 分钟后必被回退 ⇒
 *     重投 ⇒ 再 ack ⇒ 再回退（生产实测：497 条 message 行 / 24h，ANet负责人 一台就回退 920 次）；
 *   - `type = 'reply'` ⇒ 不期待。别人的任务结果行，回它就变成乒乓（agent-node 的
 *     `replyExpected=false`：结果要立刻进模型，但绝不能再回一条）。
 *
 * 注意 `send_message` 早期没显式写 `requires_response`，吃的是列默认值 `'reply'`，
 * 所以库里存着大量「message 行却标着 reply」的旧行 —— 这里按 type 兜底，新写入的行
 * 则由 `send_message` 直接写 `'none'`（见 tools.ts）。
 */
export function rowExpectsResponse(row: { type?: string | null; requiresResponse?: string | null }): boolean {
  if (row.requiresResponse === "none") return false;
  const type = String(row.type ?? "task").toLowerCase();
  if (type === "message" || type === "reply") return false;
  return true;
}

/** 单条消息的判定：窗口内有回复 ⇒ delivered；窗口到期仍无回复 ⇒ unconfirmed。 */
export function verdictFor(r: AckRecord, nowMs: number, windowMs: number): SweepVerdict {
  if (r.hasReply) return { kind: "delivered" };
  const waited = nowMs - r.ackedAtMs;
  if (waited >= windowMs) return { kind: "unconfirmed", waitedMs: waited };
  return { kind: "pending", msLeft: windowMs - waited };
}

/** 记录「这条被签收了」；同一 (alias, messageId) 重复调用取最早一次（幂等）。 */
const acks = new Map<string, AckRecord>();
const keyOf = (alias: string, networkId: string | null, messageId: string) => `${networkId ?? "global"}:${alias}:${messageId}`;

/**
 * 已经回退过一次的消息不再登记：第二次签收就是终态。
 *
 * 为什么（2026-11-23 实测）：回退没有次数上限时，一个只收不回的节点会把同一批消息每 10 分钟
 * 重新投递一遍——同伴发来的进度通报本来就不需要回复，却被反复塞进对话，白白消耗额度。
 * 一次回退足以救回「孤儿进程签收」那种情况（下一次由活着的连接签收）；之后再不回复就不是投递问题了。
 */
const revertedOnce = new Set<string>();
const REVERTED_ONCE_MAX = 20_000;
const rememberReverted = (k: string) => {
  revertedOnce.add(k);
  if (revertedOnce.size > REVERTED_ONCE_MAX) revertedOnce.delete(revertedOnce.values().next().value as string);
};

/**
 * 「这个 alias 已经回复过某个任务」的证据（任务粒度）。
 *
 * 为什么需要它：节点的正常顺序是「先回执、后 ack 收件箱」（实测日志里两者只差 2 秒）。
 * 只看「窗口内有没有回复」的话，**回复早于 ack 登记**的那条就永远等不到证据 ⇒
 * 10 分钟后被回退成未读 ⇒ Hub 重投 ⇒ 节点再处理一遍（同一笔任务重复劳动，
 * 生产日志里同一条 idem_797 被回退两次）。
 * 这里把「已回复过某个任务」记下来（带 TTL），ack 登记时回查一次，顺序就无所谓了。
 */
const repliedTasks = new Map<string, number>();
const taskKeyOf = (alias: string, networkId: string | null, taskId: string) => `${networkId ?? "global"}:${alias}:${taskId}`;
const REPLIED_TASK_TTL_MS = 60 * 60 * 1000;

export function markAcked(input: { messageId: string; alias: string; networkId: string | null; nowMs?: number; expectsResponse?: boolean; taskId?: string | null }): void {
  const k = keyOf(input.alias, input.networkId, input.messageId);
  if (acks.has(k) || revertedOnce.has(k)) return;
  const nowMs = input.nowMs ?? Date.now();
  const taskId = input.taskId ?? null;
  // 回执早于 ack 登记 ⇒ 用「这个 alias 已经回复过这个任务」作投递证据（见 repliedTasks）。
  const repliedAt = taskId ? repliedTasks.get(taskKeyOf(input.alias, input.networkId, taskId)) : undefined;
  const hasReply = repliedAt !== undefined && nowMs - repliedAt <= REPLIED_TASK_TTL_MS;
  acks.set(k, {
    messageId: input.messageId,
    alias: input.alias,
    networkId: input.networkId,
    ackedAtMs: nowMs,
    hasReply,
    // 默认 true：拿不准时按旧口径（等回复）处理，不改变既有行为。
    expectsResponse: input.expectsResponse ?? true,
    taskId,
  });
}

/**
 * 该 alias 产生过任何出站内容时调用：把窗口内所有待确认记录标成已投递。
 * 「出站内容」包括回复（send_reply / send_peer_reply）和发给别的节点的任务（send_task）——
 * 节点之间就是用 send_task 往来的，只认回复会把正常工作的节点判成「没投递」。
 */
export function markReply(alias: string, networkId: string | null, opts?: { inReplyTo?: string | null; nowMs?: number }): void {
  for (const r of acks.values()) if (r.alias === alias && r.networkId === networkId) r.hasReply = true;
  const taskId = opts?.inReplyTo ?? null;
  if (!taskId) return;
  // 任务粒度证据：记住「这个 alias 回复过这个任务」，让随后才登记的 ack 也能算已投递。
  repliedTasks.set(taskKeyOf(alias, networkId, taskId), opts?.nowMs ?? Date.now());
  // 精确匹配：回复的就是这条消息 / 这个任务 ⇒ 它自己的 ack 记录直接算已投递。
  for (const r of acks.values()) {
    if (r.alias !== alias || r.networkId !== networkId) continue;
    if (r.taskId === taskId || r.messageId === taskId) r.hasReply = true;
  }
  if (repliedTasks.size > 10_000) {
    const cutoff = Date.now() - REPLIED_TASK_TTL_MS;
    for (const [k, at] of repliedTasks) if (at < cutoff) repliedTasks.delete(k);
  }
}

/** 扫描：返回需要回退未读的条目，并把它们从登记里移除（避免重复告警）。 */
export function sweepUnconfirmed(nowMs: number, windowMs: number): AckRecord[] {
  const out: AckRecord[] = [];
  for (const [k, r] of acks) {
    // 不期待回复的行：ack 即终点，直接清掉，不进回退窗口（见 AckRecord.expectsResponse）。
    if (!r.expectsResponse) { acks.delete(k); continue; }
    const v = verdictFor(r, nowMs, windowMs);
    if (v.kind === "unconfirmed") { out.push(r); acks.delete(k); rememberReverted(k); }
    else if (v.kind === "delivered") acks.delete(k);
  }
  return out;
}

export function _resetForTest(): void { acks.clear(); revertedOnce.clear(); repliedTasks.clear(); }
export function _sizeForTest(): number { return acks.size; }
