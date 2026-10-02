// #491 / #492 —— 任务到期提醒(Hub 侧)。
//
// 每 COMMHUB_DUE_REMINDER_TICK_MS(默认 10 分钟)扫一次「没完成、没归档、有预计完成时间」的卡,按下面三种发提醒:
//   due_soon  即将到期:日期型 due = 明天;时刻型 due 在 24 小时内(且不是今天)。每个 due 值一次。
//   due_today 今天到期:日期型 due = 今天;时刻型 due 落在今天且还没到。每个 due 值一次。
//   overdue   已逾期 N 天:每个自然日最多一次;逾期超过 COMMHUB_DUE_OVERDUE_MAX_DAYS(默认 7)天后不再提醒
//             (上线当天不会把几个月前的旧卡一次性刷一遍,也不会天天提醒一张早被遗忘的卡)。
// 「今天 / 明天 / 自然日」按 COMMHUB_DUE_REMINDER_TZ(默认 Asia/Shanghai)算。网络没有时区设置;due 的存法不变:
//   日期型原样「YYYY-MM-DD」(requirements.ts normalizeDue:全天,客户端按查看者本地理解),时刻型是 UTC 秒。
//
// 收件人:
//   人 —— 负责人(owner)+ 参与人里的人,去重。走 #462/#464 的 Hub 通知路(agent-notice.ts:user_inbox +
//         /events/users/me desktop_message)。发信别名 = 负责 Agent 的别名(收件人看得见它时 → 出现在与它的会话里),
//         否则 DUE_REMINDER_SENDER「任务提醒」。
//   负责 Agent(agent_owner 节点)—— 一条不需要回复的消息:与 send_message 同一写法(inbox type='message' +
//         new_message 推送),不是任务。节点不在 active 状态(停了 / 删除中)就不发。
// 停止:卡完成 / 归档 / 清空 due → 扫描查询本身就选不到它;due 往后挪 → 那一档不再成立,而新 due 值重新上膛。
// 去重:requirement_due_reminders 主键 (requirement_id, kind, due_on, day),先 INSERT … ON CONFLICT DO NOTHING
//   抢到这一行(changes = 1)才发 —— 重启、多次扫描、并发都不会重发。宁可漏一次(发送中途崩溃),不发两次。
// 只加表:旧 Hub 回滚后不认识这张表也不碰它。
//
// 上线护栏(生产上有别的团队的网络和节点):
//   COMMHUB_DUE_REMINDER_NETWORKS=<id,id,…>  只给这些网络发;不设 = 所有网络(自建 Hub 默认就有这个功能)。
//   COMMHUB_DUE_REMINDER_NODES=1              给负责 Agent 节点发消息;默认关(人照常提醒)。
//   开通时不补发:每个网络第一次被扫描到时记一行基线(kind='baseline',sent_at = 那一刻)。只有在基线**之后**才变成逾期的卡
//     会收到「已逾期」提醒;基线之前就已经逾期的卡永远不发逾期提醒(打开功能 / 把网络加进白名单都不会刷一批旧卡)。
//     选这个而不是「把旧卡逐张记成已发」:不用每卡每天写行,也不怕某张旧卡第一次没被扫到、第二天又冒出来。
//     即将到期 / 今天到期不受基线影响(它们本来就只在临近时发一次)。

import type { DbAdapter } from "./db-adapter.js";
import { db, uuidv4 } from "./db.js";
import { sendAgentNotice } from "./agent-notice.js";
import { canSeeAgent } from "./agent-access.js";
import { assertNodeActive } from "./lifecycle-guard.js";
import { pushEvent } from "./push.js";
import { pendingInboxCount } from "./inbox-count.js";

export const DUE_REMINDER_KIND = "task_due";
export const DUE_REMINDER_SENDER = "任务提醒";
export type DueKind = "due_soon" | "due_today" | "overdue";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 60;

