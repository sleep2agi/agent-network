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

export function markAcked(input: { messageId: string; alias: string; networkId: string | null; nowMs?: number; expectsResponse?: boolean }): void {
  const k = keyOf(input.alias, input.networkId, input.messageId);
  if (acks.has(k)) return;
  acks.set(k, {
    messageId: input.messageId,
    alias: input.alias,
    networkId: input.networkId,
    ackedAtMs: input.nowMs ?? Date.now(),
    hasReply: false,
    // 默认 true：拿不准时按旧口径（等回复）处理，不改变既有行为。
    expectsResponse: input.expectsResponse ?? true,
  });
}

/** 该 alias 产生过任何出站内容时调用：把窗口内所有待确认记录标成已投递。 */
export function markReply(alias: string, networkId: string | null): void {
  for (const r of acks.values()) if (r.alias === alias && r.networkId === networkId) r.hasReply = true;
}

/** 扫描：返回需要回退未读的条目，并把它们从登记里移除（避免重复告警）。 */
export function sweepUnconfirmed(nowMs: number, windowMs: number): AckRecord[] {
  const out: AckRecord[] = [];
  for (const [k, r] of acks) {
    // 不期待回复的行：ack 即终点，直接清掉，不进回退窗口（见 AckRecord.expectsResponse）。
    if (!r.expectsResponse) { acks.delete(k); continue; }
    const v = verdictFor(r, nowMs, windowMs);
    if (v.kind === "unconfirmed") { out.push(r); acks.delete(k); }
    else if (v.kind === "delivered") acks.delete(k);
  }
  return out;
}

export function _resetForTest(): void { acks.clear(); }
export function _sizeForTest(): number { return acks.size; }
