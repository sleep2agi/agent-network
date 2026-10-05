// #491 / #492 / #494 —— 任务到期提醒 + 列表到期筛选。HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 假时钟:runDueReminders({ now }) 注入时刻;时区 = 默认 Asia/Shanghai。
// 网络 NET(boss)。owen = 负责人;pat、pia = 参与人;节点 NODE = 负责 Agent。
// 覆盖:三档各一次(收件人 = 负责人 + 参与人,发信别名 = 负责 Agent;节点收到一条 type=message 的消息,不是任务);
//       同一时刻跑两次 / 同一天跑两次不重发;逾期按天再提醒一次;完成 / 归档 / 清空 due 立即停;due 往后挪重新上膛;
//       时刻型 due;逾期上限;节点停了不发给节点;MCP / REST 的 overdue、due_within_days 筛选与严格参数。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-due-rem-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
delete process.env.COMMHUB_DUE_REMINDER_TZ;
delete process.env.COMMHUB_DUE_OVERDUE_MAX_DAYS;
delete process.env.COMMHUB_DUE_REMINDER_NETWORKS;
delete process.env.COMMHUB_DUE_REMINDERS;
delete process.env.COMMHUB_DUE_REMINDERS_NETWORKS;
delete process.env.COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS;
delete process.env.COMMHUB_DUE_REMINDERS_OWNERS;
// 节点提醒默认关;这个文件的大部分用例要看节点那一路,先打开(「默认关」单独一个用例)。
process.env.COMMHUB_DUE_REMINDER_NODES = "1";
const PW = "DueRemindPassw0rd!x";

type U = { token: string; id: string; username: string };
let BASE = "";
let hub: any = null;
let NET = "";
let db: any;
let due: typeof import("./requirement-due-reminders.js");
let boss: U, owen: U, pat: U, pia: U;
const stamp = Date.now();
const NODE_ID = `node_due_${stamp}`;
const ALIAS = `due-agent-${stamp}`;

// 2026-10-10 10:00 东八(02:00Z)
const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const DAY = 86_400_000;

type R = { status: number; body: any };
async function send(token: string, method: string, path: string, payload?: unknown): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  if (payload.error) return { rpcError: payload.error };
  const item = payload.result.content[0];
  try { return JSON.parse(item.text); } catch { return { isError: payload.result.isError, text: item.text }; }
}
const userRef = (id: string) => ({ kind: "user", id });

