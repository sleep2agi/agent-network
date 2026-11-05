// #4010 —— 「没有进展」才计时，而不是「总时长」。
//
// 现场（2026-11-06，admin 截图）：伪神明（claude-agent-sdk）执行一次页面优化时
//   各次 300s 超时 / 期间没有任何响应，3 次尝试 ⇒ 用户等 15 分钟后只拿到一句错误。
//
// 根因：`withTimeout()` 是**纯墙钟 race** —— 定时器一响就 abort，不看有没有进展。
// 于是「慢但一直在输出 tool_use」与「真的卡死」被判成同一件事，处置却相反：
//   前者该继续跑，后者该立刻报。
//
// 这个模块只做一件事：把「是否还在动」变成可观测的量。
// 它**不**决定超时后怎么办（重试/报错/继续等），那是调用方的事 —— 因为
// 「同一个错误码，在两种成因下要做的下一步相反」是这类 bug 的共同形状。
//
// 三条口径（写死，避免以后各说各话）：
//   ① idleMs 是**静默上限**：连续这么久没有任何一条消息 ⇒ 判为卡死
//   ② hardCapMs 是**绝对上限**：即使一直在动，也不能无限跑（默认 30 分钟）
//   ③ 两者都可关闭（<= 0 ⇒ 不启用），并保留 withTimeout 的 0 = 关闭语义

export interface IdleGuardOptions {
  /** 连续无消息多久算卡死（<=0 关闭） */
  idleMs: number;
  /** 总时长硬上限（<=0 关闭） */
  hardCapMs: number;
  /** 便于把「哪个调用」写进错误信息 */
  label?: string;
  /** 记录最近一条消息的类型（超时信息要能定位到卡在哪一步） */
  describeItem?: (item: unknown) => string;
}

