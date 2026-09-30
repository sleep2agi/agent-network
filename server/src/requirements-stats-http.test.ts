// 完成时间 completed_at 与仪表盘聚合 GET /api/requirements/stats —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 场景:Hub 管理员 admin 的网络 NET;节点令牌 bot(绑定一个节点);成员:
//   alice —— 新建成员(经授权接口显式设成任务 scoped、Agent 受限):只看得见自己负责的卡;
//   carol —— 任务 'all'、Agent 受限('granted' 且没授权 bot):卡全看得见,但 bot 不该以名字出现在统计里。
// 正向:移进完成记时刻与操作者、完成列里改别的不动、移出清空、再移进换新时刻;直接建在完成列;归档的卡照样计数;
//       tz / days / from / to 的语义。
// 反向:scoped 成员的统计不含他看不见的卡;受限成员看不到隐藏节点的 id(计入 unattributed);非法参数 400。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { isAgentRestricted } from "./agent-access.js";
import { localDate } from "./requirements-stats.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-stats-"));
const PW = "ReqStatsPassw0rd!x";
let BASE = "";
let hub: any = null;
let NET = "";
let admin = { token: "", id: "" };
let alice = { token: "", id: "" };
let carol = { token: "", id: "" };
let bot = { token: "", nodeId: "" };
let PROJ = "";
const C: Record<string, string> = {};

