// 每个路由的耗时环(2026-09-30):生产 hub 平均 ~24% CPU,但没有任何按路由的计时,也没有访问日志,
// 说不清是谁在吃 CPU。这里在 fetch 入口记最近 ROUTE_RING_SIZE 个请求(路由形状、耗时、状态、字节),
// GET /api/stats/routes(管理员 / master)按时间窗汇总。只在内存里,重启清空;不记 query 值、不记调用者。
export const ROUTE_RING_SIZE = 4096;

type Sample = { at: number; route: string; ms: number; status: number; bytes: number | null };
const ring: Sample[] = [];
let next = 0;

/** 路由的形状:id / 别名 / 文件名这类段换成 :id,几个会改变载荷形状的参数保留(light / view / scope / changes)。 */
const SHAPE_PARAMS = ["changes", "light", "scope", "view"];
export function routeKey(method: string, url: URL): string {
  const segments = url.pathname.split("/").map((seg, i) => {
    if (i < 2 || !seg) return seg;
    return /[0-9%]/.test(seg) || /[^\x20-\x7e]/.test(seg) || seg.length > 24 ? ":id" : seg;
  });
  const shape = SHAPE_PARAMS.filter(k => url.searchParams.has(k)).map(k => `${k}=${url.searchParams.get(k)}`).join("&");
  return `${method} ${segments.join("/")}${shape ? `?${shape}` : ""}`;
}

/** 记一次请求;原样返回 res,方便套在 fetch 处理器的 return 上。WebSocket 升级(res 为空)不记。 */
export function recordRouteTiming<T extends Response | undefined>(req: Request, started: number, res: T, now: number = Date.now()): T {
  if (!res) return res;
  let url: URL;
  try { url = new URL(req.url); } catch { return res; }
  const length = Number(res.headers.get("content-length"));
  const sample: Sample = { at: now, route: routeKey(req.method, url), ms: performance.now() - started, status: res.status, bytes: Number.isFinite(length) && res.headers.has("content-length") ? length : null };
  if (ring.length < ROUTE_RING_SIZE) ring.push(sample);
  else ring[next] = sample;
  next = (next + 1) % ROUTE_RING_SIZE;
  return res;
}

export type RouteStat = { route: string; count: number; total_ms: number; avg_ms: number; p95_ms: number; max_ms: number; bytes: number; errors: number };

/** 最近 windowMs 内的样本按路由汇总,按总耗时降序。 */
export function routeStats(windowMs: number, now: number = Date.now()): { window_ms: number; samples: number; oldest_at: string | null; routes: RouteStat[] } {
  const since = now - windowMs;
  const groups = new Map<string, Sample[]>();
  let oldest: number | null = null;
  for (const s of ring) {
    if (s.at < since) continue;
    if (oldest === null || s.at < oldest) oldest = s.at;
    let g = groups.get(s.route);
    if (!g) groups.set(s.route, g = []);
    g.push(s);
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const routes = [...groups].map(([route, samples]): RouteStat => {
    const ms = samples.map(s => s.ms).sort((a, b) => a - b);
    const total = ms.reduce((a, b) => a + b, 0);
    return {
      route,
      count: samples.length,
      total_ms: round(total),
      avg_ms: round(total / samples.length),
      p95_ms: round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]),
      max_ms: round(ms[ms.length - 1]),
      bytes: samples.reduce((n, s) => n + (s.bytes ?? 0), 0),
      errors: samples.filter(s => s.status >= 500).length,
    };
  }).sort((a, b) => b.total_ms - a.total_ms);
  return { window_ms: windowMs, samples: routes.reduce((n, r) => n + r.count, 0), oldest_at: oldest === null ? null : new Date(oldest).toISOString(), routes };
}

/** Test-only. */
export function __resetRouteTimingForTest(): void {
  ring.length = 0;
  next = 0;
}
