// RFC-042(看板 #457)部门群,第一个 PR:建群 / 查群 / 权限 / 删部门解除关联。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PostgreSQL 由 test2123 梯子用 COMMHUB_TEST_PG_URL 跑同一个文件)。
// 钉住:谁能建(owner / admin / Hub 管理员 / 部门(含上级)负责人)、谁能看(群成员 + 管理者,别人 404)、
// Agent(节点令牌)一律 403、建群时的成员 = 部门子树成员 ∪ 子树负责人、一个部门一个群、删部门只解除关联。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-dept-groups-"));
let BASE = "";
let hub: any = null;
const PW = "DeptGroupsPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
const DEPT: Record<string, string> = {};

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const D = (suffix = "") => `/api/networks/${NET}/departments${suffix}`;
const G = (deptKey: string) => D(`/${DEPT[deptKey]}/group`);
const CG = (suffix = "") => `/api/networks/${NET}/chat-groups${suffix}`;
const ids = (members: Array<{ user_id: string }>) => members.map((m) => m.user_id).sort();

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`dg_owner_${Date.now()}`, PW, undefined, "Owner");
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
  U.admin = await add(`dg_admin_${stamp}`, "admin");
  U.head = await add(`dg_head_${stamp}`, "member");     // 研发部负责人
  U.alice = await add(`dg_alice_${stamp}`, "member");   // 研发部成员
  U.bob = await add(`dg_bob_${stamp}`, "member");       // 后端组成员 + 后端组负责人
  U.carol = await add(`dg_carol_${stamp}`, "member");   // 未分配
  U.viewer = await add(`dg_viewer_${stamp}`, "viewer"); // 研发部成员,只读
  U.node = { token: createNetworkTokenForNode(U.owner.id, NET, "dg-node", "node_dg").token!, id: "node_dg" };
  const o = register(`dg_outsider_${stamp}`, PW);
  U.outsider = { token: o.token!, id: o.user!.user_id };

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await send(U.owner.token, "POST", D(), { name, ...extra });
    expect(r.status).toBe(201);
    return r.body.department.id as string;
  };
  DEPT.rd = await mk("研发部", { leader_user_id: U.head.id });
  DEPT.backend = await mk("后端组", { parent_id: DEPT.rd, leader_user_id: U.bob.id });
  DEPT.market = await mk("市场部");
  const place = async (who: string, dept: string | null) =>
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[who].id}/department`, { department_id: dept })).status).toBe(200);
  await place("head", DEPT.rd);
  await place("alice", DEPT.rd);
  await place("viewer", DEPT.rd);
  await place("bob", DEPT.backend);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("who can create a department group", () => {
  test("members, viewers, outsiders, nodes and unauthenticated callers cannot", async () => {
    expect((await send(U.carol.token, "POST", G("rd"), {})).body.error).toBe("owner/admin required");
    expect((await send(U.carol.token, "POST", G("rd"), {})).status).toBe(403);
    expect((await send(U.alice.token, "POST", G("rd"), {})).status).toBe(403);
    expect((await send(U.viewer.token, "POST", G("rd"), {})).status).toBe(403);
    expect((await send(U.outsider.token, "POST", G("rd"), {})).status).toBe(403);
    const node = await send(U.node.token, "POST", G("rd"), {});
    expect(node.status).toBe(403);
    expect(node.body.error).toBe("humans_only");
    expect((await send("", "POST", G("rd"), {})).status).toBe(401);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_groups WHERE network_id = ?1", NET)?.n ?? 0)).toBe(0);
  });

  test("a head cannot create one outside their subtree (sub-department head → parent or sibling)", async () => {
    for (const key of ["rd", "market"]) {
      const r = await send(U.bob.token, "POST", G(key), {});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("department_scope_denied");
    }
  });

  test("owner creates the 研发部 group: name defaults to the department, members = subtree members ∪ subtree heads", async () => {
    const r = await send(U.owner.token, "POST", G("rd"));
    expect(r.status).toBe(201);
    expect(r.body.group.name).toBe("研发部");
    expect(r.body.group.department_id).toBe(DEPT.rd);
    expect(r.body.group.id).toMatch(/^grp_[0-9a-f]{20}$/);
    // 研发部:head / alice / viewer;后端组(下级):bob。未分配的 carol、不在部门里的 owner / admin 不进。
    expect(ids(r.body.members)).toEqual([U.alice.id, U.bob.id, U.head.id, U.viewer.id].sort());
    expect(r.body.group.member_count).toBe(4);
    for (const m of r.body.members) expect(m.source).toBe("department");
  });

  test("one group per department: a second create → 409 with the existing group_id", async () => {
    const existing = (await send(U.owner.token, "GET", G("rd"))).body.group.id;
    for (const who of ["owner", "admin", "head"]) {
      const r = await send(U[who].token, "POST", G("rd"), { name: "又一个" });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("department_group_exists");
      expect(r.body.group_id).toBe(existing);
    }
  });

  test("a head can create one for a department in their subtree, with a custom name", async () => {
    const r = await send(U.head.token, "POST", G("backend"), { name: "  后端小群  " });
    expect(r.status).toBe(201);
    expect(r.body.group.name).toBe("后端小群");
    // 后端组只有 bob(他同时是负责人);研发部负责人在上级部门,不在这个子树里。
    expect(ids(r.body.members)).toEqual([U.bob.id]);
    const audit = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE network_id = ?1 AND action = 'department_group_created' ORDER BY id DESC LIMIT 1", NET);
    expect(JSON.parse(audit!.detail)).toMatchObject({ id: DEPT.backend, via: "leader" });
  });

  test("admin can create; bad names and unknown departments are rejected", async () => {
    expect((await send(U.admin.token, "POST", G("market"), { name: 42 })).body.error).toBe("invalid_group_name");
    expect((await send(U.admin.token, "POST", G("market"), { name: "x".repeat(41) })).status).toBe(400);
    expect((await send(U.admin.token, "POST", G("market"), { name: "   " })).status).toBe(400);
    expect((await send(U.admin.token, "POST", D("/dept_nope/group"), {})).status).toBe(404);
    const r = await send(U.admin.token, "POST", G("market"), { name: "市场部群" });
    expect(r.status).toBe(201);
    expect(r.body.members).toEqual([]);
  });
});

describe("who can read", () => {
  test("GET …/departments/:id/group: group members and managers see it; others get 404; nodes 403", async () => {
    for (const who of ["owner", "admin", "head", "alice", "bob", "viewer"]) {
      const r = await send(U[who].token, "GET", G("rd"));
      expect(r.status).toBe(200);
      expect(ids(r.body.members)).toHaveLength(4);
    }
    const carol = await send(U.carol.token, "GET", G("rd"));
    expect(carol.status).toBe(404);
    expect(carol.body.error).toBe("department_group_not_found");
    expect((await send(U.node.token, "GET", G("rd"))).status).toBe(403);
    expect((await send(U.outsider.token, "GET", G("rd"))).status).toBe(403);
  });

  test("GET …/chat-groups lists my groups; owner / admin see all", async () => {
    const names = async (who: string) => (await send(U[who].token, "GET", CG())).body.groups.map((g: any) => g.name).sort();
    expect(await names("alice")).toEqual(["研发部"]);
    expect(await names("bob")).toEqual(["后端小群", "研发部"].sort());
    expect(await names("carol")).toEqual([]);
    expect(await names("owner")).toEqual(["后端小群", "市场部群", "研发部"].sort());
    const owner = (await send(U.owner.token, "GET", CG())).body.groups;
    expect(owner.every((g: any) => g.is_member === false)).toBe(true);
    expect((await send(U.node.token, "GET", CG())).status).toBe(403);
    expect((await send(U.outsider.token, "GET", CG())).status).toBe(403);
    expect((await send(U.alice.token, "POST", CG(), {})).status).toBe(405);
  });

  test("GET …/chat-groups/:id: members see the roster; a non-member gets 404 (existence not leaked)", async () => {
    const gid = (await send(U.owner.token, "GET", G("rd"))).body.group.id;
    const alice = await send(U.alice.token, "GET", CG(`/${gid}`));
    expect(alice.status).toBe(200);
    expect(alice.body.is_member).toBe(true);
    expect(ids(alice.body.members)).toContain(U.alice.id);
    expect((await send(U.carol.token, "GET", CG(`/${gid}`))).status).toBe(404);
    expect((await send(U.carol.token, "GET", CG("/grp_doesnotexist"))).status).toBe(404);
  });
});

describe("deleting a department unlinks its group", () => {
  test("group and members stay with department_id = null; the id can get a fresh group later", async () => {
    const tmp = (await send(U.owner.token, "POST", D(), { name: "临时项目组", id: "dept_tmp_dg" })).body.department.id as string;
    const place = (dept: string | null) => send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.carol.id}/department`, { department_id: dept });
    expect((await place(tmp)).status).toBe(200);
    const created = await send(U.owner.token, "POST", D(`/${tmp}/group`), {});
    expect(created.status).toBe(201);
    expect(ids(created.body.members)).toEqual([U.carol.id]);
    expect((await place(null)).status).toBe(200);
    expect((await send(U.owner.token, "DELETE", D(`/${tmp}`))).status).toBe(200);

    const after = await send(U.owner.token, "GET", CG(`/${created.body.group.id}`));
    expect(after.status).toBe(200);
    expect(after.body.group.department_id).toBe(null);
    expect(ids(after.body.members)).toEqual([U.carol.id]);
    // 解除关联后,carol 仍是这个群的成员(本 PR 不做自动退出)。
    expect((await send(U.carol.token, "GET", CG(`/${created.body.group.id}`))).status).toBe(200);

    // 同一个部门 id 再建:不被已解除关联的旧群挡住(唯一索引允许多个 NULL)。
    expect((await send(U.owner.token, "POST", D(), { name: "临时项目组", id: "dept_tmp_dg" })).status).toBe(201);
    const again = await send(U.owner.token, "POST", D(`/${tmp}/group`), {});
    expect(again.status).toBe(201);
    expect(again.body.group.id).not.toBe(created.body.group.id);
  });
});
