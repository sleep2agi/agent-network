// #431(app「连接较慢」)—— GET /api/status 的序列化结果记忆化 + 强 ETag。
//
// 现场(2026-10-02 生产 /api/stats/routes,15 分钟窗口):GET /api/status 2000 次 ≈ 2.2 次/秒,全部来自 UA「node」
// (旧版 agent-node 的别名解析器,.82 起给它 light+node_id 投影),线上平均 30 KB/次(已经是 gzip 后的字节:
// node 的 fetch 发 `Accept-Encoding: gzip, deflate`)。两次读之间表多半没变(report_status 约 0.75 次/秒),
// 但每次都重新 SELECT 300 行、拼对象、JSON.stringify、再 gzip 一遍。
//
// 这里只做「同一份正文不重复算」,**不改任何正文**:
//   键 = 最终 SQL + 参数(里面已经编码了调用者能看到哪些节点)+ 投影开关;
//   失效 = 任何写 sessions 表的语句(db.ts 里统一挂钩,SQLite / PG 同一处)、任何健康上报、
//          任何一份健康报告过 TTL(那一刻 degraded / health 字段会变)。
//   全量投影里 `health_observed_ms_ago` 随时间走:只要有一行带健康报告,这份正文就是时间的函数,不缓存。
// 命中时正文和当场重算逐字节相同(status-read-cache-http.test.ts 用随机写序列钉住)。
//
// ETag:正文的哈希,`If-None-Match` 命中回 304 空体。🔴 旧 agent-node 不发 If-None-Match(fetch 没有 HTTP 缓存),
// 所以 ETag 只帮得上会带它的客户端(app / dashboard 以后接上);隧道上省字节靠的是同一份 gzip 只压一次
// 且用更高的压缩级别(http-gzip.ts:可复用的正文压一次、存起来,级别 9)。

import type { DbAdapter } from "./db-adapter";
import { nodeHealthNextExpiryAt, nodeHealthVersion } from "./node-health-store.js";

let sessionsWriteGen = 0;

const WRITE_START = /^\s*(?:insert|update|delete|replace|upsert|merge|alter|drop|create|truncate|with)\b/i;
const SESSIONS_WORD = /\bsessions\b/i;

/**
 * 每条经过 db 的语句都过一遍。写语句(含带 RETURNING 的、DDL)里点名了 sessions → 代数 +1。读语句不动。
 * 不会有「没点名 sessions 却改了它」的写:两种方言的 schema 里都没有指向 sessions 的外键 / 级联删除
 * (status-read-cache.test.ts 钉住这一点)。
 */
export function noteStatement(sql: string): void {
  if (WRITE_START.test(sql) && SESSIONS_WORD.test(sql)) sessionsWriteGen++;
}

/** 原生 exec(迁移 / DDL / 多语句):不逐句判断,一律失效。 */
export function noteExec(): void { sessionsWriteGen++; }

export function statusWriteGeneration(): number { return sessionsWriteGen; }

/**
 * db.ts 用它包住唯一的那个适配器:每条语句先报给上面两个函数。挂在这一个出口上,SQLite / PG 一样,
 * 不靠每个写 sessions 的地方各自记得。直接换掉实例上的四个方法(不用 Proxy):有测试按 `db.all = …`
 * 临时打桩数查询次数,方法得是普通可写属性。
 */
export function withStatementHook(inner: DbAdapter): DbAdapter {
  const run = inner.run.bind(inner), get = inner.get.bind(inner), all = inner.all.bind(inner), exec = inner.exec.bind(inner);
  inner.run = (sql: string, params?: any[]) => { noteStatement(sql); return run(sql, params); };
  inner.get = ((sql: string, ...params: any[]) => { noteStatement(sql); return get(sql, ...params); }) as DbAdapter["get"];
  inner.all = ((sql: string, ...params: any[]) => { noteStatement(sql); return all(sql, ...params); }) as DbAdapter["all"];
  inner.exec = (sql: string) => { noteExec(); return exec(sql); };
  return inner;
}

type Entry = { gen: number; healthVer: number; validUntil: number; body: string; etag: string };
const MAX_ENTRIES = 64;
const memo = new Map<string, Entry>();
export const statusCacheStats = { hits: 0, misses: 0, uncacheable: 0 };

function etagOf(body: string): string {
  return `"s-${Bun.hash(body).toString(36)}-${body.length.toString(36)}"`;
}

/**
 * 取或算。compute 返回正文和它能不能缓存(全量投影里有健康报告 = 正文随时间变 = 不能)。
 * 返回的 etag 总是这份正文的哈希(不缓存的也给,便于 304)。
 */
let bypass = false;
/** 测试用:临时绕过缓存(既不读也不写),拿「当场重算」的那一份来对比,而不清掉缓存里已有的条目。 */
export function __setStatusCacheBypassForTest(on: boolean): void { bypass = on; }

export function memoStatusBody(key: string, compute: () => { body: string; cacheable: boolean }, now = Date.now()): { body: string; etag: string; hit: boolean } {
  if (bypass) { const { body } = compute(); return { body, etag: etagOf(body), hit: false }; }
  const gen = sessionsWriteGen;
  const healthVer = nodeHealthVersion();
  const hit = memo.get(key);
  if (hit && hit.gen === gen && hit.healthVer === healthVer && now < hit.validUntil) {
    statusCacheStats.hits++;
    memo.delete(key);
    memo.set(key, hit); // LRU
    return { body: hit.body, etag: hit.etag, hit: true };
  }
  const { body, cacheable } = compute();
  const etag = etagOf(body);
  // 以算之前的代数入账:算的过程中若有写(改名清理之类),下一次比较就对不上、重算 —— 宁可多算一次也不发旧正文。
  if (!cacheable) {
    statusCacheStats.uncacheable++;
    memo.delete(key);
    return { body, etag, hit: false };
  }
  statusCacheStats.misses++;
  memo.set(key, { gen, healthVer, validUntil: nodeHealthNextExpiryAt(now), body, etag });
  while (memo.size > MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  return { body, etag, hit: false };
}

/** If-None-Match 里有这个 ETag(或 `*`)。弱比较:去掉 W/ 前缀。 */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/** 测试用。 */
export function __resetStatusCacheForTest(): void {
  memo.clear();
  statusCacheStats.hits = statusCacheStats.misses = statusCacheStats.uncacheable = 0;
}
