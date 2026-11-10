// 轮次在飞时「排队」的那一格的判据（纯函数，可单测）。
//
// 背景（#4415）：`setSelectedVariant` 在等不到空闲时会 ack `variant_busy` —— 这是诚实的
// （现在确实没生效）。但客户端那句「档位会对下一轮生效 —— 跑完再切」此前只是安慰：什么都不会发生。
// 现在节点把意图记下来，在这一轮结束时应用一次。这里只放两个必须能被单独钉住的判据：
//
//   ① 只在这一轮**恰好归零**时应用（不能在一轮还没结束时抢写）；
//   ② 排队**有上界**：一个几小时后突然生效的档位，比直接拒绝更坏。
export const QUEUED_VARIANT_TTL_MS = 10 * 60_000;

/** 排队是否已过期。非法时间戳（NaN/负）一律当作过期 —— 宁可不应用，也不要在错误时刻应用。 */
export function queuedVariantExpired(queuedAt: number, now: number, ttlMs: number = QUEUED_VARIANT_TTL_MS): boolean {
  if (!Number.isFinite(queuedAt) || !Number.isFinite(now) || !Number.isFinite(ttlMs)) return true;
  if (queuedAt <= 0 || ttlMs <= 0) return true;
  const age = now - queuedAt;
  if (age < 0) return true;      // 时间倒流 = 判据不可信
  return age > ttlMs;
}

/** 这一轮结束时该不该应用排队值。`inFlight` 必须是**递减之后**的值。 */
export function shouldApplyQueuedVariant(input: {
  hasQueued: boolean;
  inFlight: number;
  queuedAt: number;
  now: number;
  ttlMs?: number;
}): boolean {
  if (!input.hasQueued) return false;
  if (!Number.isFinite(input.inFlight) || input.inFlight !== 0) return false;
  return !queuedVariantExpired(input.queuedAt, input.now, input.ttlMs);
}
