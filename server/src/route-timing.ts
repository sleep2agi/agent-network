// 每个路由的耗时统计(2026-09-30):生产 hub 平均 ~24% CPU,但没有任何按路由的计时,也没有访问日志,
// 说不清是谁在吃 CPU。这里在 fetch 入口按路由形状累计次数、耗时、状态、字节,
// GET /api/stats/routes(管理员 / master)按时间窗汇总。只在内存里,重启清空;不记 query 值、不记请求体;调用者只记粗粒度类别(见下文 callerClass)。
//
// 2026-10-01 —— 原来是 4096 条样本的环:生产上 212 s 就写满,?minutes=10 实际只覆盖三分半钟。
// 改成按分钟分桶的累计器:每个桶里每个路由一行(次数 / 总耗时 / 最大值 / 字节 / 5xx / 耗时直方图),
// 保留 ROUTE_BUCKET_RETENTION 个桶(24 小时),窗口多长就真覆盖多长。p95 从直方图取(桶上沿,不超过 max)。
export const ROUTE_BUCKET_MS = 60_000;
export const ROUTE_BUCKET_RETENTION = 1440;
/** 每个分钟桶里最多这么多个不同的路由;再多的记到 ROUTE_OVERFLOW_KEY,防止怪路径 / 怪工具名把内存撑大。 */
export const ROUTE_MAX_KEYS_PER_BUCKET = 256;
export const ROUTE_OVERFLOW_KEY = "(other)";

// 耗时直方图:第 i 格的上沿 = HIST_BASE_MS · 2^(i/2),0.05 ms … ~52 s;最后一格收下更慢的。
const HIST_BASE_MS = 0.05;
const HIST_BINS = 41;
function histBin(ms: number): number {
  if (!(ms > HIST_BASE_MS)) return 0;
  return Math.min(HIST_BINS - 1, Math.ceil(2 * Math.log2(ms / HIST_BASE_MS)));
}
const histUpper = (bin: number) => HIST_BASE_MS * 2 ** (bin / 2);

type Agg = { count: number; totalMs: number; maxMs: number; bytes: number; errors: number; hist: Uint32Array; callers?: Map<string, CallerAgg> };
type CallerAgg = { count: number; bytes: number };
type Bucket = { minute: number; routes: Map<string, Agg> };
// 按 minute 升序;新的一分钟追加在尾部,超出保留期从头部丢。
const buckets: Bucket[] = [];

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

// 处理器给某个请求补一段标签(比如 POST /mcp 的 JSON-RPC 方法名),recordRouteTiming 拼到路由形状后面。
const labels = new WeakMap<Request, string>();
export function labelRoute(req: Request, label: string): void {
  labels.set(req, label);
}

const MCP_METHOD_RE = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;
const MCP_TOOL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * POST /mcp 的标签:JSON-RPC 方法名,tools/call 再带工具名,如 "tools/call report_status"。
 * 只读 method 和 params.name 两个字段,别的(尤其 arguments)一概不碰;形状不对的一律折成 "?",
 * 批量请求记 "batch"。名字只放行短的 ASCII 标识符,防止拿请求体造出任意多、任意长的路由键。
 */
export function mcpRouteLabel(body: unknown): string {
  if (Array.isArray(body)) return "batch";
  if (!body || typeof body !== "object") return "?";
  const method = (body as { method?: unknown }).method;
  if (typeof method !== "string" || !MCP_METHOD_RE.test(method)) return "?";
  if (method !== "tools/call") return method;
  const params = (body as { params?: unknown }).params;
  const name = params && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
  return `tools/call ${typeof name === "string" && MCP_TOOL_RE.test(name) ? name : "?"}`;
}

// ── 调用方分类(2026-10-01)────────────────────────────────────────────────────────────
// 生产上全量 GET /api/status 每秒 ~2.8 次,但大多数连接经 frp 隧道进来,来源全是 127.0.0.1,也没有访问日志,
// 看不出是谁在拉。每个请求再记一个粗粒度的「调用方类别」= 令牌种类 + User-Agent 家族,
// GET /api/stats/routes?by=caller 按路由给出各类别的次数 / 字节。
// 🔴 只记类别:不记令牌、用户 / 节点 id、IP、完整 UA。UA 只认白名单里的产品名(其余一律 "other"),
//    版本号只放行数字 + 一段预发布标记,浏览器一律折成 "browser"。
/** 每个分钟桶里每个路由最多这么多个调用方类别;再多的记到 ROUTE_OVERFLOW_KEY。汇总输出也只给前这么多个。 */
export const ROUTE_MAX_CALLERS_PER_ROUTE = 20;

let masterToken = "";
/** 启动时把 COMMHUB_AUTH_TOKEN 交进来,用于把它认成 "master";只做相等比较,不输出。 */
export function setRouteCallerMasterToken(token: string | undefined): void {
  masterToken = token || "";
}