async function card(name: string, dueValue: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await send(boss.token, "POST", "/api/requirements", {
    network_id: NET, name, due: dueValue, owner: userRef(owen.id), participants: [userRef(pat.id), userRef(pia.id), userRef(owen.id)],
    agent_owner: { kind: "node", id: NODE_ID }, ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.requirement.id as string;
}
const patch = (id: string, body: Record<string, unknown>) => send(boss.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, body);

/** 这张卡发给人的提醒:收件人 → [{content, from, kind}]。 */
function userNotices(reqId: string): Record<string, Array<{ content: string; from: string; reminder: string }>> {
  const rows = db.all("SELECT user_id, from_session, content, meta_json FROM user_inbox WHERE network_id = ?1 AND kind = 'task_due' ORDER BY created_at, message_id", NET) as any[];
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    const meta = JSON.parse(r.meta_json);
    if (meta?.task_notice?.requirement_id !== reqId) continue;
    (out[r.user_id] ||= []).push({ content: r.content, from: r.from_session, reminder: meta.task_notice.due_reminder });
  }
  return out;
}
function nodeMessages(reqId: string): Array<{ type: string; content: string; from: string }> {
  return (db.all("SELECT type, content, from_session FROM inbox WHERE session_name = ?1 AND network_id = ?2 ORDER BY created_at", ALIAS, NET) as any[])
    .filter(r => String(r.content).includes(reqId)).map(r => ({ type: r.type, content: r.content, from: r.from_session }));
}
const sentFor = (out: Array<{ requirement_id: string; kind: string }>, id: string) => out.filter(x => x.requirement_id === id).map(x => x.kind);

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { addNetworkMember, register } = await import("./auth.js");
  const mk = (name: string): U => {
    const r = register(`dr_${name}_${stamp}`, PW);
    expect(r.ok).toBe(true);
    return { token: r.token!, id: r.user!.user_id, username: r.user!.username };
  };
  const b = register(`dr_boss_${stamp}`, PW);
  boss = { token: b.token!, id: b.user!.user_id, username: b.user!.username };
  NET = b.network_id!;
  owen = mk("owen"); pat = mk("pat"); pia = mk("pia");
  // pat 是受限成员(看不见任何 Agent):他的提醒发信别名不能泄露负责 Agent → 「任务提醒」。
  addNetworkMember(NET, owen.id, "member", boss.id, { taskAccess: "all", agentAccess: "all" });
  addNetworkMember(NET, pia.id, "member", boss.id, { taskAccess: "all", agentAccess: "all" });
  addNetworkMember(NET, pat.id, "member", boss.id, { taskAccess: "all" });
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-code', ?3)", [NODE_ID, ALIAS, NET]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_due_${stamp}`, ALIAS, NODE_ID, NET]);
  due = await import("./requirement-due-reminders.js");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  // 基线:假装功能在 T0 之前 30 天就开着了(否则 T0 第一次扫描会把 NET 里所有逾期卡当「开通前就逾期」不发)。
  due.runDueReminders({ now: T0 - 30 * DAY });
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("时区小工具", () => {
  test("东八的今天 / 零点", () => {
    expect(due.localDate(T0, "Asia/Shanghai")).toBe("2026-10-10");
    expect(due.localDate(Date.UTC(2026, 9, 9, 16, 0), "Asia/Shanghai")).toBe("2026-10-10"); // 00:00 东八
    expect(due.localDate(Date.UTC(2026, 9, 9, 15, 59), "Asia/Shanghai")).toBe("2026-10-09");
    expect(new Date(due.localMidnightMs("2026-10-10", "Asia/Shanghai")).toISOString()).toBe("2026-10-09T16:00:00.000Z");
    expect(new Date(due.localMidnightMs("2026-03-08", "America/New_York")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(due.addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(due.dayDiff("2026-10-10", "2026-10-07")).toBe(3);
  });
  test("分档", () => {
    const tz = "Asia/Shanghai";
    expect(due.dueReminderFor("2026-10-11", T0, tz)?.kind).toBe("due_soon");
    expect(due.dueReminderFor("2026-10-10", T0, tz)?.kind).toBe("due_today");
    expect(due.dueReminderFor("2026-10-12", T0, tz)).toBeNull();
    expect(due.dueReminderFor("2026-10-07", T0, tz)).toMatchObject({ kind: "overdue", overdueDays: 3, day: "2026-10-10" });
    expect(due.dueReminderFor("2026-10-02", T0, tz)).toBeNull(); // 8 天 > 默认上限 7
    expect(due.dueReminderFor("2026-10-10T08:00:00Z", T0, tz)?.kind).toBe("due_today"); // 16:00 东八,今天还没到
    expect(due.dueReminderFor("2026-10-11T01:00:00Z", T0, tz)?.kind).toBe("due_soon"); // 明天 09:00,23 小时内
    expect(due.dueReminderFor("2026-10-11T03:00:00Z", T0, tz)).toBeNull(); // 25 小时后
    expect(due.dueReminderFor("2026-10-10T01:00:00Z", T0, tz)).toMatchObject({ kind: "overdue", overdueDays: 0 });
  });
});

describe("提醒", () => {
  test("即将到期:负责人 + 参与人各一条(发信 = 负责 Agent),节点收到一条不需回复的消息", async () => {
    const id = await card("dr-明天", "2026-10-11");
    const out = due.runDueReminders({ now: T0 });
    expect(sentFor(out, id)).toEqual(["due_soon"]);
    const n = userNotices(id);
    expect(Object.keys(n).sort()).toEqual([owen.id, pat.id, pia.id].sort());
    expect(n[pat.id][0].from).toBe(due.DUE_REMINDER_SENDER);
    for (const uid of [owen.id, pat.id, pia.id]) {
      expect(n[uid]).toHaveLength(1);
      if (uid !== pat.id) expect(n[uid][0].from).toBe(ALIAS);
      expect(n[uid][0].reminder).toBe("due_soon");
      expect(n[uid][0].content).toContain("「dr-明天」即将到期");
    }
    expect(n[boss.id]).toBeUndefined(); // 创建者不是负责人 / 参与人:不提醒
    const m = nodeMessages(id);
    expect(m).toHaveLength(1);
    expect(m[0].type).toBe("message");
    expect(m[0].from).toBe(due.DUE_REMINDER_SENDER);
    // 不是任务:tasks 表里没有这张卡的提醒
    expect((db.all("SELECT task_id FROM tasks WHERE network_id = ?1 AND content LIKE ?2", NET, `%${id}%`) as any[]).length).toBe(0);
  });

  test("今天到期 + 同一时刻 / 同一天再跑不重发(去重表)", async () => {
    const id = await card("dr-今天", "2026-10-10");
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["due_today"]);
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual([]);
    expect(sentFor(due.runDueReminders({ now: T0 + 6 * 3600_000 }), id)).toEqual([]);
    expect(userNotices(id)[owen.id]).toHaveLength(1);
    expect(nodeMessages(id)).toHaveLength(1);
    const rows = db.all("SELECT kind, due_on, day FROM requirement_due_reminders WHERE requirement_id = ?1", id) as any[];
    expect(rows).toEqual([{ kind: "due_today", due_on: "2026-10-10", day: "2026-10-10" }]);
  });

  test("已逾期 N 天:每天最多一次,第二天再一次(N+1)", async () => {
    const id = await card("dr-逾期", "2026-10-07");
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["overdue"]);
    expect(sentFor(due.runDueReminders({ now: T0 + 3600_000 }), id)).toEqual([]);
    expect(sentFor(due.runDueReminders({ now: T0 + DAY }), id)).toEqual(["overdue"]);
    const texts = userNotices(id)[pat.id].map(x => x.content).sort();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("已逾期 3 天");
    expect(texts[1]).toContain("已逾期 4 天");
  });

  test("完成 / 归档 / 清空 due → 立即停", async () => {
    const done = await card("dr-完成", "2026-10-08");
    const arch = await card("dr-归档", "2026-10-08");
    const cleared = await card("dr-清空", "2026-10-08");
    expect((await patch(done, { column: "done" })).status).toBe(200);
    expect((await patch(arch, { archived: true })).status).toBe(200);
    expect((await patch(cleared, { due: "" })).status).toBe(200);
    const out = due.runDueReminders({ now: T0 });
    for (const id of [done, arch, cleared]) {
      expect(sentFor(out, id)).toEqual([]);
      expect(userNotices(id)).toEqual({});
    }
  });

  test("逾期提醒发过后改完成:第二天不再提醒", async () => {
    const id = await card("dr-逾期后完成", "2026-10-09");
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["overdue"]);
    expect((await patch(id, { column: "done" })).status).toBe(200);
    expect(sentFor(due.runDueReminders({ now: T0 + DAY }), id)).toEqual([]);
    expect(userNotices(id)[owen.id]).toHaveLength(1);
  });

  test("due 往后挪:旧档不再成立,新 due 重新上膛", async () => {
    const id = await card("dr-挪", "2026-10-10");
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["due_today"]);
    expect((await patch(id, { due: "2026-10-20" })).status).toBe(200);
    expect(sentFor(due.runDueReminders({ now: T0 + 3600_000 }), id)).toEqual([]); // 太远:不发
    expect((await patch(id, { due: "2026-10-11" })).status).toBe(200);
    expect(sentFor(due.runDueReminders({ now: T0 + 2 * 3600_000 }), id)).toEqual(["due_soon"]);
    expect(sentFor(due.runDueReminders({ now: T0 + DAY }), id)).toEqual(["due_today"]);
  });

  test("时刻型 due:今天稍后 = 今天到期;23 小时后 = 即将到期;已过 = 已过预计完成时间", async () => {
    const later = await card("dr-时刻今天", "2026-10-10T16:00:00+08:00");
    const soon = await card("dr-时刻明早", "2026-10-11T09:00:00+08:00");
    const past = await card("dr-时刻已过", "2026-10-10T09:00:00+08:00");
    const out = due.runDueReminders({ now: T0 });
    expect(sentFor(out, later)).toEqual(["due_today"]);
    expect(sentFor(out, soon)).toEqual(["due_soon"]);
    expect(sentFor(out, past)).toEqual(["overdue"]);
    expect(userNotices(later)[owen.id][0].content).toContain("2026-10-10 16:00");
    expect(userNotices(past)[owen.id][0].content).toContain("已过预计完成时间");
  });

  test("逾期超过上限不提醒;上限可配", async () => {
    const id = await card("dr-老卡", "2026-09-30");
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual([]);
    process.env.COMMHUB_DUE_OVERDUE_MAX_DAYS = "30";
    try { expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["overdue"]); }
    finally { delete process.env.COMMHUB_DUE_OVERDUE_MAX_DAYS; }
  });

  test("没有负责 Agent:发信 = 任务提醒;节点停了:节点不收,人照收", async () => {
    const noAgent = await card("dr-无Agent", "2026-10-11", { agent_owner: null });
    db.run("UPDATE nodes SET lifecycle_state = 'stopped' WHERE node_id = ?1", [NODE_ID]);
    try {
      const stopped = await card("dr-节点停", "2026-10-11");
      const out = due.runDueReminders({ now: T0 + 3 * 3600_000 });
      expect(out.find(x => x.requirement_id === noAgent)?.node).toBeNull();
      expect(userNotices(noAgent)[owen.id][0].from).toBe(due.DUE_REMINDER_SENDER);
      expect(out.find(x => x.requirement_id === stopped)?.node).toBeNull();
      expect(nodeMessages(stopped)).toEqual([]);
      expect(userNotices(stopped)[pia.id]).toHaveLength(1);
    } finally {
      db.run("UPDATE nodes SET lifecycle_state = 'active' WHERE node_id = ?1", [NODE_ID]);
    }
  });
});