/** IF NOT EXISTS:重复执行无副作用;SQLite / PostgreSQL 同一段。 */
export function ensureDueReminders(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS requirement_due_reminders (
      requirement_id TEXT NOT NULL,
      kind           TEXT NOT NULL,
      due_on         TEXT NOT NULL,
      day            TEXT NOT NULL,
      network_id     TEXT NOT NULL,
      sent_at        TEXT NOT NULL,
      PRIMARY KEY (requirement_id, kind, due_on, day)
    );
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirement_due_reminders_sent ON requirement_due_reminders(sent_at)");
  // 扫描查询按 due_on 取一段范围:只给有 due 的行建索引。
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_due_on ON requirements(due_on) WHERE due_on IS NOT NULL");
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function dueReminderTimezone(): string {
  const tz = process.env.COMMHUB_DUE_REMINDER_TZ?.trim() || "Asia/Shanghai";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "Asia/Shanghai"; }
}
/** COMMHUB_DUE_REMINDER_NETWORKS:逗号分隔的网络 id;没设(或只有空白)→ null = 所有网络。 */
export function reminderNetworks(): string[] | null {
  const raw = process.env.COMMHUB_DUE_REMINDER_NETWORKS;
  if (raw === undefined) return null;
  const ids = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return ids.length ? ids : null;
}
export function nodeRemindersEnabled(): boolean { return process.env.COMMHUB_DUE_REMINDER_NODES === "1"; }
export const BASELINE_KIND = "baseline";

export function overdueMaxDays(): number { return Math.floor(envNumber("COMMHUB_DUE_OVERDUE_MAX_DAYS", 7, 0)); }

