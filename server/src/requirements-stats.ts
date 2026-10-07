// 任务仪表盘的聚合(GET /api/requirements/stats)。纯函数:行由 requirements.ts 按调用者的可见范围读出来,
// 这里只按时间范围 / 时区分桶、按项目 / 完成者计数。放在 JS 里而不是 SQL:按 IANA 时区切「哪一天」在
// SQLite 和 PostgreSQL 上写法不同,而一个网络的卡片数是几百到几千,整表轻量列读一次就够。
import { isoInstant } from "./requirements-migrate.js";

export const STATS_DEFAULT_DAYS = 30;
export const STATS_MAX_DAYS = 371; // 53 周:够画一整年的贡献热力图
export const STATS_SPARK_DAYS = 14;
export const STATS_TOP_COMPLETERS = 20;
export const STATS_DEFAULT_RECENT = 10;
export const STATS_MAX_RECENT = 50;

export type StatsRow = {
  requirement_id: string;
  seq: number | null;
  title: string;
  project_id: string | null;
  column_name: string;
  archived: number | null;
  created_at: string | null;
  completed_at: string | null;
  completed_at_approx: number | null;
  completed_by_json: string | null;
};

export type StatsQuery = { fromMs: number | null; toMs: number; tz: string; days: number; recent: number };
type Ref = { kind: "user" | "node"; id: string };

/** 解析 from / to / tz / days。不合法 → 错误码(400)。to 缺省 = 现在;from 缺省 = 不设下限(全部)。 */
export function parseStatsQuery(q: URLSearchParams, nowMs: number): StatsQuery | { error: string } {
  const instant = (name: string): number | null | { error: string } => {
    const raw = q.get(name);
    if (raw === null || raw === "") return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : { error: `invalid_${name}` };
  };
  const from = instant("from");
  if (from !== null && typeof from === "object") return from;
  const to = instant("to");
  if (to !== null && typeof to === "object") return to;
  const toMs = to ?? nowMs;
  if (from !== null && from > toMs) return { error: "invalid_range" };
  const tz = q.get("tz") || "UTC";
  if (tz.length > 64 || !validTimeZone(tz)) return { error: "invalid_tz" };
  const daysRaw = q.get("days");
  const days = daysRaw === null || daysRaw === "" ? STATS_DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > STATS_MAX_DAYS) return { error: "invalid_days" };
  const recentRaw = q.get("recent");
  const recent = recentRaw === null || recentRaw === "" ? STATS_DEFAULT_RECENT : Number(recentRaw);
  if (!Number.isInteger(recent) || recent < 0 || recent > STATS_MAX_RECENT) return { error: "invalid_recent" };
  return { fromMs: from, toMs, tz, days, recent };
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}

