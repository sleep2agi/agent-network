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
};

export type SweepVerdict =
  | { kind: "pending"; msLeft: number }
  | { kind: "delivered" }
  | { kind: "unconfirmed"; waitedMs: number };

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

export function markAcked(input: { messageId: string; alias: string; networkId: string | null; nowMs?: number }): void {
  const k = keyOf(input.alias, input.networkId, input.messageId);
  if (acks.has(k) || revertedOnce.has(k)) return;
  acks.set(k, { messageId: input.messageId, alias: input.alias, networkId: input.networkId, ackedAtMs: input.nowMs ?? Date.now(), hasReply: false });
}

/**
 * 该 alias 产生过任何出站内容时调用：把窗口内所有待确认记录标成已投递。
 * 「出站内容」包括回复（send_reply / send_peer_reply）和发给别的节点的任务（send_task）——
 * 节点之间就是用 send_task 往来的，只认回复会把正常工作的节点判成「没投递」。
 */
export function markReply(alias: string, networkId: string | null): void {
  for (const r of acks.values()) if (r.alias === alias && r.networkId === networkId) r.hasReply = true;
}

/** 扫描：返回需要回退未读的条目，并把它们从登记里移除（避免重复告警）。 */
export function sweepUnconfirmed(nowMs: number, windowMs: number): AckRecord[] {
  const out: AckRecord[] = [];
  for (const [k, r] of acks) {
    const v = verdictFor(r, nowMs, windowMs);
    if (v.kind === "unconfirmed") { out.push(r); acks.delete(k); rememberReverted(k); }
    else if (v.kind === "delivered") acks.delete(k);
  }
  return out;
}

export function _resetForTest(): void { acks.clear(); revertedOnce.clear(); }
export function _sizeForTest(): number { return acks.size; }
