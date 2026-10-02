// RFC-042(看板 #457)部门群,第二个 PR:成员同步 + 手动成员 + 改群名。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PostgreSQL 由 test2123 梯子用 COMMHUB_TEST_PG_URL 跑同一个文件)。
// 钉住 §4 的每个触发点:调进 / 调出 / 子树内调动、建带负责人的子部门、改上级、换负责人、删部门、移出网络、读时兜底对账;
// manual 行永远不被同步动(手动拉的人进部门后仍是 manual,离开部门也留在群里);手动移部门来源的人 → 409;
// 谁能管群(owner / admin / 该部门(含上级)负责人),看得见管不了 → 403,看不见 → 404,Agent → 403 humans_only。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-dept-groups-sync-"));
let BASE = "";
let hub: any = null;
const PW = "DeptGroupsSyncPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
const DEPT: Record<string, string> = {};
const GRP: Record<string, string> = {};

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const D = (suffix = "") => `/api/networks/${NET}/departments${suffix}`;
const CG = (suffix = "") => `/api/networks/${NET}/chat-groups${suffix}`;
const place = async (who: string, dept: string | null) =>
  expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[who].id}/department`, { department_id: dept })).status).toBe(200);
const patchDept = async (key: string, body: Record<string, unknown>) =>
  expect((await send(U.owner.token, "PATCH", D(`/${DEPT[key]}`), body)).status).toBe(200);
/** 直接读库(不经过 GET,GET 会顺手对账,会把要测的「写操作时同步」掩盖掉)。user_id → source。 */
function rows(groupKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.all<{ user_id: string; source: string }>("SELECT user_id, source FROM chat_group_members WHERE group_id = ?1", GRP[groupKey])) out[r.user_id] = r.source;
  return out;
}
const who = (groupKey: string) => Object.keys(rows(groupKey)).map((id) => Object.keys(U).find((k) => U[k].id === id) ?? id).sort();

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`dgs_owner_${Date.now()}`, PW, undefined, "Owner");
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
  U.admin = await add(`dgs_admin_${stamp}`, "admin");
  U.head = await add(`dgs_head_${stamp}`, "member");     // 研发部负责人,研发部成员
  U.alice = await add(`dgs_alice_${stamp}`, "member");   // 研发部成员
  U.bob = await add(`dgs_bob_${stamp}`, "member");       // 后端组成员 + 后端组负责人
  U.carol = await add(`dgs_carol_${stamp}`, "member");   // 未分配,拿来调来调去
  U.dave = await add(`dgs_dave_${stamp}`, "member");     // 市场部成员
  U.erin = await add(`dgs_erin_${stamp}`, "member");     // 未分配,用来测「移出网络」
  U.viewer = await add(`dgs_viewer_${stamp}`, "viewer"); // 研发部成员,只读
  U.node = { token: createNetworkTokenForNode(U.owner.id, NET, "dgs-node", "node_dgs").token!, id: "node_dgs" };
  const o = register(`dgs_outsider_${stamp}`, PW);
  U.outsider = { token: o.token!, id: o.user!.user_id };

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await send(U.owner.token, "POST", D(), { name, ...extra });
    expect(r.status).toBe(201);
    return r.body.department.id as string;
  };
  DEPT.rd = await mk("研发部", { leader_user_id: U.head.id });
  DEPT.backend = await mk("后端组", { parent_id: DEPT.rd, leader_user_id: U.bob.id });
  DEPT.market = await mk("市场部");
  await place("head", DEPT.rd);
  await place("alice", DEPT.rd);
  await place("viewer", DEPT.rd);
  await place("bob", DEPT.backend);
  await place("dave", DEPT.market);
  for (const key of ["rd", "backend", "market"]) {
    const r = await send(U.owner.token, "POST", D(`/${DEPT[key]}/group`), {});
    expect(r.status).toBe(201);
    GRP[key] = r.body.group.id;
  }
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("seed", () => {
  test("groups start from the roster", () => {
    expect(who("rd")).toEqual(["alice", "bob", "head", "viewer"]);
    expect(who("backend")).toEqual(["bob"]);
    expect(who("market")).toEqual(["dave"]);
  });
});

describe("sync on moving a member (PUT …/members/:uid/department)", () => {
  test("move in: joins the department group and every ancestor department group, source='department'", async () => {
    await place("carol", DEPT.backend);
    expect(rows("backend")[U.carol.id]).toBe("department");
    expect(rows("rd")[U.carol.id]).toBe("department");
    expect(rows("market")[U.carol.id]).toBeUndefined();
  });

  test("move within the subtree: leaves the sub-department group, stays in the parent group", async () => {
    await place("carol", DEPT.rd);
    expect(rows("backend")[U.carol.id]).toBeUndefined();
    expect(rows("rd")[U.carol.id]).toBe("department");
  });

  test("move across: leaves 研发部, joins 市场部", async () => {
    await place("carol", DEPT.market);
    expect(rows("rd")[U.carol.id]).toBeUndefined();
    expect(rows("market")[U.carol.id]).toBe("department");
  });

  test("move out (unassigned): removed from the group", async () => {
    await place("carol", null);
    expect(rows("market")[U.carol.id]).toBeUndefined();
    expect(who("market")).toEqual(["dave"]);
  });
});

describe("manual members are never touched by sync", () => {
  test("a manual member who later joins the department keeps one row, still 'manual'; leaving the department keeps them in", async () => {
    const add = await send(U.owner.token, "POST", CG(`/${GRP.market}/members`), { user_id: U.carol.id });
    expect(add.status).toBe(201);
    expect(add.body.member).toMatchObject({ user_id: U.carol.id, source: "manual" });
    await place("carol", DEPT.market);
    expect(rows("market")[U.carol.id]).toBe("manual");
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", GRP.market, U.carol.id)?.n)).toBe(1);
    await place("carol", null);
    expect(rows("market")[U.carol.id]).toBe("manual");
  });

  test("manual remove works for a manual row; a department-sourced member → 409 department_member and stays", async () => {
    const dep = await send(U.owner.token, "DELETE", CG(`/${GRP.market}/members/${U.dave.id}`));
    expect(dep.status).toBe(409);
    expect(dep.body.error).toBe("department_member");
    expect(rows("market")[U.dave.id]).toBe("department");
    const man = await send(U.owner.token, "DELETE", CG(`/${GRP.market}/members/${U.carol.id}`));
    expect(man.status).toBe(200);
    expect(rows("market")[U.carol.id]).toBeUndefined();
    expect((await send(U.owner.token, "DELETE", CG(`/${GRP.market}/members/${U.carol.id}`))).status).toBe(404);
    const audit = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE network_id = ?1 AND action = 'chat_group_member_removed' ORDER BY id DESC LIMIT 1", NET);
    expect(JSON.parse(audit!.detail)).toMatchObject({ group_id: GRP.market, user_id: U.carol.id });
  });
});

describe("sync on department changes", () => {
  test("re-parent (PATCH parent_id): the moved subtree's people leave the old ancestor group and join the new one", async () => {
    await patchDept("backend", { parent_id: DEPT.market });
    expect(rows("rd")[U.bob.id]).toBeUndefined();
    expect(rows("market")[U.bob.id]).toBe("department");
    expect(who("backend")).toEqual(["bob"]);
    await patchDept("backend", { parent_id: DEPT.rd });
    expect(rows("rd")[U.bob.id]).toBe("department");
    expect(rows("market")[U.bob.id]).toBeUndefined();
  });

  test("set / change / clear the head: the head joins and leaves with the leadership", async () => {
    await patchDept("market", { leader_user_id: U.carol.id }); // carol 未分配,只当负责人
    expect(rows("market")[U.carol.id]).toBe("department");
    await patchDept("market", { leader_user_id: U.erin.id });
    expect(rows("market")[U.carol.id]).toBeUndefined();
    expect(rows("market")[U.erin.id]).toBe("department");
    await patchDept("market", { leader_user_id: null });
    expect(rows("market")[U.erin.id]).toBeUndefined();
    // 换的负责人本来就是部门成员 → 还在群里(按成员身份)。
    await patchDept("rd", { leader_user_id: U.alice.id });
    expect(rows("rd")[U.head.id]).toBe("department");
    expect(rows("rd")[U.alice.id]).toBe("department");
    await patchDept("rd", { leader_user_id: U.head.id });
  });

  test("renaming / re-sorting a department does not touch membership", async () => {
    const before = rows("rd");
    await patchDept("rd", { name: "研发中心", sort: 3 });
    expect(rows("rd")).toEqual(before);
    await patchDept("rd", { name: "研发部" });
  });

  test("creating a sub-department with a head adds that head to the ancestor groups; deleting it removes them", async () => {
    const r = await send(U.owner.token, "POST", D(), { name: "前端组", parent_id: DEPT.rd, leader_user_id: U.carol.id });
    expect(r.status).toBe(201);
    DEPT.fe = r.body.department.id;
    expect(rows("rd")[U.carol.id]).toBe("department");
    expect(rows("backend")[U.carol.id]).toBeUndefined();
    expect((await send(U.owner.token, "DELETE", D(`/${DEPT.fe}`))).status).toBe(200);
    expect(rows("rd")[U.carol.id]).toBeUndefined();
  });

  test("an unlinked group (department deleted) is no longer synced", async () => {
    const tmp = (await send(U.owner.token, "POST", D(), { name: "临时组", leader_user_id: U.erin.id })).body.department.id as string;
    const g = await send(U.owner.token, "POST", D(`/${tmp}/group`), {});
    expect(g.status).toBe(201);
    GRP.tmp = g.body.group.id;
    expect((await send(U.owner.token, "DELETE", D(`/${tmp}`))).status).toBe(200);
    expect(who("tmp")).toEqual(["erin"]);
    // 读也不对账(部门已不存在,roster 为空,对账会把 erin 踢掉)。
    expect((await send(U.erin.token, "GET", CG(`/${GRP.tmp}`))).status).toBe(200);
    expect(who("tmp")).toEqual(["erin"]);
    // 解除关联的群里,原部门来源的行可以手动移掉(不会再被加回来)。
    expect((await send(U.owner.token, "DELETE", CG(`/${GRP.tmp}/members/${U.erin.id}`))).status).toBe(200);
  });
});

describe("removing someone from the network", () => {
  test("drops every group row they had in this network, whatever the source", async () => {
    await place("erin", DEPT.backend);
    expect((await send(U.owner.token, "POST", CG(`/${GRP.market}/members`), { user_id: U.erin.id })).status).toBe(201);
    await patchDept("market", { leader_user_id: U.erin.id });
    expect(rows("backend")[U.erin.id]).toBe("department");
    expect(rows("rd")[U.erin.id]).toBe("department");
    expect(rows("market")[U.erin.id]).toBe("manual");
    expect((await send(U.owner.token, "DELETE", `/api/networks/${NET}/members/${U.erin.id}`)).status).toBe(200);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_members WHERE network_id = ?1 AND user_id = ?2", NET, U.erin.id)?.n)).toBe(0);
    // 她仍挂着市场部负责人(leader_user_id 没清),但已不是网络成员:读时对账也不会把她加回来。
    expect((await send(U.owner.token, "GET", CG(`/${GRP.market}`))).status).toBe(200);
    expect(rows("market")[U.erin.id]).toBeUndefined();
    await patchDept("market", { leader_user_id: null });
  });
});

describe("read-time reconcile (safety net for drift)", () => {
  test("GET …/chat-groups/:gid and GET …/departments/:id/group put missing roster rows back and drop stale department rows", async () => {
    db.run("DELETE FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", [GRP.rd, U.alice.id]);
    db.run("INSERT INTO chat_group_members (group_id, user_id, network_id, source) VALUES (?1, ?2, ?3, 'department')", [GRP.rd, U.dave.id, NET]);
    const r = await send(U.owner.token, "GET", CG(`/${GRP.rd}`));
    expect(r.status).toBe(200);
    expect(rows("rd")[U.alice.id]).toBe("department");
    expect(rows("rd")[U.dave.id]).toBeUndefined();
    // 漂移掉的人自己读:先对账再判成员,所以 alice 读得到。
    db.run("DELETE FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", [GRP.rd, U.alice.id]);
    expect((await send(U.alice.token, "GET", D(`/${DEPT.rd}/group`))).status).toBe(200);
    expect(rows("rd")[U.alice.id]).toBe("department");
  });
});

describe("rename + manual members: permissions", () => {
  test("owner, admin and the department's head (incl. an ancestor head) can rename; bad names → 400", async () => {
    expect((await send(U.owner.token, "PATCH", CG(`/${GRP.rd}`), { name: "  研发群  " })).body.group.name).toBe("研发群");
    expect((await send(U.admin.token, "PATCH", CG(`/${GRP.rd}`), { name: "研发部" })).status).toBe(200);
    const h = await send(U.head.token, "PATCH", CG(`/${GRP.backend}`), { name: "后端群" });
    expect(h.status).toBe(200);
    expect(h.body.group.name).toBe("后端群");
    const audit = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE network_id = ?1 AND action = 'chat_group_renamed' ORDER BY id DESC LIMIT 1", NET);
    expect(JSON.parse(audit!.detail)).toMatchObject({ group_id: GRP.backend, via: "leader" });
    for (const name of [42, "", "   ", "x".repeat(41), undefined]) {
      const r = await send(U.owner.token, "PATCH", CG(`/${GRP.rd}`), name === undefined ? {} : { name });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_group_name");
    }
  });

  test("a member who can see but not manage → 403 group_manage_denied; a non-member → 404; nodes → 403 humans_only", async () => {
    // bob 管后端组(下级),管不了研发部的群,但他是研发部群的成员。
    for (const [method, path, body] of [
      ["PATCH", CG(`/${GRP.rd}`), { name: "x" }],
      ["POST", CG(`/${GRP.rd}/members`), { user_id: U.carol.id }],
      ["DELETE", CG(`/${GRP.rd}/members/${U.alice.id}`), undefined],
    ] as const) {
      for (const k of ["bob", "alice", "viewer"]) {
        const r = await send(U[k].token, method, path, body);
        expect(r.status).toBe(403);
        expect(r.body.error).toBe("group_manage_denied");
      }
      const carol = await send(U.carol.token, method, path, body);
      expect(carol.status).toBe(404);
      expect(carol.body.error).toBe("group_not_found");
      const node = await send(U.node.token, method, path, body);
      expect(node.status).toBe(403);
      expect(node.body.error).toBe("humans_only");
      expect((await send(U.outsider.token, method, path, body)).status).toBe(403);
      expect((await send("", method, path, body)).status).toBe(401);
    }
    // 不存在的群,管理员也是 404。
    expect((await send(U.owner.token, "PATCH", CG("/grp_doesnotexist"), { name: "x" })).status).toBe(404);
    expect(who("rd")).toEqual(["alice", "bob", "head", "viewer"]);
  });

  test("a head reads groups in their subtree, and can add / remove manual members there", async () => {
    // head 不是后端组群的成员,但后端组在他的子树里:读得到。
    const read = await send(U.head.token, "GET", CG(`/${GRP.backend}`));
    expect(read.status).toBe(200);
    expect(read.body.is_member).toBe(false);
    const add = await send(U.head.token, "POST", CG(`/${GRP.backend}/members`), { user_id: U.dave.id });
    expect(add.status).toBe(201);
    expect(rows("backend")[U.dave.id]).toBe("manual");
    const audit = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE network_id = ?1 AND action = 'chat_group_member_added' ORDER BY id DESC LIMIT 1", NET);
    expect(JSON.parse(audit!.detail)).toMatchObject({ group_id: GRP.backend, user_id: U.dave.id, via: "leader" });
    expect((await send(U.bob.token, "DELETE", CG(`/${GRP.backend}/members/${U.dave.id}`))).status).toBe(200);
    // 越界:head 管不了市场部的群(不是成员 → 404)。
    expect((await send(U.head.token, "POST", CG(`/${GRP.market}/members`), { user_id: U.alice.id })).status).toBe(404);
  });

  test("add: bad input, non-network users, and existing members are refused", async () => {
    expect((await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), {})).body.error).toBe("user_id_required");
    expect((await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: 7 })).status).toBe(400);
    const outsider = await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.outsider.id });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error).toBe("not_network_member");
    expect((await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.node.id })).body.error).toBe("not_network_member");
    const dup = await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.alice.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("already_group_member");
    expect(rows("rd")[U.alice.id]).toBe("department");
    expect((await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), "not json")).status).toBe(400);
  });

  test("unsupported methods → 405", async () => {
    expect((await send(U.owner.token, "PUT", CG(`/${GRP.rd}`), { name: "x" })).status).toBe(405);
    expect((await send(U.owner.token, "DELETE", CG(`/${GRP.rd}`))).status).toBe(405);
    expect((await send(U.owner.token, "GET", CG(`/${GRP.rd}/members`))).status).toBe(405);
    expect((await send(U.owner.token, "POST", CG(), {})).status).toBe(405);
  });
});
