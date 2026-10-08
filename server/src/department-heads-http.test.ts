// RFC-040(#455)部门负责人权限 —— 逐条钉矩阵:owner / admin / 负责人 / 上级负责人 / 普通成员 / viewer(当负责人)。
//
// 组织架构(测试夹具,全是占位名):
//   研发(上级负责人 parentHead)── 前端(负责人 head)── 前端一组
//                              └─ 后端
//   销售(无负责人)
//   只读组(负责人是 viewer —— 不获得任何东西)
// 成员:head 在前端,member 在前端一组(拥有节点 node_m),be 在后端,sales 在销售,viewer 在只读组,
// allMember(task_access='all')在销售。除 allMember 外都是「只看相关任务」(scoped)。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-dept-heads-"));
let BASE = "";
let hub: any = null;
const PW = "DeptHeadsPassw0rd!xyz";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
const D: Record<string, string> = {};
const C: Record<string, string> = {};
const P: Record<string, string> = {};
let NODE_TOKEN = "";

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const dept = (token: string, method: string, path = "", body?: unknown) => send(token, method, `/api/networks/${NET}/departments${path}`, body);
const me = async (k: string) => (await send(U[k].token, "GET", "/api/auth/me")).body.networks.find((n: any) => n.network_id === NET).managed_department_ids as string[];
const visible = async (k: string, query = "") => new Set(((await send(U[k].token, "GET", `/api/requirements?network_id=${NET}${query}`)).body.requirements as any[]).map(r => r.id));
const card = (k: string) => C[k];
const userRef = (k: string) => ({ kind: "user", id: U[k].id });

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`dh_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const stamp = Date.now();
  const add = async (k: string, role: string, scoped = true) => {
    const username = `dh_${k}_${stamp}`;
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    U[k] = { token: login.body.token, id: login.body.user.user_id };
    // #746 起新成员默认就是 scoped;allMember 显式放宽到 'all'(模拟升级前的老成员)。
    if (role !== "admin") expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[k].id}/task-grants`, { task_access: scoped ? "scoped" : "all" })).status).toBe(200);
  };
  await add("admin", "admin");
  for (const k of ["head", "parentHead", "member", "be", "sales"]) await add(k, "member");
  await add("viewer", "viewer");
  await add("allMember", "member", false);

  const mkDept = async (k: string, name: string, parent: string | null, leader: string | null) => {
    const r = await dept(U.owner.token, "POST", "", { name, parent_id: parent, leader_user_id: leader ? U[leader].id : null });
    expect(r.status).toBe(201);
    D[k] = r.body.department.id;
  };
  await mkDept("rd", "研发", null, "parentHead");
  await mkDept("fe", "前端", D.rd, "head");
  await mkDept("fe1", "前端一组", D.fe, null);
  await mkDept("be", "后端", D.rd, null);
  await mkDept("sales", "销售", null, null);
  await mkDept("ro", "只读组", null, "viewer");
  const place = async (k: string, d: string) => expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[k].id}/department`, { department_id: D[d] })).status).toBe(200);
  await place("head", "fe"); await place("member", "fe1"); await place("be", "be"); await place("sales", "sales"); await place("viewer", "ro"); await place("allMember", "sales");
  await place("parentHead", "rd");

  // member 拥有的节点:用 owner 建令牌,再把节点主人改成 member(scoped 成员不能自己建节点令牌)。
  const node = createNetworkTokenForNode(U.owner.id, NET, "示例-成员节点", "node_dh_m");
  NODE_TOKEN = node.token!;
  db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = 'node_dh_m'", [U.member.id]);

  for (const [k, name] of [["p1", "示例项目一"], ["p2", "示例项目二"]] as const) {
    const r = await send(U.owner.token, "POST", `/api/requirements/projects?network_id=${NET}`, { name, network_id: NET });
    expect(r.status).toBe(201);
    P[k] = r.body.project.id;
  }
  const mkCard = async (k: string, fields: Record<string, unknown>) => {
    const r = await send(U.owner.token, "POST", "/api/requirements", { name: `示例卡 ${k}`, network_id: NET, ...fields });
    expect(r.status).toBe(201);
    C[k] = r.body.requirement.id;
  };
  await mkCard("memberOwned", { owner: userRef("member") });
  await mkCard("memberAgent", { agent_owner: { kind: "node", id: "node_dh_m" } });
  await mkCard("salesOwned", { owner: userRef("sales"), project_id: P.p2 });
  await mkCard("beOwned", { owner: userRef("be") });
  await mkCard("salesP1", { owner: userRef("sales"), project_id: P.p1 });
  await mkCard("toDelete", { owner: userRef("member") });
  await mkCard("toDeleteAgent", { agent_owner: { kind: "node", id: "node_dh_m" } });
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("who is a head (computed per request)", () => {
  test("/api/auth/me managed_department_ids: own departments + all sub-departments; others empty; a viewer leader gets nothing", async () => {
    expect(new Set(await me("head"))).toEqual(new Set([D.fe, D.fe1]));
    expect(new Set(await me("parentHead"))).toEqual(new Set([D.rd, D.fe, D.fe1, D.be]));
    expect(await me("member")).toEqual([]);
    expect(await me("viewer")).toEqual([]);
    expect(await me("owner")).toEqual([]);
    const node = await send(NODE_TOKEN, "GET", "/api/auth/me");
    expect(node.body.networks[0].managed_department_ids).toEqual([]);
  });

  test("departments list: viewer_can per department; project_grants only for owner / admin", async () => {
    const byId = (r: any) => new Map((r.body.departments as any[]).map(d => [d.id, d.viewer_can]));
    const head = await dept(U.head.token, "GET");
    const v = byId(head);
    expect(v.get(D.fe)).toEqual({ manage: false, create_child: true }); // 自己负责的部门:不能改,能在下面建
    expect(v.get(D.fe1)).toEqual({ manage: true, create_child: true });
    expect(v.get(D.be)).toEqual({ manage: false, create_child: false });
    expect("project_grants" in head.body).toBe(false);
    expect(byId(await dept(U.parentHead.token, "GET")).get(D.fe)).toEqual({ manage: true, create_child: true });
    expect(byId(await dept(U.member.token, "GET")).get(D.fe1)).toEqual({ manage: false, create_child: false });
    const owner = await dept(U.owner.token, "GET");
    expect(byId(owner).get(D.sales)).toEqual({ manage: true, create_child: true });
    expect(Array.isArray(owner.body.project_grants)).toBe(true);
    expect(Array.isArray((await dept(U.admin.token, "GET")).body.project_grants)).toBe(true);
  });
});

describe("department writes: heads inside their subtree, fixed 403 outside", () => {
  test("create: under own subtree 201; elsewhere / top level → 403 department_scope_denied; non-heads unchanged", async () => {
    const ok = await dept(U.head.token, "POST", "", { name: "前端二组", parent_id: D.fe });
    expect(ok.status).toBe(201);
    D.fe2 = ok.body.department.id;
    for (const parent of [D.be, D.rd, null]) {
      const r = await dept(U.head.token, "POST", "", { name: "越权部门", parent_id: parent });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("department_scope_denied");
    }
    const leaderOutside = await dept(U.head.token, "POST", "", { name: "前端三组", parent_id: D.fe, leader_user_id: U.sales.id });
    expect(leaderOutside.body.error).toBe("department_scope_denied");
    // 普通成员 / viewer 负责人:与以前逐字节相同。
    for (const k of ["member", "viewer"]) {
      const r = await dept(U[k].token, "POST", "", { name: "x", parent_id: D.fe });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ ok: false, error: "owner/admin required" });
    }
  });

  test("patch: own department is the parent head's; sub-departments rename / move / set leader only inside the subtree", async () => {
    const own = await dept(U.head.token, "PATCH", `/${D.fe}`, { name: "前端改名" });
    expect(own.status).toBe(403);
    expect(own.body.error).toBe("department_scope_denied");
    expect((await dept(U.parentHead.token, "PATCH", `/${D.fe}`, { name: "前端(上级改)" })).status).toBe(200);
    expect((await dept(U.head.token, "PATCH", `/${D.fe1}`, { name: "前端一组(改)" })).status).toBe(200);
    expect((await dept(U.head.token, "PATCH", `/${D.fe2}`, { parent_id: D.fe1 })).status).toBe(200);
    expect((await dept(U.head.token, "PATCH", `/${D.fe2}`, { parent_id: D.be })).body.error).toBe("department_scope_denied");
    expect((await dept(U.head.token, "PATCH", `/${D.fe2}`, { parent_id: null })).body.error).toBe("department_scope_denied");
    expect((await dept(U.head.token, "PATCH", `/${D.be}`, { name: "后端改" })).body.error).toBe("department_scope_denied");
    expect((await dept(U.head.token, "PATCH", `/${D.fe1}`, { leader_user_id: U.member.id })).status).toBe(200);
    expect((await dept(U.head.token, "PATCH", `/${D.fe1}`, { leader_user_id: U.sales.id })).body.error).toBe("department_scope_denied");
    expect((await dept(U.head.token, "PATCH", `/${D.fe1}`, { leader_user_id: null })).status).toBe(200);
    expect((await dept(U.head.token, "PATCH", "/dept_missing", { name: "x" })).status).toBe(404);
  });

  test("delete: empty sub-department yes, outside no; the 409 not-empty rule still applies", async () => {
    expect((await dept(U.head.token, "DELETE", `/${D.be}`)).body.error).toBe("department_scope_denied");
    expect((await dept(U.head.token, "DELETE", `/${D.fe1}`)).status).toBe(409); // member 在里面
    expect((await dept(U.head.token, "DELETE", `/${D.fe2}`)).status).toBe(200);
  });

  test("moving people: only from inside the subtree to inside the subtree; in / out (incl. unassigned) is admin-only", async () => {
    const move = (k: string, who: string, to: string | null) => send(U[k].token, "PUT", `/api/networks/${NET}/members/${U[who].id}/department`, { department_id: to });
    expect((await move("head", "member", D.fe)).status).toBe(200);
    expect((await move("head", "member", D.fe1)).status).toBe(200);
    expect((await move("head", "member", null)).body.error).toBe("department_scope_denied");
    expect((await move("head", "member", D.sales)).body.error).toBe("department_scope_denied");
    expect((await move("head", "sales", D.fe)).body.error).toBe("department_scope_denied");
    expect((await move("member", "member", D.fe)).body).toEqual({ ok: false, error: "owner/admin required" });
    expect((await move("admin", "sales", D.fe)).status).toBe(200);
    expect((await move("admin", "sales", D.sales)).status).toBe(200);
  });
});

describe("tasks: union with the existing ACL", () => {
  test("a head sees, edits and is offered delete on the department's cards (owner or Agent owner in the subtree), nothing else", async () => {
    const seen = await visible("head");
    expect(seen.has(card("memberOwned"))).toBe(true);
    expect(seen.has(card("memberAgent"))).toBe(true);
    expect(seen.has(card("salesOwned"))).toBe(false);
    expect(seen.has(card("beOwned"))).toBe(false);
    expect((await send(U.head.token, "GET", `/api/requirements/${card("beOwned")}`)).status).toBe(404);
    const row = (await send(U.head.token, "GET", `/api/requirements/${card("memberOwned")}`)).body.requirement;
    expect(row.viewer_can).toMatchObject({ edit: true, delete: true });
    expect((await send(U.head.token, "PATCH", `/api/requirements/${card("memberOwned")}`, { name: "示例卡(负责人改)" })).status).toBe(200);
    const parent = await visible("parentHead");
    expect(parent.has(card("beOwned"))).toBe(true);
    expect(parent.has(card("memberOwned"))).toBe(true);
    expect(parent.has(card("salesOwned"))).toBe(false);
  });

  test("a head-only edit can hand the card only to the department (or self); clearing is allowed", async () => {
    const out = await send(U.head.token, "PATCH", `/api/requirements/${card("memberAgent")}`, { owner: userRef("sales") });
    expect(out.status).toBe(403);
    expect(out.body.error).toBe("department_scope_denied");
    expect(out.body.field).toBe("owner");
    expect((await send(U.head.token, "PATCH", `/api/requirements/${card("memberAgent")}`, { owner: userRef("member") })).status).toBe(200);
    expect((await send(U.head.token, "PATCH", `/api/requirements/${card("memberAgent")}`, { owner: null })).status).toBe(200);
  });

  test("viewers never get head power; ordinary members see nothing new", async () => {
    // viewer 负责「只读组」,把 sales 临时放进去:viewer 仍看不见 sales 的卡,也不能删。
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.sales.id}/department`, { department_id: D.ro })).status).toBe(200);
    expect((await visible("viewer")).has(card("salesOwned"))).toBe(false);
    expect((await send(U.viewer.token, "DELETE", `/api/requirements/${card("salesOwned")}`)).status).not.toBe(200);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.sales.id}/department`, { department_id: D.sales })).status).toBe(200);
    const be = await visible("be");
    expect(be.has(card("memberOwned"))).toBe(false);
    expect([...be].every(id => id === card("beOwned"))).toBe(true);
  });

  test("revoking a head takes effect on the very next request (no cache, no re-login)", async () => {
    expect((await dept(U.owner.token, "PATCH", `/${D.fe}`, { leader_user_id: null })).status).toBe(200);
    expect(await me("head")).toEqual([]);
    expect((await visible("head")).has(card("memberOwned"))).toBe(false);
    expect((await dept(U.head.token, "POST", "", { name: "撤了还想建", parent_id: D.fe })).body).toEqual({ ok: false, error: "owner/admin required" });
    expect((await send(U.head.token, "PATCH", `/api/requirements/${card("memberOwned")}`, { name: "撤了还想改" })).status).toBe(404);
    expect((await dept(U.owner.token, "PATCH", `/${D.fe}`, { leader_user_id: U.head.id })).status).toBe(200);
    expect((await visible("head")).has(card("memberOwned"))).toBe(true);
  });

  test("union never revokes: personal project grants and task_access='all' are untouched by departments", async () => {
    // member 有按人授权 p1(可改)。把他调来调去、设部门授权、撤负责人,都不影响这份授权。
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/task-grants`, { project_grants: [{ project_id: P.p1, can_edit: true }] })).status).toBe(200);
    expect((await visible("member")).has(card("salesP1"))).toBe(true);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: D.be })).status).toBe(200);
    expect((await dept(U.owner.token, "PUT", `/${D.be}/project-grants`, { project_grants: [] })).status).toBe(200);
    expect((await visible("member")).has(card("salesP1"))).toBe(true);
    expect((await send(U.member.token, "PATCH", `/api/requirements/${card("salesP1")}`, { name: "按人授权可改" })).status).toBe(200);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/department`, { department_id: D.fe1 })).status).toBe(200);
    // task_access='all' 的老成员:看见全部,和部门无关。
    const all = await visible("allMember");
    for (const k of ["memberOwned", "salesOwned", "beOwned"]) expect(all.has(card(k))).toBe(true);
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.member.id}/task-grants`, { project_grants: [] })).status).toBe(200);
  });
});

