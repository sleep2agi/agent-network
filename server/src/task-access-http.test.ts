// 任务(需求卡)的人员权限(RFC-038 §9)—— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 场景:Hub 管理员 admin 的网络 NET。成员:
//   alice —— 新建成员,经授权接口显式设成 scoped,授权 P1(只看)、P2(可改);
//            (#746 起新成员默认值 NEW_MEMBER_TASK_ACCESS 就是 'scoped',见「默认值与授权接口」)
//   carol —— 升级前的老成员(task_access='all'):行为必须与今天逐字相同;
//   vic   —— 经授权接口显式设成 scoped 的 viewer,授权 P3(只看)。
// admin 建的卡:c_own(负责人 alice)、c_part(参与人 alice)、c_p1 / c_p2 / c_p3(在项目里)、c_other(与 alice 无关)。
// 正向:相关卡与授权项目看得见;负责 / 自建 / can_edit 能改;老成员与 owner 照旧;MCP 与 REST 一致。
// 反向:看不见的卡在 GET / PATCH / DELETE / 勾子任务 / #N 上与不存在的卡逐字节相同;只读卡 403;
//       往没授权的项目建卡、挂到看不见的父卡、撞别人的 client_id、external_ref / upsert、项目管理都被挡。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { issueUserToken, register } from "./auth.js";
import { db } from "./db.js";
import { NEW_MEMBER_TASK_ACCESS } from "./task-access.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-task-access-"));
let BASE = "";
let hub: any = null;
const PW = "TaskAccessPassw0rd!x";
let NET = "";
let admin = { token: "", id: "" };
let alice = { token: "", id: "" };
let carol = { token: "", id: "" };
let vic = { token: "", id: "" };
const P: Record<string, string> = {};
const C: Record<string, { id: string; seq: number }> = {};

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
const get = (t: string, p: string) => send(t, "GET", p);
const listIds = async (t: string, qs = "") => {
  const r = await get(t, `/api/requirements?network_id=${NET}${qs}`);
  expect(r.status).toBe(200);
  return (r.body.requirements as any[]).map(x => x.name).filter((n: string) => n.startsWith("ta-")).sort();
};
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}
const userRef = (id: string) => ({ kind: "user", id });

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`ta_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const mk = async (username: string, role: string) => {
    const r = await send(admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  alice = await mk(`ta_alice_${stamp}`, "member");
  carol = await mk(`ta_carol_${stamp}`, "member");
  vic = await mk(`ta_vic_${stamp}`, "viewer");
  // carol = 升级前就在网络里的成员(ALTER 默认 'all')。
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, carol.id]);

  for (const name of ["ta-P1", "ta-P2", "ta-P3", "ta-P4"]) {
    const r = await send(admin.token, "POST", "/api/requirements/projects", { network_id: NET, name });
    expect(r.status).toBe(201);
    P[name] = r.body.project.id;
  }
  const card = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await send(admin.token, "POST", "/api/requirements", { network_id: NET, name, ...extra });
    expect(r.status).toBe(201);
    C[name] = { id: r.body.requirement.id, seq: r.body.requirement.seq };
  };
  await card("ta-own", { owner: userRef(alice.id), checklist: [{ id: "i1", text: "x", done: false }] });
  await card("ta-part", { participants: [userRef(alice.id)], checklist: [{ id: "i1", text: "x", done: false }] });
  await card("ta-p1", { project_id: P["ta-P1"] });
  await card("ta-p2", { project_id: P["ta-P2"] });
  await card("ta-p3", { project_id: P["ta-P3"] });
  await card("ta-other", { tags: ["secret-tag"], client_id: "admin-client-1" });

  const g = await send(admin.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { task_access: "scoped", project_grants: [{ project_id: P["ta-P1"] }, { project_id: P["ta-P2"], can_edit: true }] });
  expect(g.status).toBe(200);
  const gv = await send(admin.token, "PUT", `/api/networks/${NET}/members/${vic.id}/task-grants`, { task_access: "scoped", project_grants: [P["ta-P3"]] });
  expect(gv.status).toBe(200);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("默认值与授权接口", () => {
  test("#746 新成员默认 scoped:管理员建号 / POST members / 邀请码加入都落在 scoped —— 只看自己的卡与授权项目;admin 角色照旧 all", async () => {
    expect(NEW_MEMBER_TASK_ACCESS).toBe("scoped");
    const stamp = Date.now();
    const names = async (t: string) => {
      const r = await get(t, `/api/requirements?network_id=${NET}`);
      expect(r.status).toBe(200);
      return (r.body.requirements as any[]).map(x => x.name).filter((n: string) => n.startsWith("ta-") || n.startsWith("dm-")).sort();
    };
    // 管理员建号
    const u1 = { username: `ta_new1_${stamp}`, password: PW, network_id: NET, role: "member" };
    expect((await send(admin.token, "POST", "/api/admin/users", u1)).status).toBe(200);
    const l1 = await send("", "POST", "/api/auth/login", { username: u1.username, password: PW });
    // POST /members 不带 task_access
    const u2 = register(`ta_new2_${stamp}`, PW);
    expect((await send(admin.token, "POST", `/api/networks/${NET}/members`, { user_id: u2.user!.user_id, role: "member" })).status).toBe(200);
    // 邀请码加入(member 与 viewer 两种邀请)
    const inv = await send(admin.token, "POST", `/api/networks/${NET}/invite`, { role: "member" });
    const u3 = register(`ta_new3_${stamp}`, PW);
    expect((await send(u3.token!, "POST", "/api/networks/join", { invite_code: inv.body.invite_code })).status).toBe(200);
    const paths: Array<[string, string, string]> = [["admin-users", l1.body.user.user_id, l1.body.token], ["post-members", u2.user!.user_id, u2.token!], ["invite", u3.user!.user_id, u3.token!]];
    for (const [path, id, token] of paths) {
      const g = await get(admin.token, `/api/networks/${NET}/members/${id}/task-grants`);
      expect([path, g.body.task_access, g.body.restricted]).toEqual([path, "scoped", true]);
      const me = await get(token, "/api/auth/me");
      expect(me.body.networks.find((n: any) => n.network_id === NET).task_access).toBe("scoped");
      // 自己负责的卡 + 授权项目 P1 看得见;别人的无关卡(ta-other)列表里没有、直取也是 404
      expect((await send(admin.token, "POST", "/api/requirements", { network_id: NET, name: `dm-own-${path}`, owner: userRef(id) })).status).toBe(201);
      expect((await send(admin.token, "PUT", `/api/networks/${NET}/members/${id}/task-grants`, { project_grants: [P["ta-P1"]] })).status).toBe(200);
      expect([path, await names(token)]).toEqual([path, [`dm-own-${path}`, "ta-p1"]]);
      expect((await get(token, `/api/requirements/${C["ta-other"].id}?network_id=${NET}`)).status).toBe(404);
    }
    // 管理员仍能经现有接口把成员放宽到 all,之后看见全部卡
    expect((await send(admin.token, "PUT", `/api/networks/${NET}/members/${u2.user!.user_id}/task-grants`, { task_access: "all" })).status).toBe(200);
    expect((await names(u2.token!))).toContain("ta-other");
    // admin 角色(POST members / 邀请码)照旧存 'all';不受这一列约束
    const a1 = register(`ta_new5_${stamp}`, PW);
    expect((await send(admin.token, "POST", `/api/networks/${NET}/members`, { user_id: a1.user!.user_id, role: "admin" })).status).toBe(200);
    const invA = await send(admin.token, "POST", `/api/networks/${NET}/invite`, { role: "admin" });
    const a2 = register(`ta_new6_${stamp}`, PW);
    expect((await send(a2.token!, "POST", "/api/networks/join", { invite_code: invA.body.invite_code })).status).toBe(200);
    for (const a of [a1, a2]) {
      const g = await get(admin.token, `/api/networks/${NET}/members/${a.user!.user_id}/task-grants`);
      expect([g.body.task_access, g.body.restricted]).toEqual(["all", false]);
      expect(await names(a.token!)).toContain("ta-other");
    }
    // 升级前的老成员(carol,直接写 'all' 的行)照旧全看见
    expect(await names(carol.token)).toContain("ta-other");
    // POST /members 显式传 all 仍然生效
    const u4 = register(`ta_new4_${stamp}`, PW);
    expect((await send(admin.token, "POST", `/api/networks/${NET}/members`, { user_id: u4.user!.user_id, role: "member", task_access: "all" })).status).toBe(200);
    expect((await get(admin.token, `/api/networks/${NET}/members/${u4.user!.user_id}/task-grants`)).body.task_access).toBe("all");
    for (const id of [l1.body.user.user_id, u2.user!.user_id, u3.user!.user_id, u4.user!.user_id, a1.user!.user_id, a2.user!.user_id]) {
      expect((await send(admin.token, "DELETE", `/api/networks/${NET}/members/${id}`)).status).toBe(200);
    }
  });

  test("经授权接口显式设成 scoped 的成员:task_access / restricted / 授权与改默认值之前逐字相同;升级前的行是 'all'", async () => {
    const r = await get(admin.token, `/api/networks/${NET}/members/${alice.id}/task-grants`);
    expect(r.body.task_access).toBe("scoped");
    expect(r.body.restricted).toBe(true);
    expect(r.body.project_grants).toEqual([{ project_id: P["ta-P1"], can_edit: false }, { project_id: P["ta-P2"], can_edit: true }].sort((x, y) => x.project_id.localeCompare(y.project_id)));
    expect((await get(admin.token, `/api/networks/${NET}/members/${carol.id}/task-grants`)).body.task_access).toBe("all");
  });

  test("/members 与 /auth/me 带上 task_access;owner 恒 all", async () => {
    const m = await get(admin.token, `/api/networks/${NET}/members`);
    const row = (id: string) => m.body.members.find((x: any) => x.user_id === id);
    expect(row(alice.id).task_access).toBe("scoped");
    expect(row(alice.id).task_project_count).toBe(2);
    expect(row(carol.id).task_access).toBe("all");
    expect(row(admin.id).task_access).toBe("all");
    const me = await get(alice.token, "/api/auth/me");
    expect(me.body.networks.find((n: any) => n.network_id === NET).task_access).toBe("scoped");
  });

  test("授权接口:外网 / 不存在的项目 400 且整批不写;不传的字段保持原样;普通成员与节点令牌 403;审计", async () => {
    const bad = await send(admin.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { project_grants: [P["ta-P4"], "proj_does_not_exist"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("project_not_in_network");
    expect((await get(admin.token, `/api/networks/${NET}/members/${alice.id}/task-grants`)).body.project_grants.length).toBe(2);
    const keep = await send(admin.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { task_access: "scoped" });
    expect(keep.body.project_grants.length).toBe(2);
    expect((await send(alice.token, "GET", `/api/networks/${NET}/members/${alice.id}/task-grants`)).status).toBe(403);
    expect((await send(carol.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { task_access: "all" })).status).toBe(403);
    const nt = await send(admin.token, "POST", "/api/auth/node-token", { network_id: NET, node_name: "ta-node", node_id: "node_ta_1" });
    expect((await get(nt.body.token, `/api/networks/${NET}/members/${alice.id}/task-grants`)).status).toBe(403);
    expect(db.get("SELECT 1 FROM audit_log WHERE action = 'member_task_grants_changed' AND network_id = ?1", NET)).toBeTruthy();
  });
});

describe("可见性", () => {
  test("alice 只看见:负责 / 参与 / 授权项目的卡;不看见无关的与没授权项目的", async () => {
    expect(await listIds(alice.token)).toEqual(["ta-own", "ta-p1", "ta-p2", "ta-part"]);
  });
  test("viewer_can:scoped 调用者每张卡带上能不能改 / 删;老成员与 owner 不带", async () => {
    const r = await get(alice.token, `/api/requirements?network_id=${NET}`);
    const by = (n: string) => (r.body.requirements as any[]).find(x => x.name === n)?.viewer_can;
    expect(by("ta-own")).toEqual({ edit: true, delete: true });
    // 参与人:整卡只读,但状态和检查项能改(edit_fields;旧 App 不认这个键,照旧画只读)。
    expect(by("ta-part")).toEqual({ edit: false, delete: false, edit_fields: ["column", "checklist"] });
    expect(by("ta-p1")).toEqual({ edit: false, delete: false });
    expect(by("ta-p2")).toEqual({ edit: true, delete: false });
    expect((await get(vic.token, `/api/requirements/${C["ta-p3"].id}?network_id=${NET}`)).body.requirement.viewer_can).toEqual({ edit: false, delete: false });
    const carolList = await get(carol.token, `/api/requirements?network_id=${NET}`);
    expect((carolList.body.requirements as any[]).every(x => x.viewer_can === undefined)).toBe(true);
    expect((await get(admin.token, `/api/requirements/${C["ta-own"].id}`)).body.requirement.viewer_can).toBeUndefined();
  });
  test("viewer vic 只看见授权项目 P3 的卡", async () => {
    expect(await listIds(vic.token)).toEqual(["ta-p3"]);
  });
  test("老成员 carol 与 owner 照旧看全部", async () => {
    const all = ["ta-other", "ta-own", "ta-p1", "ta-p2", "ta-p3", "ta-part"];
    expect(await listIds(carol.token)).toEqual(all);
    expect(await listIds(admin.token)).toEqual(all);
  });
  test("搜索也按可见性过滤", async () => {
    expect(await listIds(alice.token, "&q=ta-other")).toEqual([]);
    expect(await listIds(carol.token, "&q=ta-other")).toEqual(["ta-other"]);
  });
  test("看不见的卡:GET / #N 与不存在的卡逐字节相同", async () => {
    const hidden = await get(alice.token, `/api/requirements/${C["ta-other"].id}?network_id=${NET}`);
    const ghost = await get(alice.token, `/api/requirements/req_does_not_exist?network_id=${NET}`);
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(ghost.text);
    const bySeq = await get(alice.token, `/api/requirements/%23${C["ta-other"].seq}?network_id=${NET}`);
    const noSeq = await get(alice.token, `/api/requirements/%2399999?network_id=${NET}`);
    expect(bySeq.status).toBe(404);
    expect(bySeq.text).toBe(noSeq.text);
    expect((await get(carol.token, `/api/requirements/${C["ta-other"].id}?network_id=${NET}`)).status).toBe(200);
  });
  test("标签只从看得见的卡汇总", async () => {
    expect((await get(alice.token, `/api/requirements/tags?network_id=${NET}`)).body.tags).not.toContain("secret-tag");
    expect((await get(carol.token, `/api/requirements/tags?network_id=${NET}`)).body.tags).toContain("secret-tag");
  });
  test("项目列表:alice 只看授权的 P1 / P2", async () => {
    const r = await get(alice.token, `/api/requirements/projects?network_id=${NET}`);
    expect(r.body.projects.map((p: any) => p.name).sort()).toEqual(["ta-P1", "ta-P2"]);
    expect((await get(carol.token, `/api/requirements/projects?network_id=${NET}`)).body.projects.length).toBe(4);
  });
});

describe("写入", () => {
  test("能改:负责的、可改项目里的;只读:只看项目里的(403 task_read_only);参与的只能改状态 / 检查项;看不见的与不存在的同一个 404", async () => {
    expect((await send(alice.token, "PATCH", `/api/requirements/${C["ta-own"].id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    expect((await send(alice.token, "PATCH", `/api/requirements/${C["ta-p2"].id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    const p1 = await send(alice.token, "PATCH", `/api/requirements/${C["ta-p1"].id}?network_id=${NET}`, { column: "doing" });
    expect(p1.status).toBe(403);
    expect(p1.body).toEqual({ ok: false, error: "task_read_only" });
    const part = await send(alice.token, "PATCH", `/api/requirements/${C["ta-part"].id}?network_id=${NET}`, { name: "renamed" });
    expect(part.status).toBe(403);
    expect(part.body.error).toBe("task_read_only");
    expect(part.body.field).toBe("name");
    const hidden = await send(alice.token, "PATCH", `/api/requirements/${C["ta-other"].id}?network_id=${NET}`, { column: "doing" });
    const ghost = await send(alice.token, "PATCH", `/api/requirements/req_does_not_exist?network_id=${NET}`, { column: "doing" });
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(ghost.text);
  });

  test("勾子任务:负责的能勾,参与的能勾,只看项目的 403,看不见的 404", async () => {
    expect((await send(alice.token, "PATCH", `/api/requirements/${C["ta-own"].id}/checklist/i1?network_id=${NET}`, { done: true })).status).toBe(200);
    expect((await send(alice.token, "PATCH", `/api/requirements/${C["ta-part"].id}/checklist/i1?network_id=${NET}`, { done: true })).status).toBe(200);
    const ro = await send(alice.token, "PATCH", `/api/requirements/${C["ta-p1"].id}/checklist/i1?network_id=${NET}`, { done: true });
    expect(ro.status).toBe(403);
    expect(ro.body.error).toBe("task_read_only");
    expect((await send(alice.token, "PATCH", `/api/requirements/${C["ta-other"].id}/checklist/i1?network_id=${NET}`, { done: true })).status).toBe(404);
  });

  test("挪项目:只能挪进 can_edit 的项目;没授权的与不存在的同一个错误", async () => {
    const r = await send(alice.token, "PATCH", `/api/requirements/${C["ta-own"].id}?network_id=${NET}`, { project_id: P["ta-P1"] });
    const ghost = await send(alice.token, "PATCH", `/api/requirements/${C["ta-own"].id}?network_id=${NET}`, { project_id: "proj_nope" });
    expect(r.status).toBe(400);
    expect(r.text).toBe(ghost.text);
  });

  test("新建:能建;自建的卡看得见也能改;建进只看项目 / 看不见的父卡 / 别人的 client_id / external_ref 都被挡", async () => {
    const mine = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-alice-own" });
    expect(mine.status).toBe(201);
    expect(await listIds(alice.token)).toContain("ta-alice-own");
    expect((await send(alice.token, "PATCH", `/api/requirements/${mine.body.requirement.id}?network_id=${NET}`, { priority: "high" })).status).toBe(200);
    expect((await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-into-p2", project_id: P["ta-P2"] })).status).toBe(201);
    const intoP1 = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-into-p1", project_id: P["ta-P1"] });
    const intoNone = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-into-none", project_id: "proj_nope" });
    expect(intoP1.status).toBe(400);
    expect(intoP1.text).toBe(intoNone.text);
    const hiddenParent = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-child", parent_id: C["ta-other"].id });
    const ghostParent = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-child", parent_id: "req_does_not_exist" });
    expect(hiddenParent.status).toBe(400);
    expect(hiddenParent.text).toBe(ghostParent.text);
    const replay = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-replay", client_id: "admin-client-1" });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("client_id_taken");
    expect(replay.text).not.toContain("ta-other");
    const ext = await send(alice.token, "POST", "/api/requirements", { network_id: NET, name: "ta-ext", external_ref: "github:o/r#1" });
    expect(ext.status).toBe(403);
    expect(ext.body.error).toBe("external_ref_not_allowed");
  });

  test("upsert 与项目管理:scoped 成员 403(固定错误,不看参数)", async () => {
    const up = await send(alice.token, "POST", "/api/requirements/upsert", { network_id: NET, name: "x", external_ref: "github:o/r#2" });
    expect(up.status).toBe(403);
    expect(up.body.error).toBe("upsert_not_allowed");
    expect((await send(alice.token, "POST", `/api/requirements/projects?network_id=${NET}`, { name: "ta-alice-proj" })).status).toBe(403);
    expect((await send(alice.token, "PATCH", `/api/requirements/projects/${P["ta-P2"]}?network_id=${NET}`, { name: "renamed" })).status).toBe(403);
  });

  test("删除:只能删负责 / 自建的;可改项目里的也不能删(403 task_delete_denied);删卡写审计", async () => {
    const p2 = await send(alice.token, "DELETE", `/api/requirements/${C["ta-p2"].id}?network_id=${NET}`);
    expect(p2.status).toBe(403);
    expect(p2.body.error).toBe("task_delete_denied");
    const hidden = await send(alice.token, "DELETE", `/api/requirements/${C["ta-other"].id}?network_id=${NET}`);
    const ghost = await send(alice.token, "DELETE", `/api/requirements/req_does_not_exist?network_id=${NET}`);
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(ghost.text);
    expect((await send(alice.token, "DELETE", `/api/requirements/${C["ta-own"].id}?network_id=${NET}`)).status).toBe(200);
    const audit = db.get<{ detail: string; network_id: string }>("SELECT detail, network_id FROM audit_log WHERE action = 'requirement_deleted' AND target_id = ?1", C["ta-own"].id);
    expect(audit?.network_id).toBe(NET);
    expect(audit?.detail).toContain("ta-own");
  });

  test("被拒的写入审计限频:同一 (用户, 卡) 连续两次只记一条", async () => {
    await send(alice.token, "PATCH", `/api/requirements/${C["ta-p1"].id}?network_id=${NET}`, { name: "a" });
    await send(alice.token, "PATCH", `/api/requirements/${C["ta-p1"].id}?network_id=${NET}`, { name: "b" });
    const n = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'task_access_denied' AND user_id = ?1 AND target_id = ?2", alice.id, C["ta-p1"].id)?.c;
    expect(n).toBe(1);
  });

  test("viewer 什么都不能写(沿用 permission_denied)", async () => {
    expect((await send(vic.token, "PATCH", `/api/requirements/${C["ta-p3"].id}?network_id=${NET}`, { column: "doing" })).status).toBe(403);
  });

  test("老成员 carol 照旧:能改、能删别人的卡、能管项目、能 upsert", async () => {
    expect((await send(carol.token, "PATCH", `/api/requirements/${C["ta-other"].id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    expect((await send(carol.token, "POST", `/api/requirements/projects?network_id=${NET}`, { name: "ta-carol-proj" })).status).toBe(201);
    expect((await send(carol.token, "POST", "/api/requirements/upsert", { network_id: NET, name: "ta-carol-up", external_ref: "github:o/r#3" })).status).toBe(201);
    expect((await send(carol.token, "DELETE", `/api/requirements/${C["ta-p3"].id}?network_id=${NET}`)).status).toBe(200);
  });
});

describe("MCP 与 REST 一致", () => {
  test("requirements_list / requirements_get 对 alice 同样过滤", async () => {
    const list = await mcp(alice.token, "requirements_list", { network_id: NET });
    const names = (list.requirements as any[]).map(x => x.name).filter((n: string) => n.startsWith("ta-")).sort();
    expect(names).toEqual(await listIds(alice.token));
    const hidden = await mcp(alice.token, "requirements_get", { id: C["ta-other"].id, network_id: NET });
    expect(hidden.ok).toBe(false);
    expect(hidden.error).toBe("requirement_not_found");
  });
});

describe("LIKE 通配符不越权(参与人 / 负责人 id 里有 % 或 _)", () => {
  // 可见性子句用 LIKE … ESCAPE 匹配 `"kind":"user","id":"<uid>"`;id 里的 % / _ 必须按字面匹配。
  // 造两个用户:pct 的 id 带 % 与 _,twin 的 id 在「不转义」时恰好能被 pct 的模式匹配上。
  const PCT = "u_ta%pct_1";
  const TWIN = "u_taXpctA1";
  let pctToken = "";
  beforeAll(async () => {
    for (const [id, name] of [[PCT, "ta_pct"], [TWIN, "ta_twin"]] as const) {
      db.run("INSERT INTO users (user_id, username, password_hash, display_name, role) VALUES (?1, ?2, 'x', ?2, 'user')", [id, `${name}_${Date.now()}`]);
      db.run("INSERT INTO network_members (network_id, user_id, role, agent_access, task_access) VALUES (?1, ?2, 'member', 'granted', 'scoped')", [NET, id]);
    }
    pctToken = issueUserToken(PCT).token;
    for (const [name, ref] of [["ta-twin-owned", TWIN], ["ta-pct-owned", PCT]] as const) {
      const r = await send(admin.token, "POST", "/api/requirements", { network_id: NET, name, owner: userRef(ref), participants: [userRef(ref)] });
      expect(r.status).toBe(201);
      C[name] = { id: r.body.requirement.id, seq: r.body.requirement.seq };
    }
  });
  test("id 带 % / _ 的成员只看见自己的卡,看不见被通配符「撞上」的那张", async () => {
    const mine = await listIds(pctToken);
    expect(mine).toContain("ta-pct-owned");
    expect(mine).not.toContain("ta-twin-owned");
    expect((await get(pctToken, `/api/requirements/${C["ta-twin-owned"].id}?network_id=${NET}`)).status).toBe(404);
  });
});

describe("清理", () => {
  test("删项目清掉项目授权;移出成员清掉他的全部授权", async () => {
    expect((await send(admin.token, "DELETE", `/api/requirements/projects/${P["ta-P1"]}?network_id=${NET}`)).status).toBe(200);
    expect(db.get("SELECT 1 FROM network_member_project_grants WHERE project_id = ?1", P["ta-P1"])).toBeFalsy();
    expect((await send(admin.token, "DELETE", `/api/networks/${NET}/members/${vic.id}`)).status).toBe(200);
    expect(db.get("SELECT 1 FROM network_member_project_grants WHERE user_id = ?1", vic.id)).toBeFalsy();
  });
});
