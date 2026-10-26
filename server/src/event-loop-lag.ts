// #2614 —— 事件循环停顿监测（只观测，不改任何行为）。
//
// 背景：2026-10-26 21:55–22:12 生产 Hub 出现两次内存尖峰（RSS 3.6 → 4.5 GB），
// 伴随机 `mcp_inflight` 387 → 807。事后看日志才发现**同一时刻日志静默 14–47 秒**
// ——Hub 是单线程（Bun + 同步 SQLite），日志静默就等于事件循环被阻塞。
//
// 现有 `/api/stats/routes` 只能告诉我们“哪个请求**受害**了”（它的耗时包含了排队时间），
// 不能告诉我们“当时**谁**在阻塞”。缺的就是停顿本身的时间序列。
//
// 这个模块补上这一格：每 `intervalMs` 醒一次，量 `now - lastTick`；
// 正常情况 ≈ interval，超出 `thresholdMs` 的部分就是一次真实停顿。
// 停顿会：① 计数/留档（`/health` 的 `event_loop` 字段可读）；
// ② 打一行日志（带当时的 RSS，方便和内存曲线对齐）。
//
// 注意：`setInterval` 自己也会被阻塞 —— 这正是我们要测量的东西。
// 停顿结束后第一次 tick 的 gap 就是停顿长度，不需要外部进程配合。

export type EventLoopStall = {
  /** ISO 时间（停顿**结束**的时刻，即这次 tick 的时间）。 */
  at: string;
  /** 距上次 tick 的实际间隔（毫秒）。等于 interval + 停顿。 */
  gap_ms: number;
  /** 停顿量 = gap - interval。 */
  stall_ms: number;
  /** 停顿结束时的进程 RSS（MB），用于和内存尖峰对齐。 */
  rss_mb: number;
};

const KEEP_STALLS = 20;

let maxGapMs = 0;
let lastGapMs = 0;
let stallCount = 0;
let lastStallAt: string | null = null;
let lastStallMs = 0;
const stalls: EventLoopStall[] = [];

/** 记录一次 tick 间隔。返回这次 tick 的停顿量（毫秒，可为负→归零）。 */
export function recordGap(
  gapMs: number,
  opts: { intervalMs?: number; thresholdMs?: number; rssMb?: number; now?: number } = {},
): number {
  const interval = opts.intervalMs ?? 250;
  const threshold = opts.thresholdMs ?? 2000;
  lastGapMs = gapMs;
  if (gapMs > maxGapMs) maxGapMs = gapMs;
  const stallMs = Math.max(0, gapMs - interval);
  if (stallMs < threshold) return stallMs;
  const at = new Date(opts.now ?? Date.now()).toISOString();
  stallCount++;
  lastStallAt = at;
  lastStallMs = stallMs;
  stalls.push({ at, gap_ms: Math.round(gapMs), stall_ms: Math.round(stallMs), rss_mb: opts.rssMb ?? 0 });
  while (stalls.length > KEEP_STALLS) stalls.shift();
  return stallMs;
}

export function eventLoopStats(): {
  max_gap_ms: number;
  last_gap_ms: number;
  stall_count: number;
  last_stall_ms: number;
  last_stall_at: string | null;
  recent_stalls: EventLoopStall[];
} {
  return {
    max_gap_ms: Math.round(maxGapMs),
    last_gap_ms: Math.round(lastGapMs),
    stall_count: stallCount,
    last_stall_ms: Math.round(lastStallMs),
    last_stall_at: lastStallAt,
    recent_stalls: [...stalls].reverse(),
  };
}

/** 只给测试用：清空累计状态。 */
export function resetEventLoopLagForTests(): void {
  maxGapMs = 0;
  lastGapMs = 0;
  stallCount = 0;
  lastStallAt = null;
  lastStallMs = 0;
  stalls.length = 0;
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * 启动监测。返回 timer（调用方负责 clearInterval）。
 * - `COMMHUB_STALL_LOG_MS`：停顿日志阈值，默认 2000 ms，设 0 关闭日志（仍计数）；
 * - `COMMHUB_STALL_TICK_MS`：采样间隔，默认 250 ms。
 */
export function startEventLoopLagMonitor(opts: {
  intervalMs?: number;
  thresholdMs?: number;
  log?: (msg: string) => void;
  rssMb?: () => number;
} = {}): ReturnType<typeof setInterval> {
  const intervalMs = opts.intervalMs ?? Math.max(50, envMs("COMMHUB_STALL_TICK_MS", 250));
  const thresholdMs = opts.thresholdMs ?? envMs("COMMHUB_STALL_LOG_MS", 2000);
  const log = opts.log ?? ((m: string) => console.log(m));
  const rssMb = opts.rssMb ?? (() => Math.round(process.memoryUsage().rss / 1048576));
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    const rss = rssMb();
    const stall = recordGap(gap, { intervalMs, thresholdMs, rssMb: rss });
    if (thresholdMs > 0 && stall >= thresholdMs) {
      // 和 retention/slow-sql 的日志同一前缀，方便 grep。
      log(`[commhub stall] loop blocked ~${Math.round(stall)}ms (tick gap ${Math.round(gap)}ms, rss ${rss} MB)`);
    }
  }, intervalMs);
  // 监测不该拖住进程退出。
  (timer as unknown as { unref?: () => void }).unref?.();
  last = performance.now();
  return timer;
}
