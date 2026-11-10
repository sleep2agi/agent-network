// #3952（admin 2026-11-05「要对节点进行 Token 审计，能看到节点消耗了多少 Token」）
//
// 现状：Hub 里**没有任何** token 用量记账 —— 只有 api_tokens（那是鉴权用的令牌 id，
// 和"消耗了多少 token"是两回事）。节点侧其实**看得到**用量（claude/codex 的每轮结果里
// 都有 input_tokens / output_tokens，只是打进了日志），但从来没有上报。
//
// 本模块只做「记账 + 读账」，不做采集：
//   写  reportTokenUsage()  节点令牌专用，按 (network, node, hour, model) 累加
//   读  readTokenUsage()    人（成员/owner/admin）按节点聚合
//
// 已知边界：turns / cost_usd 列 NOT NULL DEFAULT 0 ⇒ 「没报」与「报了 0」在存储上同形。
//   要区分得再加一列 has_turns；当前不值这个复杂度（谁要区分，读 normalizeUsage 的返回值）。
//
// 三条口径（写死，避免以后各说各话）：
//   ① hour 是 **UTC 小时桶**（'YYYY-MM-DDTHH'），与 node_tool_calls 同口径。
//   ② 累加而不是覆盖：同一小时同一 model 多次上报要相加 —— 一轮一报是常态。
//   ③ **只收计数，不收内容**：没有 prompt、没有消息 id、没有凭据。
//      这一点由 schema 的形状保证（列就那几个），也由测试钉住。

import { db } from './db';

// 建表放在**本模块**而不是别处的 schema 大块：那样只要 import 了本模块，表就一定在。
// （2026-11-05 踩过：放 node-permissions.ts 的 exec 块里，单测没 import 它 ⇒ no such table。）
db.exec(`
  CREATE TABLE IF NOT EXISTS node_token_usage (
    network_id    TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    hour          TEXT NOT NULL,
    model         TEXT NOT NULL DEFAULT 'unknown',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    turns         INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, node_id, hour, model)
  );
  CREATE INDEX IF NOT EXISTS idx_node_token_usage_hour ON node_token_usage(network_id, hour);
`);
// 已存在的库补列（SQLite 没有 IF NOT EXISTS for ADD COLUMN）
try { db.exec("ALTER TABLE node_token_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}

export interface TokenUsageInput {
  networkId: string;
  nodeId: string;
  /** 'YYYY-MM-DDTHH'（UTC）；缺省 = 现在这一小时 */
  hour?: string | null;
  /** provider/model 或运行时的自有标识；缺省 'unknown' —— 不假装知道 */
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** 缓存命中的读入量。**必须单列**：opencode 实测 cache.read 是 input+output 的 289 倍，
   *  混进去算会让「谁用得多」变成「谁用得久」。 */
  cacheReadTokens?: number | null;
  /** 有的运行时只给总轮数/费用；没有就留空，**不填 0**（0 与"不知道"是两件事） */
  turns?: number | null;
  costUsd?: number | null;
}

const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const MODEL_MAX = 100;

export function currentHourUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (!Number.isSafeInteger(Math.round(value))) return null;
  return Math.round(value);
}

/** 校验 + 归一。返回 null 表示「这一份上报不合规」——调用方负责拒绝，不静默丢。 */
export function normalizeUsage(input: TokenUsageInput): {
  hour: string; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  turns: number | null; costUsd: number | null;
} | null {
  const hour = typeof input.hour === 'string' && input.hour ? input.hour : currentHourUtc();
  if (!HOUR_RE.test(hour)) return null;
  const rawModel = typeof input.model === 'string' ? input.model.trim() : '';
  if (rawModel.length > MODEL_MAX) return null;
  const model = rawModel || 'unknown';
  const inputTokens = nonNegativeInt(input.inputTokens) ?? 0;
  const outputTokens = nonNegativeInt(input.outputTokens) ?? 0;
  const cacheReadTokens = nonNegativeInt(input.cacheReadTokens) ?? 0;
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && input.turns == null && input.costUsd == null) {
    // 什么都没报：不写一行全 0 的记录（那会让"没有用量"和"没上报"在报表上同形）。
    return null;
  }
  const turns = nonNegativeInt(input.turns);
  const costRaw = input.costUsd;
  const costUsd = typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : null;
  return { hour, model, inputTokens, outputTokens, cacheReadTokens, turns, costUsd };
}

/** 记账：同一 (network, node, hour, model) 累加。turns/cost 可空，空则保持原值。 */
export function reportTokenUsage(input: TokenUsageInput): { ok: true; hour: string; model: string } | { ok: false; error: string } {
  const norm = normalizeUsage(input);
  if (!norm) return { ok: false, error: 'invalid_token_usage' };
  db.run(
    `INSERT INTO node_token_usage(network_id, node_id, hour, model, input_tokens, output_tokens, cache_read_tokens, turns, cost_usd, updated_at)
     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, 0), COALESCE(?9, 0), datetime('now'))
     ON CONFLICT(network_id, node_id, hour, model) DO UPDATE SET
       input_tokens  = input_tokens  + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       turns         = COALESCE(turns, 0)         + COALESCE(excluded.turns, 0),
       cost_usd      = COALESCE(cost_usd, 0)      + COALESCE(excluded.cost_usd, 0),
       updated_at    = datetime('now')`,
    // turns / cost_usd 这里存 0 = 「没有这一项」。**存储层不区分「0 轮」与「没报轮数」**，
    // 这是已知偏差（见文件头「已知边界」）；要区分得加一列 has_turns，成本不值。
    [input.networkId, input.nodeId, norm.hour, norm.model, norm.inputTokens, norm.outputTokens,
      norm.cacheReadTokens, norm.turns, norm.costUsd],
  );
  return { ok: true, hour: norm.hour, model: norm.model };
}

