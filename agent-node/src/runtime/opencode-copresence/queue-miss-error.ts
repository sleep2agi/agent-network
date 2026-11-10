// #4481 —— V2 共享会话里「turn 离开队列但没执行」这条错误的判据与文案。
//
// 原来的抛点（v2-session.ts）只带一句 `(removed in the TUI?)`，把所有可能的原因
// 都指向了同一个方向。读码后至少有三种情况会被压成这一条：
//
//   A  真的没跑（TUI 里被移除 / 被压缩掉）
//   B  跑了而且跑完了，但我们的 correlator 没认出来 ——
//      `readEntriesAfter` 是**倒序分页**找 messageId，窗口是 HISTORY_MAX_PAGES × HISTORY_PAGE_LIMIT；
//      一轮跑得久、条目多，messageId 就可能落到窗口之外 ⇒ 返回 null，
//      而 inbox 里早就没有它了 ⇒ 两次未命中 ⇒ 误报「没跑」。
//   C  会话换了（重启/切换），新会话历史里当然没有旧 messageId。
//
// 这一版**不改判定逻辑**（那需要新的 correlator，风险更高），只做两件事：
//   1. 错误文案带上能被排障用的判据（misses / 是否曾进过历史 / 等多久 / 会话与消息 id）；
//   2. 用 `variant` 把 A/B/C 分成不同 code，别再把三种原因统称「被 TUI 移除」。
//
// 纯函数：这条文案要被单测钉住，而单测不该需要一台活着的 v2 server。

export type QueueMissCause =
  | 'never_queued'      // 从来没在 inbox 里见过它
  | 'left_queue_unrun'  // 见过在队列里，之后既不在队列也不在历史里
  | 'history_window_miss'; // 有历史活动但找不到这个 id（最可能是 B：分页窗口）

export interface QueueMissInput {
  sessionId: string;
  messageId: string;
  /** 连续「既不在队列也不在历史」的次数。 */
  misses: number;
  /** 等了多少毫秒（从提交 prompt 算起）。 */
  waitedMs: number;
  /** 期间是否曾经见到它出现在历史里（delivered）。 */
  everDelivered: boolean;
  /** 期间是否曾经见到它在 inbox 里。 */
  everQueued: boolean;
}

export interface QueueMissVerdict {
  cause: QueueMissCause;
  message: string;
}

const ms = (v: number) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : -1);

export function queueMissVerdict(input: QueueMissInput): QueueMissVerdict {
  const cause: QueueMissCause = input.everDelivered
    ? 'history_window_miss'
    : input.everQueued
      ? 'left_queue_unrun'
      : 'never_queued';
  // 文案分两层：第一行是「发生了什么」（人能读），第二行是判据（能贴进日志被 grep）。
  const headline = cause === 'left_queue_unrun'
    ? 'OpenCode v2 network turn left the queue without running'
    : cause === 'never_queued'
      ? 'OpenCode v2 network turn was never observed in the queue'
      : 'OpenCode v2 network turn is not findable in history (paging window)';
  const detail = [
    `cause=${cause}`,
    `misses=${ms(input.misses)}`,
    `waited_ms=${ms(input.waitedMs)}`,
    `ever_queued=${input.everQueued}`,
    `ever_delivered=${input.everDelivered}`,
    `session=${input.sessionId}`,
    `message=${input.messageId}`,
  ].join(' ');
  return { cause, message: `${headline} (${detail})` };
}