// ── 时区小工具 ─────────────────────────────────────────────
/** 某一时刻在 tz 的日期「YYYY-MM-DD」。 */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
/** 日期 + n 天(纯日历运算,与时区无关)。 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}
/** 两个日期相差几天(a - b)。 */
export function dayDiff(a: string, b: string): number {
  const ms = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(a) - ms(b)) / DAY_MS);
}
function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** tz 里某天 00:00 对应的 UTC 时刻(ms)。 */
export function localMidnightMs(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

const isDateOnly = (due: string) => due.length === 10;

/** 从哪一刻起算逾期:日期型 = tz 里第二天零点;时刻型 = 那个时刻。 */
export function overdueSinceMs(due: string, tz: string): number {
  return isDateOnly(due) ? localMidnightMs(addDays(due, 1), tz) : Date.parse(due);
}

/** 这张卡此刻该发哪一档(没有 → null)。day = 去重用的那一天。 */
export function dueReminderFor(due: string, nowMs: number, tz: string, maxOverdue = overdueMaxDays()): { kind: DueKind; day: string; overdueDays: number; dueDay: string } | null {
  const today = localDate(nowMs, tz);
  if (isDateOnly(due)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
    if (due === today) return { kind: "due_today", day: due, overdueDays: 0, dueDay: due };
    if (due === addDays(today, 1)) return { kind: "due_soon", day: due, overdueDays: 0, dueDay: due };
    if (due < today) {
      const n = dayDiff(today, due);
      return n <= maxOverdue ? { kind: "overdue", day: today, overdueDays: n, dueDay: due } : null;
    }
    return null;
  }
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return null;
  const dueDay = localDate(t, tz);
  if (t <= nowMs) {
    const n = dayDiff(today, dueDay);
    return n <= maxOverdue ? { kind: "overdue", day: today, overdueDays: n, dueDay } : null;
  }
  if (dueDay === today) return { kind: "due_today", day: dueDay, overdueDays: 0, dueDay };
  if (t - nowMs <= DAY_MS) return { kind: "due_soon", day: dueDay, overdueDays: 0, dueDay };
  return null;
}

/**
 * 列表筛选(requirements.ts listFilters)用的条件:overdue / due_within_days。只看没完成的卡。
 * 日期型(长度 10)按 tz 的「今天」比日期;时刻型(UTC 字符串)按此刻比时刻。字符串比较:两种形状各自同长、同格式。
 */
export function overdueSql(params: unknown[], nowMs: number, tz: string): string {
  const today = localDate(nowMs, tz);
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `(due_on IS NOT NULL AND column_name <> 'done' AND ((length(due_on) = 10 AND due_on < ?${params.push(today)}) OR (length(due_on) > 10 AND due_on <= ?${params.push(nowIso)})))`;
}
/** 没逾期、且在 tz 的「今天 + days」那天结束之前到期(0 = 今天内)。 */
export function dueWithinSql(params: unknown[], days: number, nowMs: number, tz: string): string {
  const today = localDate(nowMs, tz);
  const lastDay = addDays(today, days);
  const endIso = new Date(localMidnightMs(addDays(lastDay, 1), tz)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `(due_on IS NOT NULL AND column_name <> 'done' AND ((length(due_on) = 10 AND due_on >= ?${params.push(today)} AND due_on <= ?${params.push(lastDay)}) OR (length(due_on) > 10 AND due_on > ?${params.push(nowIso)} AND due_on < ?${params.push(endIso)})))`;
}

// ── 扫描 ───────────────────────────────────────────────────
type DueRow = {
  requirement_id: string; network_id: string; seq: number | null; title: string; due_on: string;
  owner_json: string | null; participants_json: string | null; agent_owner_json: string | null;
};
const parse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const userIdOf = (ref: unknown): string | null => {
  const r = ref as { kind?: unknown; id?: unknown } | null;
  return r && r.kind === "user" && typeof r.id === "string" ? r.id : null;
};

export function humanRecipients(row: Pick<DueRow, "owner_json" | "participants_json">): string[] {
  const ids = new Set<string>();
  const owner = userIdOf(parse(row.owner_json));
  if (owner) ids.add(owner);
  const participants = parse(row.participants_json);
  if (Array.isArray(participants)) for (const p of participants) { const id = userIdOf(p); if (id) ids.add(id); }
  return [...ids];
}

function fmtDue(due: string, tz: string): string {
  if (isDateOnly(due)) return due;
  const t = Date.parse(due);
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
  return s;
}

export function dueReminderText(row: Pick<DueRow, "seq" | "title" | "due_on">, r: { kind: DueKind; overdueDays: number }, tz: string): { title: string; text: string } {
  const card = `${row.seq ? `#${row.seq} ` : ""}「${row.title}」`;
  const when = fmtDue(row.due_on, tz);
  if (r.kind === "due_soon") return { title: "任务即将到期", text: `任务${card}即将到期(预计完成 ${when})。` };
  if (r.kind === "due_today") return { title: "任务今天到期", text: `任务${card}今天到期(预计完成 ${when})。` };
  const late = r.overdueDays >= 1 ? `已逾期 ${r.overdueDays} 天` : "已过预计完成时间";
  return { title: "任务已逾期", text: `任务${card}${late}(预计完成 ${when}),还没有完成。` };
}

export type DueReminderSent = { requirement_id: string; kind: DueKind; users: string[]; node: string | null };

/**
 * 跑一次。now 可注入(测试用假时钟)。返回这次真正发出的提醒。
 * 一条按 due_on 范围走索引的查询取候选;每个候选先抢去重行,抢到才发。
 */
export function runDueReminders(opts: { now?: number } = {}): DueReminderSent[] {
  const nowMs = opts.now ?? Date.now();
  const tz = dueReminderTimezone();
  const maxOverdue = overdueMaxDays();
  const today = localDate(nowMs, tz);
  // 范围:最老 = 今天 - maxOverdue - 1(UTC 日期 ≤ 本地日期,多留一天);最新 < 今天 + 2(24 小时内的时刻型 UTC 日期 ≤ 明天)。
  const lo = addDays(today, -maxOverdue - 1);
  const hi = addDays(today, 2);
  const allow = reminderNetworks();
  const sentAt = new Date(nowMs).toISOString();
  // 基线:范围内每个网络第一次被扫到的那一刻(已有就不动)。一条 INSERT … SELECT。
  {
    const bp: unknown[] = [BASELINE_KIND, sentAt];
    // WHERE 必须有:SQLite 里「INSERT … SELECT … FROM t ON CONFLICT」会把 ON 读成 JOIN 约束(语法错),要一个 WHERE 隔开。
    const where = ` WHERE 1=1${allow ? ` AND network_id IN (${allow.map((id) => `?${bp.push(id)}`).join(", ")})` : ""}`;
    db.run(
      `INSERT INTO requirement_due_reminders (requirement_id, kind, due_on, day, network_id, sent_at)
       SELECT '__baseline__:' || network_id, ?1, '', '', network_id, ?2 FROM networks${where}
       ON CONFLICT DO NOTHING`,
      bp,
    );
  }
  const baselines = new Map(
    db.all<{ network_id: string; sent_at: string }>("SELECT network_id, sent_at FROM requirement_due_reminders WHERE kind = ?1", BASELINE_KIND)
      .map((b) => [b.network_id, Date.parse(b.sent_at)]),
  );
  const params: unknown[] = [lo, hi];
  const netFilter = allow ? ` AND network_id IN (${allow.map((id) => `?${params.push(id)}`).join(", ")})` : "";
  const rows = db.all<DueRow>(
    `SELECT requirement_id, network_id, seq, title, due_on, owner_json, participants_json, agent_owner_json
       FROM requirements
      WHERE due_on IS NOT NULL AND due_on >= ?1 AND due_on < ?2 AND column_name <> 'done' AND COALESCE(archived, 0) = 0${netFilter}`,
    ...params,
  );
  const out: DueReminderSent[] = [];
  for (const row of rows) {
    const r = dueReminderFor(row.due_on, nowMs, tz, maxOverdue);
    if (!r) continue;
    if (r.kind === "overdue") {
      // 基线之前就已经逾期 → 不发(开通时不补发)。没有基线(网络行不存在)= 当作此刻开通。
      const base = baselines.get(row.network_id) ?? nowMs;
      if (overdueSinceMs(row.due_on, tz) < base) continue;
    }
    try {
      const claimed = db.run(
        `INSERT INTO requirement_due_reminders (requirement_id, kind, due_on, day, network_id, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
        [row.requirement_id, r.kind, row.due_on, r.day, row.network_id, sentAt],
      );
      if (claimed.changes < 1) continue;
      out.push(deliver(row, r, tz));
    } catch (e: any) {
      console.error(`[due-reminders] ${row.requirement_id} ${r.kind} failed: ${e?.message || e}`);
    }
  }
  // 去重行保留 RETENTION_DAYS 天(比逾期上限长得多,删掉的行不会再被需要)。
  try { db.run("DELETE FROM requirement_due_reminders WHERE sent_at < ?1 AND kind <> ?2", [new Date(nowMs - RETENTION_DAYS * DAY_MS).toISOString(), BASELINE_KIND]); } catch {}
  return out;
}

function deliver(row: DueRow, r: { kind: DueKind; overdueDays: number; dueDay: string }, tz: string): DueReminderSent {
  const { title, text } = dueReminderText(row, r, tz);
  const agent = parse(row.agent_owner_json) as { kind?: unknown; id?: unknown } | null;
  const nodeId = agent?.kind === "node" && typeof agent.id === "string" ? agent.id : null;
  const node = nodeId
    ? db.get<{ alias: string | null }>("SELECT alias FROM nodes WHERE node_id = ?1 AND network_id = ?2", nodeId, row.network_id)
    : null;
  const alias = node?.alias || null;
  const meta = { task_notice: { requirement_id: row.requirement_id, seq: row.seq ?? null, network_id: row.network_id, due_reminder: r.kind, due: row.due_on, overdue_days: r.overdueDays } };
  const users: string[] = [];
  for (const userId of humanRecipients(row)) {
    const fromAlias = alias && canSeeAgent(userId, row.network_id, { alias, nodeId }) ? alias : DUE_REMINDER_SENDER;
    const id = sendAgentNotice({
      networkId: row.network_id, userId, fromAlias, kind: DUE_REMINDER_KIND, title, text,
      severity: r.kind === "overdue" ? "warning" : "info", meta, idPrefix: "dm_due_",
    });
    if (id) users.push(userId);
  }
  let notifiedNode: string | null = null;
  if (alias && nodeRemindersEnabled() && assertNodeActive(alias, row.network_id).ok) {
    const id = uuidv4();
    const message = `[${title}] ${text}\n(这是提醒,不需要回复。requirement_id=${row.requirement_id})`;
    db.run(
      `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
       VALUES (?1, ?2, ?3, 'message', 'normal', ?4, ?5, ?6)`,
      [id, alias, nodeId, message, DUE_REMINDER_SENDER, row.network_id],
    );
    pushEvent(alias, { type: "new_message", inbox_count: pendingInboxCount(alias, row.network_id), from: DUE_REMINDER_SENDER, message_id: id }, row.network_id);
    notifiedNode = alias;
  }
  return { requirement_id: row.requirement_id, kind: r.kind as DueKind, users, node: notifiedNode };
}

/** startHub 里调用。COMMHUB_DUE_REMINDERS=0 关掉;bootServer(测试)不调用它。第一次扫描延后一个间隔外的 30 秒,不和启动抢。 */
export function startDueReminderTimer(): ReturnType<typeof setInterval> | null {
  if (process.env.COMMHUB_DUE_REMINDERS === "0") return null;
  const ms = envNumber("COMMHUB_DUE_REMINDER_TICK_MS", 10 * 60_000, 1_000);
  const tick = () => { try { runDueReminders(); } catch (e: any) { console.error(`[due-reminders] tick failed: ${e?.message || e}`); } };
  const first = setTimeout(tick, Math.min(ms, 30_000));
  (first as any)?.unref?.();
  return setInterval(tick, ms);
}