/** 令牌种类:ntok_ → node,utok_ → user,等于 master 令牌 → master,别的非空令牌 → token,没有 → anon。 */
export function callerTokenKind(req: Request, url: URL): string {
  const header = req.headers.get("authorization");
  const token = (header ? header.replace(/^Bearer\s+/i, "").trim() : "") || url.searchParams.get("token") || "";
  if (!token) return "anon";
  if (token.startsWith("ntok_")) return "node";
  if (token.startsWith("utok_")) return "user";
  if (masterToken && token === masterToken) return "master";
  return "token";
}

// UA 的第一个产品名(小写)→ 输出用的名字。只有这里列出的名字会原样出现在统计里。
const UA_PRODUCTS = new Map([
  "agent-node", "agent-network", "anet", "agent-network-desktop", "agent-network-dashboard", "commhub-server", "tauri-plugin-http",
  "claude-code", "node", "undici", "node-fetch", "axios", "got", "bun", "deno", "okhttp", "cfnetwork", "dalvik",
  "curl", "wget", "python-requests", "python-httpx", "python-urllib", "aiohttp", "go-http-client", "reqwest",
  "postmanruntime", "httpie", "powershell",
].map(n => [n, n]));
const UA_HEAD_RE = /^([A-Za-z][A-Za-z0-9._-]{0,40})(?:\/(\S{1,64}))?/;
const UA_VERSION_RE = /^\d{1,6}(?:\.\d{1,6}){0,2}(?:-[A-Za-z]{1,16}(?:\.\d{1,6})?)?/;

/**
 * User-Agent 家族:"agent-node/2.5.0-preview.88"、"node"、"Bun/1.2.3" → "bun/1.2.3"、"okhttp/4.12.0"、
 * "curl/8.5.0";Mozilla/… → "browser";没有 UA → "none";不在白名单 → "other"。
 * iOS 的 RN fetch 形如 "<App>/<build> CFNetwork/… Darwin/…",第一个产品名是 app 自己的,认 CFNetwork 记成 "cfnetwork"。
 */
export function userAgentFamily(ua: string | null): string {
  const s = (ua || "").trim();
  if (!s) return "none";
  if (s.startsWith("Mozilla/")) return "browser";
  const head = UA_HEAD_RE.exec(s);
  let name = head ? UA_PRODUCTS.get(head[1].toLowerCase()) : undefined;
  let rawVersion = head?.[2];
  if (!name) {
    if (!/\sCFNetwork\//.test(s)) return "other";
    name = "cfnetwork";
    rawVersion = /\sCFNetwork\/(\S{1,64})/.exec(s)?.[1];
  }
  const version = rawVersion ? UA_VERSION_RE.exec(rawVersion)?.[0] : undefined;
  return version ? `${name}/${version}` : name;
}

/** 一个请求的调用方类别,如 "node agent-node/2.5.0-preview.88"、"user browser"、"anon none"。 */
export function callerClass(req: Request, url: URL): string {
  return `${callerTokenKind(req, url)} ${userAgentFamily(req.headers.get("user-agent"))}`;
}

/** 记一次请求;原样返回 res,方便套在 fetch 处理器的 return 上。WebSocket 升级(res 为空)不记。 */
export function recordRouteTiming<T extends Response | undefined>(req: Request, started: number, res: T, now: number = Date.now()): T {
  if (!res) return res;
  let url: URL;
  try { url = new URL(req.url); } catch { return res; }
  const label = labels.get(req);
  const route = label ? `${routeKey(req.method, url)} ${label}` : routeKey(req.method, url);
  const length = Number(res.headers.get("content-length"));
  const bytes = Number.isFinite(length) && res.headers.has("content-length") ? length : 0;
  addSample(route, performance.now() - started, res.status, bytes, now, callerClass(req, url));
  return res;
}

function addSample(route: string, ms: number, status: number, bytes: number, now: number, caller: string): void {
  const minute = Math.floor(now / ROUTE_BUCKET_MS);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || minute > bucket.minute) {
    buckets.push(bucket = { minute, routes: new Map() });
    const oldest = minute - ROUTE_BUCKET_RETENTION + 1;
    let drop = 0;
    while (drop < buckets.length && buckets[drop].minute < oldest) drop++;
    if (drop) buckets.splice(0, drop);
  } else if (minute < bucket.minute) {
    // 时间戳比最新的桶早(时钟回拨,或测试里乱序记):放回它自己的那一分钟;比保留期还早的丢掉。
    if (minute < bucket.minute - ROUTE_BUCKET_RETENTION + 1) return;
    let i = buckets.length - 1;
    while (i > 0 && buckets[i - 1].minute >= minute) i--;
    if (buckets[i].minute !== minute) buckets.splice(i, 0, { minute, routes: new Map() });
    bucket = buckets[i];
  }
  let agg = bucket.routes.get(route);
  if (!agg) {
    if (bucket.routes.size >= ROUTE_MAX_KEYS_PER_BUCKET) route = ROUTE_OVERFLOW_KEY;
    agg = bucket.routes.get(route);
    if (!agg) bucket.routes.set(route, agg = { count: 0, totalMs: 0, maxMs: 0, bytes: 0, errors: 0, hist: new Uint32Array(HIST_BINS) });
  }
  agg.count++;
  agg.totalMs += ms;
  if (ms > agg.maxMs) agg.maxMs = ms;
  agg.bytes += bytes;
  if (status >= 500) agg.errors++;
  agg.hist[histBin(ms)]++;
  const callers = agg.callers ??= new Map();
  let c = callers.get(caller);
  if (!c) {
    if (callers.size >= ROUTE_MAX_CALLERS_PER_ROUTE) caller = ROUTE_OVERFLOW_KEY;
    c = callers.get(caller);
    if (!c) callers.set(caller, c = { count: 0, bytes: 0 });
  }
  c.count++;
  c.bytes += bytes;
}