describe("department project grants", () => {
  test("owner / admin only; whole-batch validation", async () => {
    expect((await dept(U.head.token, "GET", `/${D.rd}/project-grants`)).body).toEqual({ ok: false, error: "owner/admin required" });
    expect((await dept(U.parentHead.token, "PUT", `/${D.rd}/project-grants`, { project_grants: [{ project_id: P.p2 }] })).status).toBe(403);
    const bad = await dept(U.owner.token, "PUT", `/${D.rd}/project-grants`, { project_grants: [{ project_id: P.p2 }, { project_id: "proj_not_here" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("project_not_in_network");
    expect((await dept(U.owner.token, "GET", `/${D.rd}/project-grants`)).body.project_grants).toEqual([]);
    expect((await dept(U.owner.token, "GET", "/dept_missing/project-grants")).status).toBe(404);
  });

  test("a grant to a department cascades to its sub-departments, not to siblings; can_edit decides edit", async () => {
    expect((await visible("member")).has(card("salesOwned"))).toBe(false);
    expect((await dept(U.admin.token, "PUT", `/${D.rd}/project-grants`, { project_grants: [{ project_id: P.p2, can_edit: false }] })).status).toBe(200);
    expect((await visible("member")).has(card("salesOwned"))).toBe(true); // member 在 研发 › 前端 › 前端一组
    expect((await visible("sales")).has(card("salesOwned"))).toBe(true); // 自己的卡,本来就看得见
    expect((await send(U.member.token, "PATCH", `/api/requirements/${card("salesOwned")}`, { name: "只读授权" })).status).toBe(403);
    expect((await dept(U.owner.token, "PUT", `/${D.rd}/project-grants`, { project_grants: [{ project_id: P.p2, can_edit: true }] })).status).toBe(200);
    expect((await send(U.member.token, "PATCH", `/api/requirements/${card("salesOwned")}`, { name: "部门授权可改" })).status).toBe(200);
    // 授权给 后端:前端一组的 member 拿不到。
    expect((await dept(U.owner.token, "PUT", `/${D.rd}/project-grants`, { project_grants: [] })).status).toBe(200);
    expect((await dept(U.owner.token, "PUT", `/${D.be}/project-grants`, { project_grants: [{ project_id: P.p2 }] })).status).toBe(200);
    expect((await visible("member")).has(card("salesOwned"))).toBe(false);
    expect((await visible("be")).has(card("salesOwned"))).toBe(true);
    expect((await dept(U.owner.token, "GET")).body.project_grants).toEqual([{ department_id: D.be, project_id: P.p2, can_edit: false }]);
    // 项目列表也跟着授权走。
    const projects = (await send(U.be.token, "GET", `/api/requirements/projects?network_id=${NET}`)).body.projects.map((p: any) => p.id);
    expect(projects).toContain(P.p2);
  });
});

describe("delete by a head: audit + DM", () => {
  test("head deletes a department card → requirement_deleted_by_leader + a DM to the card's owner (or the Agent's owner)", async () => {
    const inbox = (uid: string) => db.all<{ content: string }>("SELECT content FROM user_inbox WHERE user_id = ?1 AND content LIKE '%部门负责人%'", uid);
    const before = inbox(U.member.id).length;
    expect((await send(U.head.token, "DELETE", `/api/requirements/${card("toDelete")}`)).status).toBe(200);
    expect((await send(U.head.token, "DELETE", `/api/requirements/${card("toDeleteAgent")}`)).status).toBe(200);
    const audits = db.all<{ action: string; target_id: string; detail: string }>("SELECT action, target_id, detail FROM audit_log WHERE action = 'requirement_deleted_by_leader' ORDER BY id");
    expect(audits.map(a => a.target_id)).toEqual([card("toDelete"), card("toDeleteAgent")]);
    expect(JSON.parse(audits[0].detail).notified).toBe(U.member.id);
    expect(JSON.parse(audits[1].detail).notified).toBe(U.member.id); // Agent 的主人
    const dms = inbox(U.member.id);
    expect(dms.length).toBe(before + 2);
    expect(dms.at(-1)!.content).toContain("删除了你负责的任务");
    // 不是本部门的卡:负责人删不了(看不见 = 404)。普通成员删别人的卡照旧被拒。
    expect((await send(U.head.token, "DELETE", `/api/requirements/${card("beOwned")}`)).status).toBe(404);
    expect((await send(U.be.token, "DELETE", `/api/requirements/${card("salesOwned")}`)).status).toBe(403);
  });
});

describe("department_id filter and the read-only node list", () => {
  test("GET /api/requirements?department_id= narrows to the subtree's cards, within what the caller can see", async () => {
    const all = await visible("owner", `&department_id=${D.fe}`);
    expect(all.has(card("memberOwned"))).toBe(true);
    expect(all.has(card("memberAgent"))).toBe(true);
    expect(all.has(card("beOwned"))).toBe(false);
    expect((await visible("owner", `&department_id=${D.rd}`)).has(card("beOwned"))).toBe(true);
    expect((await visible("be", `&department_id=${D.rd}`)).has(card("memberOwned"))).toBe(false); // 仍受可见范围约束
    const bad = await send(U.owner.token, "GET", `/api/requirements?network_id=${NET}&department_id=dept_missing`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("department_not_found");
  });

  test("GET …/departments/:dept/nodes: heads (subtree) and owner/admin; read-only status + health", async () => {
    const r = await dept(U.head.token, "GET", `/${D.fe}/nodes`);
    expect(r.status).toBe(200);
    expect(r.body.nodes.map((n: any) => n.node_id)).toEqual(["node_dh_m"]);
    expect(Object.keys(r.body.nodes[0]).sort()).toEqual(["alias", "degraded", "display_name", "health", "last_seen_at", "node_id", "owner_user_id", "status"]);
    expect((await dept(U.head.token, "GET", `/${D.be}/nodes`)).body.error).toBe("department_scope_denied");
    expect((await dept(U.member.token, "GET", `/${D.fe}/nodes`)).body.error).toBe("department_scope_denied");
    expect((await dept(U.owner.token, "GET", `/${D.rd}/nodes`)).body.nodes.length).toBe(1);
    expect((await dept(U.head.token, "POST", `/${D.fe}/nodes`, {})).status).toBe(405);
    expect((await send(NODE_TOKEN, "GET", `/api/networks/${NET}/departments/${D.fe}/nodes`)).body.error).toBe("department_scope_denied");
  });
});
