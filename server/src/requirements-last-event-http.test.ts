// #506 —— GET /api/requirements 每行带 last_event:这张卡最新的一条动态(requirement_events,评论也算)。
// HTTP 集成测试(真实 Bun.serve,临时库;PG 梯子上用 COMMHUB_TEST_PG_URL 原样再跑一遍)。钉住:
//   - 形状:{ type, field, actor: { id, kind, display_name } | null, at, summary? };没有流水的卡 = null(字段总在);
//   - 评论(不改卡的任何一列)成为 last_event,summary 是正文摘要;
//   - 节点(节点令牌)改状态 → actor.kind = "node",display_name = 节点名,summary「pool → doing」;
//   - ETag:没变时 304,加一条评论之后同一个 If-None-Match 不再命中(列表缓存也作废);
//   - 可见范围同行:受限成员看不见的节点 actor = null;scoped 成员看不见的卡根本不在列表里;
//   - view=summary(MCP requirements_list 默认)同样带 last_event。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-last-event-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "LastEventPassw0rd!x";
let BASE = "";
let hub: any = null;
let NET = "";
let db: any = null;
let admin = { token: "", id: "" };
let member = { token: "", id: "" };
let scoped = { token: "", id: "" };
let restricted = { token: "", id: "" };
let nodeToken = "";
let NODE = "";

