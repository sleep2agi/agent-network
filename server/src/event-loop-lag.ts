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

/**
 * 一个 tick 窗口里某个路由（或 MCP 工具）的耗时累计。
 * 只记「次数 / 总耗时 / 单次最大」，不记 query、不记请求体、不记别名。
 */
export type TickRouteCost = {
  /** 路由形状，MCP 会带工具名，如 "POST /mcp tools/call report_status"。 */
  route: string;
  count: number;
  total_ms: number;
  max_ms: number;
};

export type EventLoopStall = {
  /** 这个间隔里处理完的请求数：0 = 真的没推进；>0 = 循环在干活，只是 timer 被饿住。 */
  /** ISO 时间（停顿**结束**的时刻，即这次 tick 的时间）。 */
  at: string;
  /** 距上次 tick 的实际间隔（毫秒）。等于 interval + 停顿。 */
  gap_ms: number;
  /** 停顿量 = gap - interval。 */
  stall_ms: number;
  /** 停顿结束时的进程 RSS（MB），用于和内存尖峰对齐。 */
  rss_mb: number;
  requests_since_last_tick?: number;
  /**
   * 这个停顿窗口里总耗时最高的前几条路由（最多 5 条，按 total_ms 降序）。
   * 归因用：requests_since_last_tick 说明循环在干活，这里说明**活是谁干的**。
   * 未接计时源（测试 / 早期调用）时缺省。
   */
  top_routes?: TickRouteCost[];
};

/** 一次停顿里最多留几条路由归因。 */
export const STALL_TOP_ROUTES = 5;
/** 日志里每个路由名的最大长度（MCP 标签已经限长，这里再兜一层，避免一行被撑爆）。 */
const STALL_ROUTE_CLIP = 48;

const KEEP_STALLS = 20;

/**
 * #2614（第二轮）—— 2026-10-27 00:39 线上出现 gap 84887ms，但**同一时段日志在正常写**
 * （00:38:52 / 00:38:58 / 00:39:08 …），而且 `/api/stats/routes` 里最慢的请求只有 2.4s。
 * 也就是说：事件循环**没有被阻塞 84 秒**，是 **timer 回调被 I/O 队列饿住**了。
 * 只看 tick 间隔会把这两种情况混成一条“卡了 84 秒”的假结论。
 *
 * 区分办法：数一下这个间隔里**服务了多少请求**。
 *   requests_since_last_tick > 0 ⇒ 循环在干活 ⇒ 这是 timer 饥饿（高负载/大批回调）
 *   requests_since_last_tick = 0 ⇒ 真的没有推进任何请求 ⇒ 才可能是同步阻塞
 */
let servedSinceTick = 0;

/** 请求处理完成时调用（route-timing 里）。只计数，不参与任何决策。 */
export function noteRequestServed(): void {
  servedSinceTick++;
}

let maxGapMs = 0;
let lastGapMs = 0;
let stallCount = 0;
let lastStallAt: string | null = null;
let lastStallMs = 0;
const stalls: EventLoopStall[] = [];

/** 记录一次 tick 间隔。返回这次 tick 的停顿量（毫秒，可为负→归零）。 */
export function recordGap(
  gapMs: number,
  opts: { intervalMs?: number; thresholdMs?: number; rssMb?: number; now?: number; served?: number; topRoutes?: readonly TickRouteCost[] } = {},
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
  const top = opts.topRoutes && opts.topRoutes.length ? rankTopRoutes(opts.topRoutes) : undefined;
  stalls.push({
    at,
    gap_ms: Math.round(gapMs),
    stall_ms: Math.round(stallMs),
    rss_mb: opts.rssMb ?? 0,
    requests_since_last_tick: opts.served ?? 0,
    ...(top ? { top_routes: top } : {}),
  });
  while (stalls.length > KEEP_STALLS) stalls.shift();
  return stallMs;
}

/** 取总耗时最高的前 N 条（只在 stall 时调用，不是每 tick）。 */
export function rankTopRoutes(routes: readonly TickRouteCost[], limit = STALL_TOP_ROUTES): TickRouteCost[] {
  const out = routes
    .filter(r => r && r.count > 0)
    .map(r => ({ route: r.route, count: r.count, total_ms: Math.round(r.total_ms * 10) / 10, max_ms: Math.round(r.max_ms * 10) / 10 }))
    .sort((a, b) => b.total_ms - a.total_ms || b.max_ms - a.max_ms)
    .slice(0, limit);
  return out;
}

/** 把 top_routes 拼成日志后缀；空数组/未接计时源时返回空串。 */
export function formatTopRoutes(routes: readonly TickRouteCost[] | undefined): string {
  if (!routes || !routes.length) return "";
  const parts = routes.map(r => {
    const route = r.route.length > STALL_ROUTE_CLIP ? `${r.route.slice(0, STALL_ROUTE_CLIP - 1)}…` : r.route;
    return `${route} ×${r.count} ${Math.round(r.total_ms)}ms max ${Math.round(r.max_ms)}ms`;
  });
  return ` | top: ${parts.join("; ")}`;
}

/**
 * 2026-10-31 —— 窗口两端必须跟着读数一起走（#3174）。
 *
 * 原来 event_loop 给了 stall_count / last_stall_at，却没有窗口起点：
 * 计数器随进程重启归零，而「归零」与「从未发生」在读数上同值 ⇒
 * 单独引用 stall_count 的读者会把它读成「从上线以来没卡过」。
 *
 * ⇒ 现在两个时刻戳都在这对象里：`since`（起点，模块初始化时冻结）与 `observed_at`（读的时刻）。
 *    引用者不必再去 /health 顶层猜窗口，窗口与读数同域。
 *    判据：分子分母各要自己的时刻戳；**被声明的那个永远不算**。
 */