export class IdleTimeoutError extends Error {
  constructor(
    public readonly kind: "idle" | "hard-cap",
    public readonly limitMs: number,
    public readonly idleForMs: number,
    public readonly lastItem: string | null,
    label?: string,
  ) {
    // 错误串必须自带判别信息：`timed out after 300000ms` 这种写法
    // 让人无法区分「一直没动」与「一直在动但总量超了」。
    const fmt = (ms: number) => (ms >= 1_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`);
    super(
      kind === "idle"
        ? `no progress for ${fmt(idleForMs)}（idle limit ${fmt(limitMs)}` +
          `${lastItem ? `，最后一条消息 ${lastItem}` : "，期间没有任何消息"}${label ? `，${label}` : ""}）`
        : `hard cap ${fmt(limitMs)} exceeded（${label ?? "call"}）`,
    );
    this.name = "IdleTimeoutError";
  }
}

/**
 * 包一个 async iterable：每拿到一条就 reset 静默计时；超限时由 guard 抛错。
 *
 * 为什么不直接改 `withTimeout`：它的语义是「wall-clock 到点就 abort」，
 * 而 claude 之外还有 codex / grok 在用各自的超时口径。改它的默认行为
 * 会静默改变三条运行时的语义；加一个平行入口更安全。
 */
export async function runWithIdleGuard<T>(
  iter: AsyncIterable<T>,
  opts: IdleGuardOptions,
  onItem?: (item: T) => void | Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  let lastAt = startedAt;
  let lastItem: string | null = null;
  let failure: IdleTimeoutError | null = null;
  let finished = false;

  const describe = (item: T): string => {
    try {
      return opts.describeItem ? opts.describeItem(item) : (item as any)?.type ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  const check = () => {
    const now = Date.now();
    if (opts.hardCapMs > 0 && now - startedAt >= opts.hardCapMs) {
      failure = new IdleTimeoutError("hard-cap", opts.hardCapMs, now - lastAt, lastItem, opts.label);
    } else if (opts.idleMs > 0 && now - lastAt >= opts.idleMs) {
      failure = new IdleTimeoutError("idle", opts.idleMs, now - lastAt, lastItem, opts.label);
    }
  };

  // 抽样频率：idle 的 1/4（最小 50ms，最大 5s）。太密是浪费，太疏会让
  // 「静默 2 分钟」实际变成「静默 2 分钟 + 一个抽样周期」，而那个尾巴会被读成
  // 「超时不准」。单测里 idleMs=80ms ⇒ 抽样 50ms。
  const base = opts.idleMs > 0 ? opts.idleMs : opts.hardCapMs;
  const tickMs = Math.max(50, Math.min(5_000, Math.floor(base / 4) || 50));
  const timer = setInterval(check, tickMs);
  (timer as any)?.unref?.();

  // 🔴 关键：必须在 **`next()` 上 race**，不能只在「拿到一条之后」检查。
  // 真正的卡死形状是 `for await` 永远等不到下一条（服务端接了连接但不吐流），
  // 那时循环体一次都不会执行 —— 只在循环里检查的写法对这个形状**恒假**。
  const iterator = iter[Symbol.asyncIterator]();
  let pendingNext: Promise<IteratorResult<T>> | null = null;
  // 用容器而不是裸变量：TS 的控制流分析**不跟踪回调里的赋值**，
  // 裸变量会被窄化成 null，于是 `if (wake) wake()` 报 "not callable"。
  const wakeRef: { fn: (() => void) | null } = { fn: null };

  const idleDeadline = () =>
    new Promise<never>((_, reject) => {
      const wait = () => {
        if (failure) return; // 已由 check() 判定
        const now = Date.now();
        const idleLeft = opts.idleMs > 0 ? opts.idleMs - (now - lastAt) : Infinity;
        const capLeft = opts.hardCapMs > 0 ? opts.hardCapMs - (now - startedAt) : Infinity;
        const left = Math.min(idleLeft, capLeft);
        if (left <= 0) {
          check();
          reject(failure ?? new IdleTimeoutError("idle", opts.idleMs, now - lastAt, lastItem, opts.label));
          return;
        }
        const t = setTimeout(wait, Math.max(1, Math.min(left, 1_000)));
        wakeRef.fn = () => { clearTimeout(t); };
      };
      wait();
    });

  try {
    while (true) {
      if (!pendingNext) pendingNext = iterator.next();
      const raced = opts.idleMs > 0 || opts.hardCapMs > 0
        ? await Promise.race([pendingNext, idleDeadline()])
        : await pendingNext;
      pendingNext = null;
      if (raced.done) break;
      lastAt = Date.now();
      lastItem = describe(raced.value);
      if (onItem) await onItem(raced.value);
    }
  } finally {
    finished = true;
    clearInterval(timer);
    if (wakeRef.fn) wakeRef.fn();
    // 超时后别再让底层继续跑：显式关闭迭代器（SDK 会因此 abort 子进程）
    if (failure || !pendingNext) {
      // 🔴 不能 `await` 这个 return()：卡住的迭代器（例如正文停在 `await sleep(5000)`）
      // 会让 return() 一直挂到它自己醒来 —— 实测把「120ms 判定超时」变成「5000ms 才抛」，
      // 而那正是本次要修的形状：超时判定被底层忙碌拖住。
      // 这里只要「发出关闭请求」，不关心它何时生效。
      try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* 同上 */ }
    }
  }

  if (failure) throw failure;
}

/**
 * 轻量 watchdog：每 poke() 一次就重置静默计时；超过 idleMs 无 poke 时回调一次。
 *
 * 给「不能重构循环、但需要 idle 判定」的既有调用点用（claude-agent-sdk 那条
 * for-await 就是这种：循环体里 return/break 分支多，改写成 runWithIdleGuard
 * 收益小于风险）。它**只负责判定与通知**，abort 由调用方决定 —— 因为
 * 「超时之后做什么」在三条运行时里不一样。
 */
export function startIdleWatchdog(opts: {
  idleMs: number;
  onFire: (idleForMs: number) => void;
  tickMs?: number;
}): { poke: () => void; stop: () => void; lastPokeAt: () => number } {
  let lastAt = Date.now();
  let fired = false;
  const tick = opts.tickMs ?? Math.max(50, Math.min(1_000, Math.floor(opts.idleMs / 4) || 50));
  const timer = setInterval(() => {
    if (fired || opts.idleMs <= 0) return;
    const idleFor = Date.now() - lastAt;
    if (idleFor >= opts.idleMs) {
      fired = true;
      try { opts.onFire(idleFor); } catch { /* 回调失败不影响后续 stop */ }
    }
  }, tick);
  (timer as any)?.unref?.();
  return {
    poke: () => { lastAt = Date.now(); fired = false; },
    stop: () => clearInterval(timer),
    lastPokeAt: () => lastAt,
  };
}