describe("上线护栏", () => {
  const mkNet = (tag: string) => {
    const r = (globalThis as any).__register(`dr_${tag}_${stamp}`, PW);
    return { token: r.token as string, id: r.user.user_id as string, net: r.network_id as string };
  };
  async function cardIn(o: { token: string; id: string; net: string }, name: string, dueValue: string, extra: Record<string, unknown> = {}) {
    const r = await send(o.token, "POST", "/api/requirements", { network_id: o.net, name, due: dueValue, owner: userRef(o.id), ...extra });
    expect(r.status).toBe(201);
    return r.body.requirement.id as string;
  }
  beforeAll(async () => { (globalThis as any).__register = (await import("./auth.js")).register; });

  test("网络白名单:设了只发白名单里的网络;不设 = 所有网络", async () => {
    const other = mkNet("other");
    due.runDueReminders({ now: T0 - 30 * DAY }); // other 的基线
    const mine = await card("dr-白名单内", "2026-10-11");
    const theirs = await cardIn(other, "dr-白名单外", "2026-10-11");
    process.env.COMMHUB_DUE_REMINDER_NETWORKS = ` ${NET} , `;
    try {
      const out = due.runDueReminders({ now: T0 });
      expect(sentFor(out, mine)).toEqual(["due_soon"]);
      expect(sentFor(out, theirs)).toEqual([]);
      expect(db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE requirement_id = ?1", theirs).n).toBe(0);
    } finally { delete process.env.COMMHUB_DUE_REMINDER_NETWORKS; }
    expect(sentFor(due.runDueReminders({ now: T0 }), theirs)).toEqual(["due_soon"]);
  });

  test("节点提醒默认关:人照收,节点 inbox 没有", async () => {
    delete process.env.COMMHUB_DUE_REMINDER_NODES;
    try {
      const id = await card("dr-节点默认关", "2026-10-11");
      const out = due.runDueReminders({ now: T0 + 4 * 3600_000 });
      expect(sentFor(out, id)).toEqual(["due_soon"]);
      expect(out.find(x => x.requirement_id === id)?.node).toBeNull();
      expect(nodeMessages(id)).toEqual([]);
      expect(userNotices(id)[owen.id]).toHaveLength(1);
    } finally { process.env.COMMHUB_DUE_REMINDER_NODES = "1"; }
  });

  test("开通时不补发:基线前就逾期的卡不发逾期提醒(第二天也不发);基线后才逾期的照发;今天 / 明天到期照发", async () => {
    const fresh = mkNet("fresh");
    const old = await cardIn(fresh, "dr-开通前逾期", "2026-10-07");
    const oldTime = await cardIn(fresh, "dr-开通前逾期时刻", "2026-10-10T09:00:00+08:00");
    const today = await cardIn(fresh, "dr-开通当天到期", "2026-10-10");
    const tomorrow = await cardIn(fresh, "dr-开通次日到期", "2026-10-11");
    // fresh 网络第一次被扫到 = T0(10:00 东八)
    const first = due.runDueReminders({ now: T0 });
    expect(sentFor(first, old)).toEqual([]);
    expect(sentFor(first, oldTime)).toEqual([]);
    expect(sentFor(first, today)).toEqual(["due_today"]);
    const base = db.get("SELECT sent_at FROM requirement_due_reminders WHERE kind = 'baseline' AND network_id = ?1", fresh.net);
    expect(base.sent_at).toBe(new Date(T0).toISOString());
    // 第二天:旧卡仍不发;「开通当天到期」是在基线之后才逾期的 → 发「已逾期 1 天」;明天到期 → 今天到期
    const next = due.runDueReminders({ now: T0 + DAY });
    expect(sentFor(next, old)).toEqual([]);
    expect(sentFor(next, oldTime)).toEqual([]);
    expect(sentFor(next, today)).toEqual(["overdue"]);
    expect(sentFor(next, tomorrow)).toEqual(["due_today"]);
    // 基线行不被保留期清掉
    due.runDueReminders({ now: T0 + 90 * DAY });
    expect(db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE kind = 'baseline' AND network_id = ?1", fresh.net).n).toBe(1);
  });

  test("白名单后加进来的网络:以加进来那一刻为基线,不补发", async () => {
    const late = mkNet("late");
    process.env.COMMHUB_DUE_REMINDER_NETWORKS = NET;
    try {
      const old = await cardIn(late, "dr-后加网络旧卡", "2026-10-08");
      due.runDueReminders({ now: T0 });
      expect(db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE kind = 'baseline' AND network_id = ?1", late.net).n).toBe(0);
      process.env.COMMHUB_DUE_REMINDER_NETWORKS = `${NET},${late.net}`;
      expect(sentFor(due.runDueReminders({ now: T0 + 3600_000 }), old)).toEqual([]);
    } finally { delete process.env.COMMHUB_DUE_REMINDER_NETWORKS; }
  });

  // ── #524 按网络开关 ────────────────────────────────────
  const SCOPE_VARS = ["COMMHUB_DUE_REMINDERS", "COMMHUB_DUE_REMINDERS_NETWORKS", "COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS", "COMMHUB_DUE_REMINDER_NETWORKS", "COMMHUB_DUE_REMINDERS_OWNERS"];
  async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
    const saved = Object.fromEntries(SCOPE_VARS.map((k) => [k, process.env[k]]));
    for (const k of SCOPE_VARS) delete process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
      for (const k of SCOPE_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    }
  }
  const baselineCount = (net: string) => db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE kind = 'baseline' AND network_id = ?1", net).n;
  const rowCount = (id: string) => db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE requirement_id = ?1", id).n;

  test("#524 范围解析:各种组合 / 空白值 / 只绑本分支用到的参数", async () => {
    const S = (vars: Record<string, string>) => withEnv(vars, () => due.dueReminderScope());
    // 都不设 = 原样:所有网络
    expect(await S({})).toEqual({ mode: "all", exclude: [] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "1" })).toEqual({ mode: "all", exclude: [] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "0" })).toEqual({ mode: "off" });
    // 旧名白名单不能在 =0 时打开(行为不变)
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDER_NETWORKS: "net_a" })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDER_NETWORKS: "net_a" })).toEqual({ mode: "only", include: ["net_a"], exclude: [] });
    // 新名白名单:=0 时也打开,只给名单里的
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: " net_a , net_b,net_a, " })).toEqual({ mode: "only", include: ["net_a", "net_b"], exclude: [] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "1", COMMHUB_DUE_REMINDERS_NETWORKS: "net_a" })).toEqual({ mode: "only", include: ["net_a"], exclude: [] });
    // 黑名单
    expect(await S({ COMMHUB_DUE_REMINDERS: "1", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "net_x" })).toEqual({ mode: "all", exclude: ["net_x"] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "net_x" })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDERS_NETWORKS: "net_a,net_x", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "net_x" })).toEqual({ mode: "only", include: ["net_a"], exclude: ["net_x"] });
    // 空 / 空白 / 只有逗号 = 没设
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: "" })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: "  , ,  " })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDERS_NETWORKS: "   ", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: " , " })).toEqual({ mode: "all", exclude: [] });
    // SQL:每个分支只 push 自己用到的参数
    const p1: unknown[] = ["lo", "hi"];
    expect(due.dueScopeSql({ mode: "all", exclude: [] }, p1)).toBe("");
    expect(p1).toEqual(["lo", "hi"]);
    const p2: unknown[] = ["lo", "hi"];
    expect(due.dueScopeSql({ mode: "all", exclude: ["net_x"] }, p2)).toBe(" AND network_id NOT IN (?3)");
    expect(p2).toEqual(["lo", "hi", "net_x"]);
    const p3: unknown[] = ["lo", "hi"];
    expect(due.dueScopeSql({ mode: "only", include: ["net_a", "net_b"], exclude: [] }, p3)).toBe(" AND network_id IN (?3, ?4)");
    expect(p3).toEqual(["lo", "hi", "net_a", "net_b"]);
    const p4: unknown[] = [];
    expect(due.dueScopeSql({ mode: "only", include: [], exclude: ["net_x"] }, p4)).toBeNull();
    expect(due.dueScopeSql({ mode: "off" }, p4)).toBeNull();
    expect(p4).toEqual([]);
  });

  test("#524 COMMHUB_DUE_REMINDERS=0 + 白名单:只有白名单网络收到;别的网络的行连基线都不写", async () => {
    const other = mkNet("allow_other");
    const mine = await card("dr-524-白名单内", "2026-10-11");
    const theirs = await cardIn(other, "dr-524-白名单外", "2026-10-11");
    const out = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: ` ${NET} ,` }, () => due.runDueReminders({ now: T0 }));
    expect(sentFor(out, mine)).toEqual(["due_soon"]);
    expect(userNotices(mine)[owen.id]).toHaveLength(1);
    expect(sentFor(out, theirs)).toEqual([]);
    expect(rowCount(theirs)).toBe(0);
    expect(baselineCount(other.net)).toBe(0);
    // 对照:=0 不带白名单 → 整个关掉,谁都不发
    const fresh = await card("dr-524-全关", "2026-10-11");
    const off = await withEnv({ COMMHUB_DUE_REMINDERS: "0" }, () => due.runDueReminders({ now: T0 }));
    expect(off).toEqual([]);
    expect(rowCount(fresh)).toBe(0);
    // 白名单空白 = 没设 → 仍然关
    expect(await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: " , " }, () => due.runDueReminders({ now: T0 }))).toEqual([]);
  });

  test("#524 黑名单:功能开着时被排除的网络不发、不写基线;其余照发", async () => {
    const other = mkNet("excl_other");
    const mine = await card("dr-524-未排除", "2026-10-11");
    const theirs = await cardIn(other, "dr-524-被排除", "2026-10-11");
    const out = await withEnv({ COMMHUB_DUE_REMINDERS: "1", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: other.net }, () => due.runDueReminders({ now: T0 }));
    expect(sentFor(out, mine)).toEqual(["due_soon"]);
    expect(sentFor(out, theirs)).toEqual([]);
    expect(rowCount(theirs)).toBe(0);
    expect(baselineCount(other.net)).toBe(0);
    // 白名单里也点了名 → 排除优先;白名单只剩它 → 什么都不扫
    const both = mkNet("excl_both");
    const c = await cardIn(both, "dr-524-白名单又被排除", "2026-10-11");
    const out2 = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: both.net, COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: both.net }, () => due.runDueReminders({ now: T0 }));
    expect(out2).toEqual([]);
    expect(rowCount(c)).toBe(0);
    expect(baselineCount(both.net)).toBe(0);
  });

  test("#524 默认不变:两个新变量都不设 → 所有网络照发;黑名单空白 = 没设", async () => {
    const other = mkNet("dflt_other");
    const mine = await card("dr-524-默认", "2026-10-11");
    const theirs = await cardIn(other, "dr-524-默认别的网络", "2026-10-11");
    const out = await withEnv({}, () => due.runDueReminders({ now: T0 }));
    expect(sentFor(out, mine)).toEqual(["due_soon"]);
    expect(sentFor(out, theirs)).toEqual(["due_soon"]);
    const other2 = mkNet("dflt_blank");
    const theirs2 = await cardIn(other2, "dr-524-黑名单空白", "2026-10-11");
    const out2 = await withEnv({ COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "  " }, () => due.runDueReminders({ now: T0 }));
    expect(sentFor(out2, theirs2)).toEqual(["due_soon"]);
  });

  test("#524 启动:=0 不起定时器;=0 + 白名单起;各打一行范围日志(只有网络 id)", async () => {
    const logs: string[] = [];
    const g = globalThis as any;
    const orig = { log: console.log, setTimeout: g.setTimeout, setInterval: g.setInterval };
    // 不起真定时器(否则 30 秒后会用真时钟扫一遍,干扰后面的用例):只记下调了几次。
    let timers = 0;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    g.setTimeout = () => { timers++; return { unref() {} }; };
    g.setInterval = () => { timers++; return { fake: true }; };
    try {
      const off = await withEnv({ COMMHUB_DUE_REMINDERS: "0" }, () => due.startDueReminderTimer());
      expect(off).toBeNull();
      expect(timers).toBe(0);
      const on = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: "net_placeholder_a" }, () => due.startDueReminderTimer());
      expect(on).toEqual({ fake: true } as any);
      expect(timers).toBe(2);
      await withEnv({ COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "net_placeholder_x" }, () => due.startDueReminderTimer());
    } finally { console.log = orig.log; g.setTimeout = orig.setTimeout; g.setInterval = orig.setInterval; }
    const scopeLogs = logs.filter((l) => l.startsWith("[due-reminders] scope:"));
    expect(scopeLogs).toEqual([
      "[due-reminders] scope: off",
      "[due-reminders] scope: only networks net_placeholder_a",
      "[due-reminders] scope: all networks except net_placeholder_x",
    ]);
  });

  // ── #524 按负责人开关(两个团队共用一个网络,网络名单分不开)────────
  test("#524 负责人名单:范围解析 / 空白 = 没设 / 只在用到时绑参数", async () => {
    const S = (vars: Record<string, string>) => withEnv(vars, () => due.dueReminderScope());
    // =0 + 负责人名单:与网络白名单同一语义 —— 单独就能打开,范围 = 所有网络里名单里的人负责的卡
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: " u_a , u_b,u_a, " })).toEqual({ mode: "all", exclude: [], owners: ["u_a", "u_b"] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "1", COMMHUB_DUE_REMINDERS_OWNERS: "u_a" })).toEqual({ mode: "all", exclude: [], owners: ["u_a"] });
    // 与网络白名单 / 黑名单叠加(且)
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: "net_a", COMMHUB_DUE_REMINDERS_OWNERS: "u_a" })).toEqual({ mode: "only", include: ["net_a"], exclude: [], owners: ["u_a"] });
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS: "net_x", COMMHUB_DUE_REMINDERS_OWNERS: "u_a" })).toEqual({ mode: "all", exclude: ["net_x"], owners: ["u_a"] });
    // 空 / 空白 / 只有逗号 = 没设:=0 时仍然关;不设 =0 时与原来完全一样(没有 owners 键)
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: "" })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: " , ," })).toEqual({ mode: "off" });
    expect(await S({ COMMHUB_DUE_REMINDERS_OWNERS: "  " })).toStrictEqual({ mode: "all", exclude: [] });
    // SQL:没名单不 push;有名单精确匹配存储形状,占位号接在已有参数后面
    const p0: unknown[] = ["lo", "hi"];
    expect(due.dueOwnerSql({ mode: "all", exclude: [] }, p0)).toBe("");
    expect(due.dueOwnerSql({ mode: "off" }, p0)).toBe("");
    expect(p0).toEqual(["lo", "hi"]);
    const p1: unknown[] = ["lo", "hi", "net_x"];
    expect(due.dueOwnerSql({ mode: "all", exclude: ["net_x"], owners: ["u_a", "u_b"] }, p1)).toBe(" AND owner_json IN (?4, ?5)");
    expect(p1).toEqual(["lo", "hi", "net_x", JSON.stringify(userRef("u_a")), JSON.stringify(userRef("u_b"))]);
    // 日志
    expect(due.describeDueReminderScope({ mode: "all", exclude: [], owners: ["u_a"] })).toBe("all networks; only cards owned by u_a");
    expect(due.describeDueReminderScope({ mode: "only", include: ["net_a"], exclude: [], owners: ["u_a", "u_b"] })).toBe("only networks net_a; only cards owned by u_a,u_b");
  });

  test("#524 COMMHUB_DUE_REMINDERS=0 + 负责人名单:同一网络里只有名单里的人负责的卡发(人 + 负责 Agent);别人负责的一条不发", async () => {
    const listed = await card("dr-524-名单内负责人", "2026-10-11");
    const unlisted = await card("dr-524-名单外负责人", "2026-10-11", { owner: userRef(pia.id), participants: [userRef(pat.id)] });
    const noOwner = await card("dr-524-没有负责人", "2026-10-11", { owner: null, participants: [userRef(owen.id)] });
    const out = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: ` ${owen.id} ,` }, () => due.runDueReminders({ now: T0 }));
    // 名单里的人负责的卡:恰好一档,收件人 = 负责人 + 参与人,负责 Agent 也收到一条
    expect(sentFor(out, listed)).toEqual(["due_soon"]);
    expect(out.find((x) => x.requirement_id === listed)?.users.sort()).toEqual([owen.id, pat.id, pia.id].sort());
    expect(out.find((x) => x.requirement_id === listed)?.node).toBe(ALIAS);
    const n = userNotices(listed);
    expect(Object.keys(n).sort()).toEqual([owen.id, pat.id, pia.id].sort());
    for (const id of [owen.id, pat.id, pia.id]) expect(n[id].map((x) => x.reminder)).toEqual(["due_soon"]);
    expect(nodeMessages(listed)).toHaveLength(1);
    // 名单外的人负责的卡 / 没有负责人的卡:什么都不发,连去重行都不写(以后把人加进来,照样按时发)
    for (const id of [unlisted, noOwner]) {
      expect(sentFor(out, id)).toEqual([]);
      expect(userNotices(id)).toEqual({});
      expect(nodeMessages(id)).toEqual([]);
      expect(rowCount(id)).toBe(0);
    }
    // 返回值里也只有名单里的人负责的卡
    for (const x of out) {
      const row = db.get("SELECT owner_json FROM requirements WHERE requirement_id = ?1", x.requirement_id);
      expect(JSON.parse(row.owner_json)).toEqual(userRef(owen.id));
    }
    // 同一时刻再跑:不重发
    expect(sentFor(await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: owen.id }, () => due.runDueReminders({ now: T0 })), listed)).toEqual([]);
    // 与网络白名单是「且」:人在名单里、网络不在 → 不发
    const other = mkNet("own_and");
    const c = await card("dr-524-人对网络不对", "2026-10-11");
    const out2 = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_NETWORKS: other.net, COMMHUB_DUE_REMINDERS_OWNERS: owen.id }, () => due.runDueReminders({ now: T0 }));
    expect(sentFor(out2, c)).toEqual([]);
    expect(rowCount(c)).toBe(0);
    // 名单撤掉(=1、不设名单)→ 名单外负责人的卡照常发:证明上面是名单挡的,不是卡本身不该发
    expect(sentFor(await withEnv({ COMMHUB_DUE_REMINDERS: "1" }, () => due.runDueReminders({ now: T0 })), unlisted)).toEqual(["due_soon"]);
  });

  test("#524 负责人名单不补发:网络早就开着,人后加进名单 —— 他加进来之前就逾期的卡不发,之后才逾期的照发", async () => {
    const f = mkNet("own_late");
    // 网络基线很早(T0 - 30 天),人还不在任何名单里
    await withEnv({ COMMHUB_DUE_REMINDERS_NETWORKS: f.net }, () => due.runDueReminders({ now: T0 - 30 * DAY }));
    expect(baselineCount(f.net)).toBe(1);
    const old = await cardIn(f, "dr-524-进名单前逾期", "2026-10-07");
    const today = await cardIn(f, "dr-524-进名单当天到期", "2026-10-10");
    const env = { COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: f.id };
    const first = await withEnv(env, () => due.runDueReminders({ now: T0 }));
    // 网络基线比逾期早 —— 只看网络基线就会补发;负责人基线挡住
    expect(sentFor(first, old)).toEqual([]);
    expect(sentFor(first, today)).toEqual(["due_today"]);
    const ob = db.all("SELECT network_id, due_on, sent_at FROM requirement_due_reminders WHERE kind = 'baseline_owner' AND network_id = ?1", f.net);
    expect(ob).toEqual([{ network_id: f.net, due_on: f.id, sent_at: new Date(T0).toISOString() }]);
    const next = await withEnv(env, () => due.runDueReminders({ now: T0 + DAY }));
    expect(sentFor(next, old)).toEqual([]);
    expect(sentFor(next, today)).toEqual(["overdue"]);
    // 负责人基线不被保留期清掉
    await withEnv(env, () => due.runDueReminders({ now: T0 + 90 * DAY }));
    expect(db.get("SELECT COUNT(*) AS n FROM requirement_due_reminders WHERE kind = 'baseline_owner' AND network_id = ?1", f.net).n).toBe(1);
  });

  test("#524 启动:=0 + 负责人名单起定时器,日志只有 id", async () => {
    const logs: string[] = [];
    const g = globalThis as any;
    const orig = { log: console.log, setTimeout: g.setTimeout, setInterval: g.setInterval };
    let timers = 0;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    g.setTimeout = () => { timers++; return { unref() {} }; };
    g.setInterval = () => { timers++; return { fake: true }; };
    try {
      const on = await withEnv({ COMMHUB_DUE_REMINDERS: "0", COMMHUB_DUE_REMINDERS_OWNERS: "u_placeholder_a" }, () => due.startDueReminderTimer());
      expect(on).toEqual({ fake: true } as any);
      expect(timers).toBe(2);
    } finally { console.log = orig.log; g.setTimeout = orig.setTimeout; g.setInterval = orig.setInterval; }
    expect(logs.filter((l) => l.startsWith("[due-reminders] scope:"))).toEqual(["[due-reminders] scope: all networks; only cards owned by u_placeholder_a"]);
  });
});