let sinceIso = new Date().toISOString();

export function eventLoopStats(): {
  max_gap_ms: number;
  last_gap_ms: number;
  stall_count: number;
  last_stall_ms: number;
  last_stall_at: string | null;
  recent_stalls: EventLoopStall[];
  /** 窗口起点（本进程 event-loop 观察开始时刻）。 */
  since: string;
  /** 这次读的时刻。与 `since` 一起才构成窗口；单独任一个都不构成。 */
  observed_at: string;
} {
  return {
    max_gap_ms: Math.round(maxGapMs),
    last_gap_ms: Math.round(lastGapMs),
    stall_count: stallCount,
    last_stall_ms: Math.round(lastStallMs),
    last_stall_at: lastStallAt,
    recent_stalls: [...stalls].reverse(),
    since: sinceIso,
    observed_at: new Date().toISOString(),
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
  sinceIso = new Date().toISOString(); // 重置窗口起点 —— 否则测试里「归零」与「没归零」同形
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
  /**
   * #2721 —— 启动期的 tick gap 不算停顿。判据是**进程启动多久了**，不是第几个 tick。
   *
   * 事故形状：进程 22:21:06 启动，14:21:09.835Z 记到 gap 2972ms —— 启动后 3 秒。
   * 那段 gap 度量的是「监控开始 → 第一次 tick」被模块加载/开库/迁移占满的时间。
   *
   * 两版错误实现（都试过，都被既有测试抓住）：
   *   ① 10 秒**时间窗** → 监控在前 10 秒什么都不记，「阈值 40ms + spin 120ms 应打日志」直接吞掉
   *   ② 只跳**第一个 tick** → 测试里的 spin 恰好落在第一个 tick，同样吞掉
   *
   * 真正的区别不是「第几个 tick」，而是**这段时间里进程有没有可能还在启动**。
   * 所以：只有当 tick 到来时进程 uptime 仍小于 bootGraceMs，才把 gap 当作启动尖峰。
   * 启动 20 秒之后的第一条 gap 依旧照常记录 —— 那时候它不可能是启动耗时。
   */
  bootGraceMs?: number;
  /** 测试注入：返回进程已运行的毫秒数（默认 process.uptime()）。 */
  uptimeMs?: () => number;
  /**
   * 归因来源：取走**本 tick 窗口**内按路由累计的耗时（route-timing.ts 的 takeTickRouteCosts），
   * 每个 tick 都会被调用一次且会清空窗口。不接就没有 top_routes（行为与旧版一致）。
   */
  tickRoutes?: () => TickRouteCost[];
} = {}): ReturnType<typeof setInterval> {
  const intervalMs = opts.intervalMs ?? Math.max(50, envMs("COMMHUB_STALL_TICK_MS", 250));
  const thresholdMs = opts.thresholdMs ?? envMs("COMMHUB_STALL_LOG_MS", 2000);
  const log = opts.log ?? ((m: string) => console.log(m));
  const rssMb = opts.rssMb ?? (() => Math.round(process.memoryUsage().rss / 1048576));
  let last = performance.now();
  const startedAt = last;
  // #2721 —— 启动预热不算停顿。
  // 实测：2026-10-29 这次进程 22:21:06 起来，14:21:09.835Z 记到一次 gap 2972ms，
  // 也就是**启动后 3 秒**。那段时间在做模块加载 / 打开 DB / 迁移，第一个 tick 必然偏大。
  // 不排除它的后果是：每次部署都会在 `/health` 里留一条「停顿」，而它和线上真实卡顿长得一模一样。
  const bootGraceMs = opts.bootGraceMs ?? envMs("COMMHUB_STALL_BOOT_GRACE_MS", 15_000);
  const uptimeMs = opts.uptimeMs ?? (() => process.uptime() * 1000);
  let firstTick = true;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    const rss = rssMb();
    const served = servedSinceTick;
    servedSinceTick = 0;
    // 归因窗口必须每个 tick 都抽干：否则非停顿的 tick 会一直往同一次累计里堆，
    // 停顿时看到的就成了「过去好几个 tick 的总和」。抽干是清空，不排序。
    let tickRoutes: TickRouteCost[] = [];
    if (opts.tickRoutes) {
      try { tickRoutes = opts.tickRoutes() ?? []; } catch { tickRoutes = []; }
    }
    // 启动尖峰：只可能是**第一个** tick，且到来时进程才刚起来。
    // 两个条件缺一不可 —— 只看「第一个 tick」会吞掉运行中立刻发生的真实停顿。
    if (firstTick) {
      firstTick = false;
      if (uptimeMs() < bootGraceMs) return;
    }
    // 排序/取前 N 只在真停顿的时候做。
    const top = tickRoutes.length ? rankTopRoutes(tickRoutes) : undefined;
    const stall = recordGap(gap, { intervalMs, thresholdMs, rssMb: rss, served, ...(top ? { topRoutes: top } : {}) });
    if (thresholdMs > 0 && stall >= thresholdMs) {
      // 和 retention/slow-sql 的日志同一前缀，方便 grep。
      // `served` 是判据的关键：它非零就说明循环在干活，这段“gap”是 timer 被饿住，不是阻塞。
      // `top` 是归因：这个窗口里总耗时最高的几条路由（见 route-timing.ts 的 tick 归因）。
      log(`[commhub stall] loop idle ~${Math.round(stall)}ms (tick gap ${Math.round(gap)}ms, rss ${rss} MB, served ${served} req)${formatTopRoutes(top)}`);
    }
  }, intervalMs);
  // 监测不该拖住进程退出。
  (timer as unknown as { unref?: () => void }).unref?.();
  last = performance.now();
  return timer;
}