/** 某一时刻在 tz 里是哪一天(YYYY-MM-DD)。 */
export function localDate(ms: number, tz: string): string {
  // en-CA 的日期格式就是 YYYY-MM-DD。
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** 以 lastDay(YYYY-MM-DD)结尾、往前数 n 天的日期列表(旧 → 新)。纯日历运算,与时区无关。 */
export function dayRange(lastDay: string, n: number): string[] {
  const [y, m, d] = lastDay.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

const msOf = (v: string | null): number | null => {
  const iso = isoInstant(v);
  return iso === null ? null : Date.parse(iso);
};
const parseRef = (json: string | null): Ref | null => {
  if (!json) return null;
  try {
    const r = JSON.parse(json);
    return r && (r.kind === "user" || r.kind === "node") && typeof r.id === "string" ? { kind: r.kind, id: r.id } : null;
  } catch { return null; }
};

/**
 * hidden:受限成员看不见的节点(与列表里 hiddenNodeFilter 同一个判定)。这些节点完成的卡照样计数,
 * 但归到 unattributed,不出现在 by_completer 里 —— 不给他留「那个节点做了几张」的探测口。
 */
export function aggregateStats(rows: StatsRow[], q: StatsQuery, hidden: ((nodeId: string) => boolean) | null) {
  const inRange = (ms: number | null) => ms !== null && ms <= q.toMs && (q.fromMs === null || ms >= q.fromMs);
  const days = dayRange(localDate(q.toMs, q.tz), q.days);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const sparkDays = new Set(days.slice(-STATS_SPARK_DAYS));
  const daily = new Map(days.map(d => [d, 0]));

  let done = 0, approx = 0, created = 0, createdDone = 0, doing = 0, pool = 0, abandoned = 0, unattributed = 0;
  const byProject = new Map<string | null, number>();
  const byCompleter = new Map<string, { ref: Ref; n: number; spark: Map<string, number> }>();
  const recent: { row: StatsRow; ms: number; by: Ref | null }[] = [];

  for (const row of rows) {
    // 当前还开着的卡(不看时间范围;归档的不算「进行中」)。
    if (!row.archived && row.column_name === "doing") doing++;
    if (!row.archived && row.column_name === "pool") pool++;
    if (!row.archived && row.column_name === "abandoned") abandoned++;
    const completedMs = row.column_name === "done" ? msOf(row.completed_at) : null;
    const createdMs = msOf(row.created_at);
    if (inRange(createdMs)) {
      created++;
      if (completedMs !== null) createdDone++;
    }
    if (completedMs === null) continue;
    // 每日曲线按自己的 days 窗口算(与 from 无关),这样一次请求就能同时画 30 天柱图和一年热力图。
    if (completedMs <= q.toMs) {
      const day = localDate(completedMs, q.tz);
      if (day >= firstDay && day <= lastDay) daily.set(day, (daily.get(day) ?? 0) + 1);
    }
    if (!inRange(completedMs)) continue;
    const who = parseRef(row.completed_by_json);
    recent.push({ row, ms: completedMs, by: who && !(who.kind === "node" && hidden?.(who.id)) ? who : null });
    done++;
    if (row.completed_at_approx) approx++;
    byProject.set(row.project_id, (byProject.get(row.project_id) ?? 0) + 1);
    const ref = parseRef(row.completed_by_json);
    if (!ref || (ref.kind === "node" && hidden?.(ref.id))) { unattributed++; continue; }
    const key = `${ref.kind}:${ref.id}`;
    let c = byCompleter.get(key);
    if (!c) byCompleter.set(key, c = { ref, n: 0, spark: new Map() });
    c.n++;
    const day = localDate(completedMs, q.tz);
    if (sparkDays.has(day)) c.spark.set(day, (c.spark.get(day) ?? 0) + 1);
  }

  const spark = days.slice(-STATS_SPARK_DAYS);
  return {
    range: { from: q.fromMs === null ? null : new Date(q.fromMs).toISOString(), to: new Date(q.toMs).toISOString(), tz: q.tz },
    totals: {
      done,
      // 其中完成时刻是升级前按 updated_at 补的近似值的张数;界面据此标「近似」。
      done_approx: approx,
      created,
      created_done: createdDone,
      // 完成率 = 期内新建的卡里,现在已完成的比例;期内没有新建 → null(不是 0%)。
      completion_rate: created ? createdDone / created : null,
      doing,
      pool,
      // 废弃(关闭,不算开着也不算完成)。旧 App 忽略这个字段。
      abandoned,
    },
    daily: days.map(date => ({ date, n: daily.get(date) ?? 0 })),
    by_project: [...byProject].map(([project_id, n]) => ({ project_id, n })).sort((a, b) => b.n - a.n || String(a.project_id).localeCompare(String(b.project_id))),
    by_completer: [...byCompleter.values()]
      .sort((a, b) => b.n - a.n || `${a.ref.kind}:${a.ref.id}`.localeCompare(`${b.ref.kind}:${b.ref.id}`))
      .slice(0, STATS_TOP_COMPLETERS)
      .map(c => ({ ...c.ref, n: c.n, spark: spark.map(d => c.spark.get(d) ?? 0) })),
    unattributed,
    // 最近完成(新 → 旧):仪表盘的「最近完成」时间线和分享图的「今天完成的任务」。只含期内、调用者看得见的卡;
    // 完成者是隐藏节点 → completed_by = null。
    recent: recent
      .sort((a, b) => b.ms - a.ms || (a.row.requirement_id < b.row.requirement_id ? 1 : -1))
      .slice(0, q.recent)
      .map(({ row, ms, by }) => ({
        id: row.requirement_id, seq: row.seq == null ? null : Number(row.seq), name: row.title, project_id: row.project_id,
        completed_at: new Date(ms).toISOString(), completed_at_approx: !!row.completed_at_approx, completed_by: by, archived: !!row.archived,
      })),
  };
}
