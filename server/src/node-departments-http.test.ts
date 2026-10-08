// #751:Agent(节点)归部门 —— PUT /api/networks/:id/nodes/:node_id/department + GET …/departments 的 nodes[]。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PG 阶梯里用同一个文件跑真 PostgreSQL)。
//
// 夹具(全是占位名):研发(负责人 headA)── 前端;运维(负责人 headB,和研发无关);成员 member 在前端。
// 节点:n1、n2、n3(owner 建),nodeTok 是 n1 自己的节点令牌。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-node-depts-"));
let BASE = "";
let hub: any = null;
const PW = "NodeDeptsPassw0rd!xyz";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
const D: Record<string, string> = {};
let NODE_TOKEN = "";
const N = { n1: "node_nd_1", n2: "node_nd_2", n3: "node_nd_3" };

async function raw(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function send(token: string, method: string, path: string, body?: unknown) {
  const r = await raw(token, method, path, body);
  let json: any = null;
  try { json = JSON.parse(r.text); } catch {}
  return { status: r.status, body: json };
}
const place = (who: string, node: string, department_id: string | null) =>
  send(who === "node" ? NODE_TOKEN : U[who].token, "PUT", `/api/networks/${NET}/nodes/${node}/department`, { department_id });
const listing = async (who = "owner") => (await send(U[who].token, "GET", `/api/networks/${NET}/departments`)).body;
const deptOf = async (node: string) => ((await listing()).nodes ?? []).find((n: any) => n.node_id === node)?.department_id ?? null;
const denied = (r: { status: number; body: any }) => { expect(r.status).toBe(403); expect(r.body.error).toBe("department_scope_denied"); };

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`nd_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const stamp = Date.now();
  for (const k of ["headA", "headB", "member", "restricted"]) {
    const username = `nd_${k}_${stamp}`;
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    U[k] = { token: login.body.token, id: login.body.user.user_id };
  }
  const mkDept = async (k: string, name: string, parent: string | null, leader: string | null) => {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name, parent_id: parent, leader_user_id: leader ? U[leader].id : null });
    expect(r.status).toBe(201);
    D[k] = r.body.department.id;
  };
  await mkDept("rd", "研发", null, "headA");
  await mkDept("fe", "前端", D.rd, null);
  await mkDept("ops", "运维", null, "headB");
  expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: D.fe })).status).toBe(200);
  for (const [alias, id] of [["示例节点一", N.n1], ["示例节点二", N.n2], ["示例节点三", N.n3]]) {
    const t = createNetworkTokenForNode(U.owner.id, NET, alias, id);
    expect(t.error ?? null).toBe(null);
    if (id === N.n1) NODE_TOKEN = t.token!;
  }
  db.run("UPDATE nodes SET display_name = ?1 WHERE node_id = ?2", ["节点一号", N.n1]);
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#751 compatibility: no node memberships → responses unchanged", () => {
  let before = { owner: "", member: "" };
  test("listing keys are exactly the pre-#751 set; no nodes key", async () => {
    before = { owner: (await raw(U.owner.token, "GET", `/api/networks/${NET}/departments`)).text, member: (await raw(U.member.token, "GET", `/api/networks/${NET}/departments`)).text };
    expect(Object.keys(JSON.parse(before.owner))).toEqual(["ok", "network_id", "departments", "members", "project_grants"]);
    expect(Object.keys(JSON.parse(before.member))).toEqual(["ok", "network_id", "departments", "members"]);
    // 人的部分逐字节:按旧代码的键顺序重新序列化,和线上的字节一样。
    const o = JSON.parse(before.owner);
    expect(JSON.stringify({ ok: o.ok, network_id: o.network_id, departments: o.departments, members: o.members, project_grants: o.project_grants })).toBe(before.owner);
    expect(o.members.every((m: any) => Object.keys(m).join() === "user_id,department_id")).toBe(true);
  });
  test("place then clear a node → listing bytes identical to before (owner and member views)", async () => {
    expect((await place("owner", N.n3, D.ops)).status).toBe(200);
    expect((await listing()).nodes.length).toBe(1);
    expect((await place("owner", N.n3, null)).status).toBe(200);
    expect((await raw(U.owner.token, "GET", `/api/networks/${NET}/departments`)).text).toBe(before.owner);
    expect((await raw(U.member.token, "GET", `/api/networks/${NET}/departments`)).text).toBe(before.member);
  });
});

describe("#751 set / move / clear", () => {
  test("owner sets: listing has nodes[] with kind, alias, display name; members[] and member_count untouched", async () => {
    const r = await place("owner", N.n1, D.fe);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, node_id: N.n1, department_id: D.fe });
    const l = await listing();
    expect(l.nodes).toEqual([{ kind: "node", node_id: N.n1, alias: "示例节点一", display_name: "节点一号", department_id: D.fe }]);
    expect(l.members.some((m: any) => m.user_id === N.n1)).toBe(false);
    expect(l.departments.find((d: any) => d.id === D.fe).member_count).toBe(1);
    // 节点令牌看得到;默认「只看授权 Agent」的成员看不到没授权给他的节点(整个键不出现)。
    expect((await listing("member")).nodes).toBeUndefined();
    expect((await send(NODE_TOKEN, "GET", `/api/networks/${NET}/departments`)).body.nodes.length).toBe(1);
  });
  test("head of target (and of current) moves fe → rd; then clears", async () => {
    expect((await place("headA", N.n1, D.rd)).status).toBe(200);
    expect(await deptOf(N.n1)).toBe(D.rd);
    expect((await place("headA", N.n1, null)).status).toBe(200);
    expect(await deptOf(N.n1)).toBe(null);
  });
  test("head of target places an unassigned node", async () => {
    expect((await place("headB", N.n2, D.ops)).status).toBe(200);
    expect(await deptOf(N.n2)).toBe(D.ops);
  });
  test("owner moves across trees and clears", async () => {
    expect((await place("owner", N.n2, D.fe)).status).toBe(200);
    expect(await deptOf(N.n2)).toBe(D.fe);
    expect((await place("owner", N.n2, "")).status).toBe(200);
    expect(await deptOf(N.n2)).toBe(null);
  });
  test("validation: unknown department 400, unknown node 404, wrong method 405", async () => {
    const bad = await place("owner", N.n1, "no_such_dept");
    expect(bad.status).toBe(400); expect(bad.body.error).toBe("department_not_found");
    const missing = await place("owner", "node_nope", D.fe);
    expect(missing.status).toBe(404); expect(missing.body.error).toBe("node_not_found");
    expect((await send(U.owner.token, "POST", `/api/networks/${NET}/nodes/${N.n1}/department`, { department_id: D.fe })).status).toBe(405);
  });
});

describe("#751 who may change it", () => {
  test("head of an unrelated department: denied into a foreign dept, denied moving a node out of a foreign dept, denied clearing it", async () => {
    denied(await place("headB", N.n1, D.rd));
    expect((await place("owner", N.n1, D.fe)).status).toBe(200);
    denied(await place("headB", N.n1, D.ops));
    denied(await place("headB", N.n1, null));
    expect(await deptOf(N.n1)).toBe(D.fe);
  });
  test("head of the target only cannot pull a node out of someone else's dept", async () => {
    expect((await place("owner", N.n2, D.ops)).status).toBe(200);
    denied(await place("headA", N.n2, D.rd));
    expect(await deptOf(N.n2)).toBe(D.ops);
  });
  test("plain member denied", async () => {
    denied(await place("member", N.n1, D.rd));
    denied(await place("member", N.n3, D.fe));
  });
  test("node token denied (even for itself)", async () => {
    denied(await place("node", N.n1, D.rd));
    denied(await place("node", N.n1, null));
    expect(await deptOf(N.n1)).toBe(D.fe);
  });
  test("agent-restricted member sees only granted nodes in nodes[]", async () => {
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.restricted.id}/agent-grants`, { agent_access: "granted", grants: [{ node_id: N.n2 }] })).status).toBe(200);
    expect(((await listing("restricted")).nodes ?? []).map((n: any) => n.node_id)).toEqual([N.n2]);
  });
});

describe("#751 department delete clears its nodes", () => {
  test("deleting a department with only nodes in it succeeds and the nodes become unassigned (even if the id is reused)", async () => {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name: "临时组", id: "dept_nd_tmp" });
    expect(r.status).toBe(201);
    expect((await place("owner", N.n3, "dept_nd_tmp")).status).toBe(200);
    expect(await deptOf(N.n3)).toBe("dept_nd_tmp");
    const del = await send(U.owner.token, "DELETE", `/api/networks/${NET}/departments/dept_nd_tmp`);
    expect(del.status).toBe(200);
    expect(await deptOf(N.n3)).toBe(null);
    // 同一个 id 重新建:旧的归属不能复活。
    expect((await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name: "临时组", id: "dept_nd_tmp" })).status).toBe(201);
    expect(await deptOf(N.n3)).toBe(null);
  });
});