describe("#494 列表筛选", () => {
  // 筛选用真时钟:due 按此刻算出来。
  const tz = "Asia/Shanghai";
  let today = "", ids: Record<string, string> = {};
  beforeAll(async () => {
    const now = Date.now();
    today = due.localDate(now, tz);
    ids.over = await card("df-逾期", due.addDays(today, -2));
    ids.overTime = await card("df-逾期时刻", new Date(now - 3600_000).toISOString());
    ids.today = await card("df-今天", today);
    ids.in3 = await card("df-三天后", due.addDays(today, 3));
    ids.in10 = await card("df-十天后", due.addDays(today, 10));
    ids.doneOver = await card("df-完成逾期", due.addDays(today, -2), { column: "done" });
    ids.none = await card("df-无due", "");
  });
  const names = (rows: any[]) => rows.map((r: any) => r.name).filter((n: string) => n.startsWith("df-")).sort();

  test("MCP overdue=true:只要没完成且过期的(日期型 + 时刻型)", async () => {
    const r = await mcp(owen.token, "requirements_list", { network_id: NET, overdue: true, limit: 200 });
    expect(r.ok).toBe(true);
    expect(names(r.requirements)).toEqual(["df-逾期", "df-逾期时刻"].sort());
  });
  test("MCP overdue=false:其余的", async () => {
    const r = await mcp(owen.token, "requirements_list", { network_id: NET, overdue: false, limit: 500 });
    expect(names(r.requirements)).toEqual(["df-三天后", "df-今天", "df-十天后", "df-完成逾期", "df-无due"].sort());
  });
  test("MCP due_within_days:0 = 今天;3 = 到三天后;不含逾期 / 完成 / 无 due", async () => {
    expect(names((await mcp(owen.token, "requirements_list", { network_id: NET, due_within_days: 0, limit: 200 })).requirements)).toEqual(["df-今天"]);
    expect(names((await mcp(owen.token, "requirements_list", { network_id: NET, due_within_days: 3, limit: 200 })).requirements)).toEqual(["df-三天后", "df-今天"].sort());
  });
  test("MCP 严格参数:负数 / 非整数 / 字符串被拒", async () => {
    for (const bad of [{ due_within_days: -1 }, { due_within_days: 1.5 }, { overdue: "yes" }]) {
      const r = await mcp(owen.token, "requirements_list", { network_id: NET, ...bad });
      expect(r.ok).not.toBe(true);
    }
  });
  test("REST 同一组参数;不合法 → 400 + field", async () => {
    const ok = await send(owen.token, "GET", `/api/requirements?network_id=${NET}&overdue=1`);
    expect(ok.status).toBe(200);
    expect(names(ok.body.requirements)).toEqual(["df-逾期", "df-逾期时刻"].sort());
    const w = await send(owen.token, "GET", `/api/requirements?network_id=${NET}&due_within_days=10`);
    expect(names(w.body.requirements)).toEqual(["df-三天后", "df-今天", "df-十天后"].sort());
    const bad = await send(owen.token, "GET", `/api/requirements?network_id=${NET}&overdue=maybe`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_overdue");
    expect(bad.body.field).toBe("overdue");
    const bad2 = await send(owen.token, "GET", `/api/requirements?network_id=${NET}&due_within_days=999`);
    expect(bad2.status).toBe(400);
    expect(bad2.body.error).toBe("invalid_due_within_days");
  });
});
