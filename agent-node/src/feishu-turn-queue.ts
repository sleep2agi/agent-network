// 可操作的入站队列 —— 不只是"排队"，而是"能看见、能改、能撤"。
//
// 现状（2026-11-03 之前）：串行靠 agent-node 的 thinkQueue（一条 promise 链）。
// 它保证不并发，但它是一个**没有把手**的队列：
//   · 看不见排了谁（只有一句"前面还有 N 条"）
//   · 改不了顺序（先来的永远先跑）
//   · 撤不掉（已经排上的只能等它跑完）
//
// 对用户来说，"发了但还没跑"和"发了但被吞了"是一回事 —— 因为没有任何动作能让它不一样。
//
// 这个模块把队列变成**有把手的**：
//   list()      看见排了谁（每人一条，带 id 与位置）
//   cancel(id)  撤掉还没开始的那条（已经在跑的不动 —— 那是另一件事，叫打断）
//   promote(id) 提到队首（"这条先"）
//   优先级      入队时带 priority，high 插到队首区，其余 FIFO
//
// 三条边界：
//   ① cancel 只对**未开始**的条目生效。已经在跑的回合不能被"删除"，
//      只能被"打断"（另一套机制，V2 有 steer；不在本模块范围）。
//   ② 撤回是**幂等**的：找不到就是 false，不抛错 —— 用户连点两下不该收到异常。
//   ③ 队列里只放**引用**，不放正文：撤回时正文一起丢，不留残影在内存里。

export type TurnPriority = "high" | "normal";

export interface QueuedTurn<T = unknown> {
  /** 对外可见的短 id（用户在 /q 里看到的就是它）。 */
  id: string;
  /** 谁发的（open_id 或别名），用于"只能撤自己的"。 */
  sender: string;
  priority: TurnPriority;
  enqueuedAt: number;
  /** 载荷由调用方定义（这里是给 processTask 用的参数）。 */
  payload: T;
}

export interface QueueSnapshotEntry {
  id: string;
  sender: string;
  priority: TurnPriority;
  /** 1 = 下一条就轮到它。 */
  position: number;
  waitedMs: number;
}

/**
 * 串行队列 + 操作把手。
 *
 * `start` 由调用方提供：每条出队时被调用一次，返回 Promise。
 * 队列保证**同时只有一条在跑**（与 thinkQueue 的语义一致），
 * 区别是排队中的条目可以被看见、被提权、被撤回。
 */
export class TurnQueue<T = unknown> {
  private waiting: QueuedTurn<T>[] = [];
  private running: QueuedTurn<T> | null = null;
  private seq = 0;
  private draining = false;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** 入队。返回 id —— 用户拿它来 cancel/promote。 */
  push(input: { sender: string; priority?: TurnPriority; payload: T }): string {
    const id = `q${++this.seq}`;
    const entry: QueuedTurn<T> = {
      id,
      sender: input.sender,
      priority: input.priority ?? "normal",
      enqueuedAt: this.now(),
      payload: input.payload,
    };
    // high 插到"尚未插队"的最前面（保持 high 之间 FIFO）
    if (entry.priority === "high") {
      const firstNormal = this.waiting.findIndex((e) => e.priority !== "high");
      if (firstNormal === -1) this.waiting.push(entry);
      else this.waiting.splice(firstNormal, 0, entry);
    } else {
      this.waiting.push(entry);
    }
    return id;
  }

  /** 还能被撤/被提权的那些（按执行顺序）。 */
  list(): QueueSnapshotEntry[] {
    const t = this.now();
    return this.waiting.map((e, i) => ({
      id: e.id,
      sender: e.sender,
      priority: e.priority,
      position: i + 1,
      waitedMs: Math.max(0, t - e.enqueuedAt),
    }));
  }

  /** 正在跑的那条（null = 空闲）。撤不动它 —— 那是"打断"的事。 */
  current(): { id: string; sender: string } | null {
    return this.running ? { id: this.running.id, sender: this.running.sender } : null;
  }

  /** 撤回**未开始**的条目。幂等：找不到返回 false，不抛。 */
  cancel(id: string): boolean {
    const i = this.waiting.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  /** 提到队首（在已排的 high 之后、normal 之前）。 */
  promote(id: string): boolean {
    const i = this.waiting.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [entry] = this.waiting.splice(i, 1);
    entry.priority = "high";
    const firstNormal = this.waiting.findIndex((e) => e.priority !== "high");
    if (firstNormal === -1) this.waiting.push(entry);
    else this.waiting.splice(firstNormal, 0, entry);
    return true;
  }

  /** 撤掉所有未开始的（管理员用；正在跑的不动）。 */
  clear(filter?: (e: QueueSnapshotEntry) => boolean): number {
    if (!filter) {
      const n = this.waiting.length;
      this.waiting = [];
      return n;
    }
    const snapshot = this.list();
    const drop = new Set(snapshot.filter(filter).map((e) => e.id));
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((e) => !drop.has(e.id));
    return before - this.waiting.length;
  }

  get size(): number {
    return this.waiting.length;
  }

  /**
   * 串行执行：一直跑到队列空。`start` 抛错不会中断队列（下一条继续）。
   * `onError` 用于把失败报给调用方（默认吞掉 —— 队列本身不该因为一轮失败而停）。
   */
  async drain(
    start: (entry: QueuedTurn<T>) => Promise<void>,
    onError?: (error: unknown, entry: QueuedTurn<T>) => void,
  ): Promise<void> {
    if (this.draining) return; // 已有 drain 在跑，它会接着处理新入队的
    this.draining = true;
    try {
      while (this.waiting.length > 0) {
        const entry = this.waiting.shift()!;
        this.running = entry;
        try {
          await start(entry);
        } catch (error) {
          onError?.(error, entry);
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/** 队列上限：超过就不再收，明确告诉用户，而不是让它无限排队。 */
export const MAX_QUEUED_TURNS = 20;

/**
 * 队列满了的时候该回什么；没满返回空串（正常入队）。
 *
 * 为什么要有上限：没有上限时，"连发 50 条"会排出 50 轮，
 * 用户看到的是一个越来越长的等待且**没有任何拒绝** —— 那比直接说"满了"更糟，
 * 因为它给了"我发的每条都会被处理"的错觉。
 */
export function queueFullNotice(size: number, max = MAX_QUEUED_TURNS): string {
  if (!Number.isFinite(size) || size < max) return "";
  return `⏳ 排队已满（${max} 条）。这条**没有排上**，请等我处理完再发 —— 现在发更多只会排更久。`;
}
