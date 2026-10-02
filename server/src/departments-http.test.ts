// 组织架构(board #419):GET/POST/PATCH/DELETE /api/networks/:id/departments、PUT …/members/:uid/department。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。钉住:谁能读 / 谁能写、部门规则(同级不重名、不成环、最多 10 层、
// 只删空部门、负责人必须是成员)、成员所在部门,以及只增不改(/humans、/members 只多一个 department_id)。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-departments-"));
let BASE = "";
let hub: any = null;
const PW = "DepartmentsPassw0rd!x";
let NET = "", OTHER_NET = "";
const U: Record<string, { token: string; id: string }> = {};

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const D = () => `/api/networks/${NET}/departments`;
const list = async (who = "owner") => (await send(U[who].token, "GET", D())).body;
const mk = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = await send(U.owner.token, "POST", D(), { name, ...extra });
  expect(r.status).toBe(201);
  return r.body.department as { id: string; name: string; parent_id: string | null };
};

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`dep_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(a.ok).toBe(true);
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const add = async (username: string, role: string) => {
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  U.admin = await add(`dep_admin_${stamp}`, "admin");
  U.member = await add(`dep_member_${stamp}`, "member");
  U.viewer = await add(`dep_viewer_${stamp}`, "viewer");
  U.node = { token: createNetworkTokenForNode(U.owner.id, NET, "dep-node", "node_dep").token!, id: "node_dep" };
  const o = register(`dep_outsider_${stamp}`, PW);
  U.outsider = { token: o.token!, id: o.user!.user_id };
  OTHER_NET = o.network_id!;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("who can read / write", () => {
  test("every member, a node token of this network and a hub admin can read; outsiders and other networks' nodes can't", async () => {
    for (const who of ["owner", "admin", "member", "viewer", "node"]) expect((await send(U[who].token, "GET", D())).status).toBe(200);
    expect((await send(U.outsider.token, "GET", D())).status).toBe(403);
    expect((await send("", "GET", D())).status).toBe(401);
    const otherNode = createNetworkTokenForNode(U.outsider.id, OTHER_NET, "dep-other", "node_dep_other").token!;
    expect((await send(otherNode, "GET", D())).status).toBe(403);
  });

  test("only network owner / admin (and hub admin) can write", async () => {
    expect((await send(U.admin.token, "POST", D(), { name: "管理员建的" })).status).toBe(201);
    for (const who of ["member", "viewer", "node", "outsider"]) {
      expect((await send(U[who].token, "POST", D(), { name: `不该建-${who}` })).status).toBe(403);
    }
    const anyDept = (await list()).departments[0].id;
    expect((await send(U.member.token, "PATCH", `${D()}/${anyDept}`, { name: "x" })).status).toBe(403);
    expect((await send(U.member.token, "DELETE", `${D()}/${anyDept}`)).status).toBe(403);
    expect((await send(U.member.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: anyDept })).status).toBe(403);
  });
});

describe("departments", () => {
  test("create: top level and child, auto id and custom id, sibling names unique, validation", async () => {
    const top = await mk("军团基建");
    expect(top.id).toMatch(/^dept_/);
    expect(top.parent_id).toBeNull();
    const child = await mk("前端组", { parent_id: top.id, id: "fe-team" });
    expect(child.id).toBe("fe-team");
    expect(child.parent_id).toBe(top.id);
    expect((await send(U.owner.token, "POST", D(), { name: "前端组", parent_id: top.id })).status).toBe(409);
    expect((await send(U.owner.token, "POST", D(), { name: "前端组" })).status).toBe(201); // same name under another parent is fine
    expect((await send(U.owner.token, "POST", D(), { name: "另一个", id: "fe-team" })).body.error).toBe("department_id_taken");
    expect((await send(U.owner.token, "POST", D(), { name: "  " })).body.error).toBe("invalid_department_name");
    expect((await send(U.owner.token, "POST", D(), { name: "x".repeat(41) })).body.error).toBe("invalid_department_name");
    expect((await send(U.owner.token, "POST", D(), { name: "坏 id", id: "has space" })).body.error).toBe("invalid_department_id");
    expect((await send(U.owner.token, "POST", D(), { name: "孤儿", parent_id: "nope" })).body.error).toBe("parent_not_found");
    expect((await send(U.owner.token, "POST", D(), { name: "外人负责", leader_user_id: U.outsider.id })).body.error).toBe("leader_not_member");
  });

  test("rename, move (no cycles, depth ≤ 10), set / clear leader, sort", async () => {
    const a = await mk("移动甲");
    const b = await mk("移动乙", { parent_id: a.id });
    const c = await mk("移动丙", { parent_id: b.id });
    expect((await send(U.owner.token, "PATCH", `${D()}/${a.id}`, { parent_id: c.id })).body.error).toBe("department_cycle");
    expect((await send(U.owner.token, "PATCH", `${D()}/${a.id}`, { parent_id: a.id })).body.error).toBe("department_cycle");
    const moved = await send(U.owner.token, "PATCH", `${D()}/${c.id}`, { parent_id: null, name: "移动丙(顶层)" });
    expect(moved.status).toBe(200);
    expect(moved.body.department.parent_id).toBeNull();
    expect(moved.body.department.name).toBe("移动丙(顶层)");
    const led = await send(U.owner.token, "PATCH", `${D()}/${b.id}`, { leader_user_id: U.member.id, sort: 5 });
    expect(led.body.department.leader_user_id).toBe(U.member.id);
    expect(led.body.department.sort).toBe(5);
    expect((await send(U.owner.token, "PATCH", `${D()}/${b.id}`, { leader_user_id: null })).body.department.leader_user_id).toBeNull();
    expect((await send(U.owner.token, "PATCH", `${D()}/${b.id}`, {})).body.error).toBe("empty_patch");
    expect((await send(U.owner.token, "PATCH", `${D()}/missing`, { name: "x" })).status).toBe(404);
    // depth: a chain of 10 is fine, the 11th level is refused (create and move)
    let parent: string | null = null;
    const chain: string[] = [];
    for (let i = 0; i < 10; i++) { const d = await mk(`层${i}`, parent ? { parent_id: parent } : {}); chain.push(d.id); parent = d.id; }
    expect((await send(U.owner.token, "POST", D(), { name: "第11层", parent_id: parent })).body.error).toBe("department_too_deep");
    const two = await mk("两层");
    await mk("两层的子", { parent_id: two.id });
    expect((await send(U.owner.token, "PATCH", `${D()}/${two.id}`, { parent_id: chain[8] })).body.error).toBe("department_too_deep");
  });

  test("members: put into a department, counts, unassign; /members (admin list) carries department_id, /humans unchanged", async () => {
    const team = await mk("成员测试部");
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: team.id })).body.department_id).toBe(team.id);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.viewer.id}/department`, { department_id: team.id })).status).toBe(200);
    const l = await list("member");
    expect(l.departments.find((d: any) => d.id === team.id).member_count).toBe(2);
    expect(l.members.find((m: any) => m.user_id === U.member.id).department_id).toBe(team.id);
    expect(l.members.find((m: any) => m.user_id === U.owner.id).department_id).toBeNull();
    // /humans stays identity-only (its key set is pinned by member-presence / agent-acl tests): who sits where comes
    // from GET …/departments (members[]), which every member can read.
    const humans = await send(U.viewer.token, "GET", `/api/networks/${NET}/humans`);
    expect(humans.body.humans.find((h: any) => h.user_id === U.member.id).department_id).toBeUndefined();
    const members = await send(U.owner.token, "GET", `/api/networks/${NET}/members`);
    const row = members.body.members.find((m: any) => m.user_id === U.member.id);
    expect(row.department_id).toBe(team.id);
    for (const k of ["user_id", "role", "username", "agent_access", "task_access"]) expect(row).toHaveProperty(k); // old fields unchanged
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.outsider.id}/department`, { department_id: team.id })).status).toBe(404);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: "nope" })).body.error).toBe("department_not_found");
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.viewer.id}/department`, { department_id: null })).body.department_id).toBeNull();
  });

  test("delete only when empty (no sub-departments, no members), with the counts", async () => {
    const parent = await mk("删除测试部");
    const kid = await mk("删除测试子部", { parent_id: parent.id });
    await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.admin.id}/department`, { department_id: parent.id });
    const blocked = await send(U.owner.token, "DELETE", `${D()}/${parent.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "department_not_empty", children: 1, members: 1 });
    expect((await send(U.owner.token, "DELETE", `${D()}/${kid.id}`)).status).toBe(200);
    await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.admin.id}/department`, { department_id: null });
    expect((await send(U.owner.token, "DELETE", `${D()}/${parent.id}`)).status).toBe(200);
    expect((await list()).departments.some((d: any) => d.id === parent.id)).toBe(false);
    expect((await send(U.owner.token, "DELETE", `${D()}/${parent.id}`)).status).toBe(404);
  });

  test("a leader who leaves the network reads as no leader", async () => {
    const stamp = Date.now();
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username: `dep_leaver_${stamp}`, password: PW, network_id: NET, role: "member" })).status).toBe(200);
    const leaver = (await send("", "POST", "/api/auth/login", { username: `dep_leaver_${stamp}`, password: PW })).body.user.user_id as string;
    const d = await mk("负责人会走", { leader_user_id: leaver });
    expect(d).toBeTruthy();
    expect((await send(U.owner.token, "DELETE", `/api/networks/${NET}/members/${leaver}`)).status).toBe(200);
    expect((await list()).departments.find((x: any) => x.id === d.id).leader_user_id).toBeNull();
  });

  test("deleting a network removes its departments", async () => {
    const r = register(`dep_gone_${Date.now()}`, PW);
    const net = r.network_id!;
    expect((await send(r.token!, "POST", `/api/networks/${net}/departments`, { name: "会被删" })).status).toBe(201);
    expect(db.get("SELECT 1 AS x FROM network_departments WHERE network_id = ?1", net)).toBeTruthy();
    expect((await send(r.token!, "DELETE", `/api/networks/${net}`)).status).toBe(200);
    expect(db.get("SELECT 1 AS x FROM network_departments WHERE network_id = ?1", net)).toBeFalsy();
  });
});