type R = { status: number; body: any; text: string };
async function send(token: string, method: string, path: string, payload?: unknown): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}
const card = async (token: string, name: string, extra: Record<string, unknown> = {}) => {
  const r = await send(token, "POST", "/api/requirements", { network_id: NET, name, ...extra });
  expect(r.status).toBe(201);
  C[name] = r.body.requirement.id;
  return r.body.requirement;
};
const patch = async (token: string, name: string, body: Record<string, unknown>) => {
  const r = await send(token, "PATCH", `/api/requirements/${C[name]}?network_id=${NET}`, body);
  expect(r.status).toBe(200);
  return r.body.requirement;
};
const stats = (token: string, qs = "") => send(token, "GET", `/api/requirements/stats?network_id=${NET}${qs}`);
const tick = () => new Promise(r => setTimeout(r, 5));

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`rs_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const mk = async (username: string) => {
    const r = await send(admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  alice = await mk(`rs_alice_${stamp}`);
  carol = await mk(`rs_carol_${stamp}`);
  // 新成员默认值 NEW_MEMBER_TASK_ACCESS 暂时是 'all',alice 要显式设成 scoped。
  expect((await send(admin.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { task_access: "scoped" })).status).toBe(200);
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, carol.id]);

  const t = createNetworkTokenForNode(admin.id, NET, "rs-bot");
  expect(t.token).toBeTruthy();
  bot.token = t.token!;

  const p = await send(admin.token, "POST", "/api/requirements/projects", { network_id: NET, name: "rs-P" });
  expect(p.status).toBe(201);
  PROJ = p.body.project.id;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("completed_at 随列变化", () => {
  test("不在完成列的卡:completedAt = null,approx = false;capability 广播 completed_at / stats", async () => {
    const r = await card(admin.token, "rs-pool");
    expect(r.completedAt).toBeNull();
    expect(r.completedBy).toBeNull();
    expect(r.completedAtApprox).toBe(false);
    await card(admin.token, "rs-doing", { column: "doing" });
    const list = await send(admin.token, "GET", `/api/requirements?network_id=${NET}`);
    expect(list.body.capabilities).toContain("completed_at");
    expect(list.body.capabilities).toContain("stats");
  });

  test("直接建在完成列:completedAt = createdAt,completedBy = 建卡的人", async () => {
    const r = await card(admin.token, "rs-born-done", { column: "done", project_id: PROJ });
    expect(r.completedAt).toBe(r.createdAt);
    expect(r.completedBy).toEqual({ kind: "user", id: admin.id });
    expect(r.completedAtApprox).toBe(false);
  });

  test("移进完成记时刻;完成列里改名 / 勾子任务不动它;移出清空;再移进是新时刻", async () => {
    await card(admin.token, "rs-move", { checklist: [{ id: "i1", text: "x", done: false }] });
    expect((await patch(admin.token, "rs-move", { column: "doing" })).completedAt).toBeNull();
    const done1 = await patch(admin.token, "rs-move", { column: "done" });
    expect(done1.completedAt).toBe(done1.updatedAt);
    expect(done1.completedBy).toEqual({ kind: "user", id: admin.id });
    await tick();
    const renamed = await patch(admin.token, "rs-move", { name: "rs-move 改名" });
    expect(renamed.updatedAt).not.toBe(done1.updatedAt);
    expect(renamed.completedAt).toBe(done1.completedAt);
    const again = await patch(admin.token, "rs-move", { column: "done" }); // done → done
    expect(again.completedAt).toBe(done1.completedAt);
    const ck = await send(admin.token, "PATCH", `/api/requirements/${C["rs-move"]}/checklist/i1?network_id=${NET}`, { done: true });
    expect(ck.status).toBe(200);
    expect(ck.body.requirement.completedAt).toBe(done1.completedAt);
    const out = await patch(admin.token, "rs-move", { column: "pool" });
    expect(out.completedAt).toBeNull();
    expect(out.completedBy).toBeNull();
    await tick();
    const done2 = await patch(admin.token, "rs-move", { column: "done" });
    expect(done2.completedAt).not.toBeNull();
    expect(Date.parse(done2.completedAt)).toBeGreaterThan(Date.parse(done1.completedAt));
  });

  test("节点令牌移进完成:completedBy 是那个节点", async () => {
    await card(bot.token, "rs-bot-card");
    const done = await patch(bot.token, "rs-bot-card", { column: "done" });
    expect(done.completedBy?.kind).toBe("node");
    bot.nodeId = done.completedBy.id;
    expect(bot.nodeId).toBeTruthy();
  });

  test("alice 负责的卡由 alice 移进完成;归档一张完成的卡", async () => {
    await card(admin.token, "rs-alice", { owner: { kind: "user", id: alice.id } });
    const done = await patch(alice.token, "rs-alice", { column: "done" });
    expect(done.completedBy).toEqual({ kind: "user", id: alice.id });
    await card(admin.token, "rs-archived", { column: "done" });
    const arch = await patch(admin.token, "rs-archived", { archived: true });
    expect(arch.archived).toBe(true);
    expect(arch.completedAt).not.toBeNull(); // 归档不是移出完成列
  });
});

describe("GET /api/requirements/stats", () => {
  // 此时:done = born-done / move / bot-card / alice / archived(5);doing = rs-doing;pool = rs-pool;共 7 张。
  test("管理员:总数、归档的完成卡照样计数、按项目 / 完成者、每日曲线", async () => {
    const r = await stats(admin.token, "&tz=UTC");
    expect(r.status).toBe(200);
    const s = r.body;
    expect(s.totals.done).toBe(5);
    expect(s.totals.done_approx).toBe(0);
    expect(s.totals.doing).toBe(1);
    expect(s.totals.pool).toBe(1);
    expect(s.totals.created).toBe(7);
    expect(s.totals.created_done).toBe(5);
    expect(s.totals.completion_rate).toBeCloseTo(5 / 7, 6);
    // 列表默认不含归档的卡,统计含:这正是「完成的卡被归档后今天完成数偏少」的那一张。
    const list = await send(admin.token, "GET", `/api/requirements?network_id=${NET}`);
    expect((list.body.requirements as any[]).some(x => x.id === C["rs-archived"])).toBe(false);
    expect(s.by_project).toEqual([{ project_id: null, n: 4 }, { project_id: PROJ, n: 1 }]);
    const by = Object.fromEntries((s.by_completer as any[]).map(c => [`${c.kind}:${c.id}`, c]));
    expect(by[`user:${admin.id}`].n).toBe(3);
    expect(by[`user:${alice.id}`].n).toBe(1);
    expect(by[`node:${bot.nodeId}`].n).toBe(1);
    expect(by[`user:${admin.id}`].spark.length).toBe(14);
    expect(s.unattributed).toBe(0);
    expect(s.daily.length).toBe(30);
    expect(s.daily.reduce((a: number, d: any) => a + d.n, 0)).toBe(5);
    expect(s.daily.at(-1).date).toBe(localDate(Date.parse(s.range.to), "UTC"));
  });

  test("recent:最近完成的卡(新 → 旧),带短号 / 标题 / 完成者;recent=0 空;非法 400", async () => {
    const r = await stats(admin.token, "&recent=3");
    expect(r.status).toBe(200);
    const rec = r.body.recent as any[];
    expect(rec.map(x => x.name)).toEqual(["rs-archived", "rs-alice", "rs-bot-card"]);
    expect(rec[0].archived).toBe(true);
    expect(rec[1].completed_by).toEqual({ kind: "user", id: alice.id });
    expect(rec[2].completed_by?.kind).toBe("node");
    expect(typeof rec[0].seq).toBe("number");
    for (let i = 1; i < rec.length; i++) expect(rec[i - 1].completed_at >= rec[i].completed_at).toBe(true);
    expect((await stats(admin.token)).body.recent.length).toBe(5); // 缺省 10,只有 5 张完成
    expect((await stats(admin.token, "&recent=0")).body.recent).toEqual([]);
    for (const bad of ["-1", "51", "x"]) expect((await stats(admin.token, `&recent=${bad}`)).body.error).toBe("invalid_recent");
  });

  test("scoped 成员:统计只含他看得见的卡(反向:别人的卡、项目、完成者都不出现)", async () => {
    const r = await stats(alice.token);
    expect(r.status).toBe(200);
    expect(r.body.totals.done).toBe(1);
    expect(r.body.totals.doing).toBe(0);
    expect(r.body.totals.pool).toBe(0);
    expect(r.body.totals.created).toBe(1);
    expect(r.body.by_project).toEqual([{ project_id: null, n: 1 }]);
    expect(r.body.by_completer).toEqual([expect.objectContaining({ kind: "user", id: alice.id, n: 1 })]);
    expect(r.text).not.toContain(admin.id);
    expect((r.body.recent as any[]).map(x => x.name)).toEqual(["rs-alice"]);
    expect(r.text).not.toContain(PROJ);
    expect(r.text).not.toContain(bot.nodeId);
  });

  test("Agent 受限成员:隐藏节点完成的卡照样计数,但记在 unattributed,节点 id 不出现", async () => {
    expect(isAgentRestricted(carol.id, NET)).toBe(true); // 前置:carol 确实受限,否则下面的断言恒真
    const r = await stats(carol.token);
    expect(r.status).toBe(200);
    expect(r.body.totals.done).toBe(5);
    expect(r.body.unattributed).toBe(1);
    expect((r.body.by_completer as any[]).some(c => c.kind === "node")).toBe(false);
    expect(r.text).not.toContain(bot.nodeId);
    expect((r.body.recent as any[]).find(x => x.name === "rs-bot-card").completed_by).toBeNull();
    // 卡片详情也藏掉 completedBy(与 updated_by 同一规则)
    const one = await send(carol.token, "GET", `/api/requirements/${C["rs-bot-card"]}?network_id=${NET}`);
    expect(one.status).toBe(200);
    expect(one.body.requirement.completedBy).toBeNull();
  });

  test("节点令牌可以读统计", async () => {
    const r = await stats(bot.token);
    expect(r.status).toBe(200);
    expect(r.body.totals.done).toBe(5);
  });

  test("from / to:范围外的完成不计入总数;daily 按自己的窗口", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const r1 = await stats(admin.token, `&from=${encodeURIComponent(future)}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`);
    expect(r1.status).toBe(200);
    expect(r1.body.totals.done).toBe(0);
    expect(r1.body.totals.created).toBe(0);
    expect(r1.body.totals.completion_rate).toBeNull();
    expect(r1.body.totals.doing).toBe(1); // 「进行中」是当前状态,不看范围
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const r2 = await stats(admin.token, `&to=${encodeURIComponent(past)}`);
    expect(r2.body.totals.done).toBe(0);
    expect(r2.body.daily.reduce((a: number, d: any) => a + d.n, 0)).toBe(0);
  });

  test("tz:最后一天按调用方时区;UTC+14 与 UTC-12 相差一天", async () => {
    const east = await stats(admin.token, "&tz=Pacific/Kiritimati&days=1");
    const west = await stats(admin.token, "&tz=Etc/GMT%2B12&days=1");
    expect(east.status).toBe(200);
    expect(west.status).toBe(200);
    const to = Date.parse(east.body.range.to);
    expect(east.body.daily.at(-1).date).toBe(localDate(to, "Pacific/Kiritimati"));
    expect(west.body.daily.at(-1).date).toBe(localDate(Date.parse(west.body.range.to), "Etc/GMT+12"));
    expect(east.body.daily.at(-1).date > west.body.daily.at(-1).date).toBe(true);
    // 今天刚完成的 5 张都落在「今天」这一格(两边各自的今天)
    expect(east.body.daily.at(-1).n).toBe(5);
    expect(west.body.daily.at(-1).n).toBe(5);
  });

  test("days=371 画一整年;非法参数 400", async () => {
    const year = await stats(admin.token, "&days=371");
    expect(year.body.daily.length).toBe(371);
    for (const [qs, err] of [
      ["&tz=Mars/Base", "invalid_tz"], ["&days=0", "invalid_days"], ["&days=372", "invalid_days"], ["&days=1.5", "invalid_days"],
      ["&from=garbage", "invalid_from"], ["&to=nope", "invalid_to"],
      [`&from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`, "invalid_range"],
    ] as const) {
      const r = await stats(admin.token, qs);
      expect([qs, r.status, r.body?.error]).toEqual([qs, 400, err]);
    }
  });

  test("不带令牌 401;不是 /:id(「stats」不会被当成卡号)", async () => {
    const anon = await send("", "GET", `/api/requirements/stats?network_id=${NET}`);
    expect(anon.status).toBe(401);
    const r = await stats(admin.token);
    expect(r.body.ok).toBe(true);
    expect(r.body.requirement).toBeUndefined();
  });
});
