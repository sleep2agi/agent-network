// 档位写入要等「我方这一轮结束」的边界。
//
// 为什么需要它（2026-11-10 实测，通信欧 n_28e6b2c2）：
// `setSelectedVariant` 在 `inFlight > 0` 时直接抛 `variant_busy`，理由是对的 —— 档位只对
// 下一轮生效，中途改会悄悄改变正在跑的那一轮。但一台**正常在干活**的节点几乎总是有轮次在飞：
// 实测连续 14 次写入全被拒，只有重启后到下一轮开始前那几秒能落进去。
// 对用户来说，「点档位 → 被拒 → 自己再过一会儿重试」是不可接受的默认体验。
//
// 客户端的 `applied` 预算（MODEL_SWITCH_DEADLINE_MS）是 45 秒，所以这里给等待设上界，
// 等到了就写（`applied` 仍然只表示真的写入并回读一致），等不到还是诚实地说 busy。
export type IdleWaitOptions = {
  /** 还在忙吗？调用方给判据（例如 inFlight > 0 或会话已停止）。 */
  isBusy: () => boolean;
  /** 最多等多久；到点还没空就返回 false，绝不无限等。 */
  budgetMs: number;
  /** 轮询间隔，默认 250ms：足够细，又不至于把事件循环打满。 */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等到空闲（返回 true）或预算用尽（返回 false）。不会抛错。 */
export async function waitUntilIdle(opts: IdleWaitOptions): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 0;
  if (budgetMs <= 0) return !opts.isBusy();
  const deadline = now() + budgetMs;
  // 先看一次：绝大多数调用发生时本来就是空闲的，不该先睡一个 interval。
  if (!opts.isBusy()) return true;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (!opts.isBusy()) return true;
  }
  return false;
}