export interface NodeTokenUsageRow {
  node_id: string;
  alias: string | null;
  input_tokens: number;
  output_tokens: number;
  /** input+output（**不含 cache**）—— 报表默认看这个 */
  total_tokens: number;
  /** 单列；opencode 上它可能是 total 的几百倍 */
  cache_read_tokens: number;
  turns: number;
  cost_usd: number;
  models: number;
  first_hour: string | null;
  last_hour: string | null;
}

/**
 * 读账：按节点聚合。`sinceHours` 用 UTC 小时桶比较（与写入同口径）。
 *
 * 排序：total_tokens 降序 —— 审计第一眼要看"谁最多"，而不是按名字排。
 */
export function readTokenUsage(networkId: string, sinceHours = 24): NodeTokenUsageRow[] {
  const hours = Math.max(1, Math.min(24 * 90, Math.floor(sinceHours)));
  const since = currentHourUtc(Date.now() - hours * 3600_000);
  const rows = db.all<{
    node_id: string; alias: string | null;
    input_tokens: number; output_tokens: number;
    // #3950 —— SELECT 里已经有 SUM(cache_read_tokens)，类型漏了它时
    // `r.cache_read_tokens` 在 TS 上是错的，而运行期是 undefined ⇒ totals 变成 NaN。
    cache_read_tokens: number | null;
    turns: number; cost_usd: number; models: number;
    first_hour: string | null; last_hour: string | null;
  }>(
    `SELECT u.node_id,
            COALESCE(n.alias, s.alias) AS alias,
            SUM(u.input_tokens)  AS input_tokens,
            SUM(u.output_tokens) AS output_tokens,
            SUM(u.cache_read_tokens) AS cache_read_tokens,
            SUM(u.turns)         AS turns,
            SUM(u.cost_usd)      AS cost_usd,
            COUNT(DISTINCT u.model) AS models,
            MIN(u.hour) AS first_hour,
            MAX(u.hour) AS last_hour
       FROM node_token_usage u
       LEFT JOIN nodes n ON n.node_id = u.node_id AND n.network_id = u.network_id
       LEFT JOIN sessions s ON s.node_id = u.node_id AND s.network_id = u.network_id
      WHERE u.network_id = ?1 AND u.hour >= ?2
      GROUP BY u.node_id
      ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens)) DESC`,
    networkId, since,
  );
  return rows.map((r) => ({
    ...r,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    total_tokens: (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
  }));
}

/** 记账表与读账口径都只认这几个列 —— 形状就是「不收内容」的保证。 */
export const NODE_TOKEN_USAGE_COLUMNS = [
  'network_id', 'node_id', 'hour', 'model',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'turns', 'cost_usd', 'updated_at',
] as const;

// ── 覆盖率：让「只有一行」不被读成「只有一个节点在干活」 ──
//
// 生产实测（2026-11-06）：203 个 agent-node 里只有 1 个 >= .180（会报 token），
// 其余停在 .164 / .146。于是 /api/token-usage 只返回 1 行 —— 那不是"系统没工作"，
// 是"几乎没有节点拥有这个能力"。这两个解释在报表上同形，分母必须一起给。

/** agent-node 从哪一版开始上报 token（.180 加 claude/codex，.181 加 opencode 增量）。 */
export const TOKEN_USAGE_MIN_PREVIEW = 180;

/** 这个 version 字符串会不会上报 token：true / false / null（解析不出，不猜）。 */
export function reportsTokenUsage(version: string | null | undefined): boolean | null {
  const raw = typeof version === "string" ? version.trim() : "";
  const m = /^2\.5\.0-preview\.(\d+)$/.exec(raw);
  if (!m) return null; // 换版本线 / 旧格式 ⇒ 不知道，不猜
  return Number(m[1]) >= TOKEN_USAGE_MIN_PREVIEW;
}

export interface TokenUsageCoverage {
  reporting_nodes: number;
  /** 会话里能解析出版本、且版本 >= 阈值的数量（能力分母） */
  capable_nodes: number;
  sessions_with_version: number;
  /** 解析不出版本线的会话数（不含在 capable 里，也不假装它们不能报） */
  sessions_without_known_version: number;
}

export function tokenUsageCoverage(
  networkId: string,
  reportingNodes: number,
  get: (sql: string, ...params: any[]) => Array<{ version: string | null }>,
): TokenUsageCoverage {
  const rows = get("SELECT version FROM sessions WHERE network_id = ?1", networkId);
  let capable = 0, known = 0;
  for (const r of rows) {
    const verdict = reportsTokenUsage(r.version);
    if (verdict === null) continue;
    known += 1;
    if (verdict) capable += 1;
  }
  return {
    reporting_nodes: reportingNodes,
    capable_nodes: capable,
    sessions_with_version: known,
    sessions_without_known_version: rows.length - known,
  };
}