type R = { status: number; body: any; etag: string | null };
async function send(token: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, etag: res.headers.get("etag") };
}
const create = async (t: string, card: Record<string, unknown>) => {
  const r = await send(t, "POST", "/api/requirements", { network_id: NET, ...card });
  expect(r.status).toBe(201);
  return r.body.requirement as { id: string; seq: number };
};
const list = (t: string, qs = "", headers: Record<string, string> = {}) => send(t, "GET", `/api/requirements?network_id=${NET}${qs}`, undefined, headers);
const rowOf = (r: R, id: string) => (r.body.requirements as any[]).find(x => x.id === id);
const comment = (t: string, id: string, text: string) => send(t, "POST", `/api/requirements/${id}/comments?network_id=${NET}`, { text });

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  db = (await import("./db.js")).db;
  const a = register(`le_admin_${Date.now()}`, PW, undefined, "示例管理员");
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
  member = await mk(`le_member_${stamp}`);
  scoped = await mk(`le_scoped_${stamp}`);
  restricted = await mk(`le_restricted_${stamp}`);
  db.run("UPDATE users SET display_name = ?1 WHERE user_id = ?2", ["示例成员", member.id]);
  db.run("UPDATE network_members SET task_access = 'all', agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
  db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, scoped.id]);
  // 看全部任务,但一个 Agent 都没授权:所有节点对他隐去
  db.run("UPDATE network_members SET task_access = 'all', agent_access = 'granted' WHERE network_id = ?1 AND user_id = ?2", [NET, restricted.id]);
  NODE = `n_le_${stamp}`;
  db.run("INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?2, ?3, ?4)", [NODE, "le-node", "le-node", NET]);
  const ntok = createNetworkTokenForNode(admin.id, NET, "le-node");
  expect(ntok.ok).toBe(true);
  nodeToken = ntok.token!;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#506 GET /api/requirements last_event", () => {
  test("capability `last_event` is advertised; a fresh card's last_event is its `created` event", async () => {
    const card = await create(member.token, { name: "最新动态示例一" });
    const r = await list(admin.token);
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toContain("last_event");
    const row = rowOf(r, card.id);
    expect(row.last_event).toEqual({ type: "created", field: null, actor: { id: member.id, kind: "user", display_name: "示例成员" }, at: row.last_event.at });
    expect(Date.parse(row.last_event.at)).toBeGreaterThan(0);
  });

  test("rows with no events → last_event null (field present)", async () => {
    const card = await create(admin.token, { name: "没有流水的旧卡" });
    // 动态上线前建的卡 / 过了 180 天保留期的卡:流水里没有它
    db.run("DELETE FROM requirement_events WHERE requirement_id = ?1", [card.id]);
    const row = rowOf(await list(admin.token), card.id);
    expect("last_event" in row).toBe(true);
    expect(row.last_event).toBeNull();
  });

  test("a comment becomes last_event (type comment, summary = text), though it changes no column", async () => {
    const card = await create(admin.token, { name: "评论示例" });
    const before = rowOf(await list(admin.token), card.id);
    expect((await comment(member.token, card.id, "第一条进展:\n已经复现,  正在修。")).status).toBe(201);
    const row = rowOf(await list(admin.token), card.id);
    expect(row.updatedAt).toBe(before.updatedAt); // 评论不改卡
    expect(row.last_event).toMatchObject({ type: "comment", field: null, actor: { id: member.id, kind: "user", display_name: "示例成员" }, summary: "第一条进展: 已经复现, 正在修。" });
    // 很长的评论:摘要截断到 120 字
    await comment(admin.token, card.id, "长".repeat(500));
    const long = rowOf(await list(admin.token), card.id).last_event;
    expect(long.actor).toEqual({ id: admin.id, kind: "user", display_name: "示例管理员" });
    expect(long.summary.length).toBe(120);
    expect(long.summary.endsWith("…")).toBe(true);
  });

  test("a status change by a node shows kind=node with the node's name and `pool → doing`", async () => {
    const card = await create(admin.token, { name: "节点改状态示例" });
    const p = await send(nodeToken, "PATCH", `/api/requirements/${card.id}?network_id=${NET}`, { column: "doing" });
    expect(p.status).toBe(200);
    const row = rowOf(await list(admin.token), card.id);
    expect(row.last_event).toMatchObject({ type: "changed", field: "column", actor: { id: NODE, kind: "node", display_name: "le-node" }, summary: "pool → doing" });
    // 节点自己读列表(MCP requirements_list 走同一条路,默认 view=summary)也带着
    const viaNode = rowOf(await list(nodeToken, "&view=summary"), card.id);
    expect(viaNode.last_event).toEqual(row.last_event);
  });

  test("ETag: 304 while nothing changed; adding a comment changes the ETag (cache invalidated)", async () => {
    const card = await create(admin.token, { name: "ETag 示例" });
    const first = await list(admin.token);
    expect(first.etag).toBeTruthy();
    const again = await list(admin.token, "", { "If-None-Match": first.etag! });
    expect(again.status).toBe(304);
    expect((await comment(admin.token, card.id, "加一条评论")).status).toBe(201);
    const after = await list(admin.token, "", { "If-None-Match": first.etag! });
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(first.etag);
    expect(rowOf(after, card.id).last_event).toMatchObject({ type: "comment", summary: "加一条评论" });
    // summary 视图的缓存键不同,同样作废
    const s1 = await list(admin.token, "&view=summary");
    await comment(admin.token, card.id, "再加一条");
    const s2 = await list(admin.token, "&view=summary", { "If-None-Match": s1.etag! });
    expect(s2.status).toBe(200);
    expect(rowOf(s2, card.id).last_event.summary).toBe("再加一条");
  });

  test("visibility: a restricted member sees the node actor masked; a scoped member does not get the row at all", async () => {
    const card = await create(admin.token, { name: "可见范围示例" });
    expect((await send(nodeToken, "PATCH", `/api/requirements/${card.id}?network_id=${NET}`, { priority: "high" })).status).toBe(200);
    const seen = rowOf(await list(restricted.token), card.id);
    expect(seen.last_event).toMatchObject({ type: "changed", field: "priority", actor: null, summary: "normal → high" });
    expect(JSON.stringify(seen.last_event)).not.toContain(NODE);
    expect(JSON.stringify(seen.last_event)).not.toContain("le-node");
    // 只看相关任务的成员:这张卡与他无关 → 不在列表里,last_event 也就无从谈起
    const s = await list(scoped.token);
    expect(s.status).toBe(200);
    expect(rowOf(s, card.id)).toBeUndefined();
    expect(JSON.stringify(s.body)).not.toContain(NODE);
  });

  test("restricted member: an agent_owner change between hidden nodes degrades to a bare `changed` (no field / summary)", async () => {
    const other = `n_le_other_${Date.now()}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?2, ?3, ?4)", [other, "le-other", "le-other", NET]);
    const card = await create(admin.token, { name: "隐去示例", agent_owner: { kind: "node", id: NODE } });
    expect((await send(admin.token, "PATCH", `/api/requirements/${card.id}?network_id=${NET}`, { agent_owner: { kind: "node", id: other } })).status).toBe(200);
    expect(rowOf(await list(admin.token), card.id).last_event).toMatchObject({ type: "changed", field: "agent_owner", actor: { id: admin.id, kind: "user" } });
    const seen = rowOf(await list(restricted.token), card.id).last_event;
    expect(seen).toEqual({ type: "changed", field: null, actor: { id: admin.id, kind: "user", display_name: "示例管理员" }, at: seen.at });
  });

  test("one page of many cards: every row gets its own latest event", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await create(admin.token, { name: `批量 ${i}` })).id);
    for (let i = 0; i < ids.length; i += 2) await comment(member.token, ids[i], `评论 ${i}`);
    const r = await list(admin.token, "&limit=50");
    for (let i = 0; i < ids.length; i++) {
      const ev = rowOf(r, ids[i]).last_event;
      if (i % 2 === 0) expect(ev).toMatchObject({ type: "comment", summary: `评论 ${i}` });
      else expect(ev).toMatchObject({ type: "created", actor: { id: admin.id } });
    }
  });
});