export type RouteStat = { route: string; count: number; total_ms: number; avg_ms: number; p95_ms: number; max_ms: number; bytes: number; errors: number; callers?: CallerStat[] };
export type CallerStat = { class: string; count: number; bytes: number };

/**
 * 最近 windowMs 内的请求按路由汇总,按总耗时降序。粒度是分钟桶:窗口起点落在哪个桶,就从那个桶算起。
 * oldest_at 是窗口里最早一个有数据的桶的起点 —— 它比 now - window_ms 晚很多,说明 hub 是那之后才起来的。
 */
export function routeStats(windowMs: number, now: number = Date.now(), opts: { byCaller?: boolean } = {}): { window_ms: number; samples: number; oldest_at: string | null; routes: RouteStat[] } {
  const fromMinute = Math.floor((now - windowMs) / ROUTE_BUCKET_MS);
  const merged = new Map<string, Agg>();
  let oldest: number | null = null;
  for (const bucket of buckets) {
    if (bucket.minute < fromMinute) continue;
    if (oldest === null) oldest = bucket.minute * ROUTE_BUCKET_MS;
    for (const [route, a] of bucket.routes) {
      let m = merged.get(route);
      if (!m) merged.set(route, m = { count: 0, totalMs: 0, maxMs: 0, bytes: 0, errors: 0, hist: new Uint32Array(HIST_BINS) });
      m.count += a.count;
      m.totalMs += a.totalMs;
      if (a.maxMs > m.maxMs) m.maxMs = a.maxMs;
      m.bytes += a.bytes;
      m.errors += a.errors;
      for (let i = 0; i < HIST_BINS; i++) m.hist[i] += a.hist[i];
      if (opts.byCaller && a.callers) {
        const mc = m.callers ??= new Map();
        for (const [cls, c] of a.callers) {
          const t = mc.get(cls);
          if (t) { t.count += c.count; t.bytes += c.bytes; } else mc.set(cls, { count: c.count, bytes: c.bytes });
        }
      }
    }
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const routes = [...merged].map(([route, a]): RouteStat => {
    const rank = Math.min(a.count, Math.floor(a.count * 0.95) + 1);
    let seen = 0, bin = 0;
    for (; bin < HIST_BINS - 1; bin++) { seen += a.hist[bin]; if (seen >= rank) break; }
    return {
      route,
      count: a.count,
      total_ms: round(a.totalMs),
      avg_ms: round(a.totalMs / a.count),
      p95_ms: round(Math.min(histUpper(bin), a.maxMs)),
      max_ms: round(a.maxMs),
      bytes: a.bytes,
      errors: a.errors,
      ...(opts.byCaller ? { callers: callerStats(a.callers) } : {}),
    };
  }).sort((a, b) => b.total_ms - a.total_ms);
  return { window_ms: windowMs, samples: routes.reduce((n, r) => n + r.count, 0), oldest_at: oldest === null ? null : new Date(oldest).toISOString(), routes };
}

/** 按次数降序;各分钟桶的类别合起来可能超过上限,超出的并进 ROUTE_OVERFLOW_KEY。 */
function callerStats(callers: Map<string, CallerAgg> | undefined): CallerStat[] {
  let other: CallerStat | undefined;
  const named: CallerStat[] = [];
  for (const [cls, c] of callers ?? []) {
    if (cls === ROUTE_OVERFLOW_KEY) other = { class: cls, count: c.count, bytes: c.bytes };
    else named.push({ class: cls, count: c.count, bytes: c.bytes });
  }
  named.sort((a, b) => b.count - a.count || b.bytes - a.bytes || (a.class < b.class ? -1 : 1));
  if (!other && named.length <= ROUTE_MAX_CALLERS_PER_ROUTE) return named;
  other ??= { class: ROUTE_OVERFLOW_KEY, count: 0, bytes: 0 };
  for (const r of named.splice(ROUTE_MAX_CALLERS_PER_ROUTE - 1)) { other.count += r.count; other.bytes += r.bytes; }
  return [...named, other];
}

/** Test-only. */
export function __resetRouteTimingForTest(): void {
  buckets.length = 0;
}
