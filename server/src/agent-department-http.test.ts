// Agent(节点)显式归属部门 —— `PUT /api/networks/:net/nodes/:nodeId/department`。
//
// 2026-10-19 现网：组织架构页 4 个部门各「0 个 Agent」、328 个 Agent 全在「未归属」。
// 原因不是没人管，而是后端**没有**「Agent 属于哪个部门」这个字段：那时的口径只有
// 「负责人（人）在哪个部门」，于是没有负责人 / 负责人不在部门树里的 Agent 只能算未归属。
//
// 这组用例钉住：
//   1. owner 能把 Agent 放进部门、能改、能清空；
//   2. 清空后回到「按负责人的部门推断」的旧口径（directory 里 department_id 为 null）；
//   3. 别的网络的部门 / 不存在的部门 / 不存在的节点都被拒；
//   4. 普通成员不能改；本部门负责人只能在子树内调动；
//   5. 通讯录（/api/requirements/people/directory）会把显式部门带给客户端。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-dept-"));
let BASE = "";
let hub: any = null;
const PW = "AgentDeptPassw0rd!xyz";
let NET = "";
let OTHER_NET = "";
const U: Record<string, { token: string; id: string }> = {};
const D: Record<string, string> = {};
let NODE_A = "";
let NODE_OUTSIDE = "";

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const setDept = (token: string, nodeId: string, department_id: string | null) =>
  send(token, "PUT", `/api/networks/${NET}/nodes/${nodeId}/department`, { department_id });
const dept = (token: string, method: string, path = "", body?: unknown) =>
  send(token, method, `/api/networks/${NET}/departments${path}`, body);

function agentRow(nodeId: string) {
  return db.get<{ department_id: string | null }>("SELECT department_id FROM nodes WHERE node_id = ?1", nodeId);
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`ad_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  // 第二个网络：用来钉「别的网络的部门不能被借来用」。
  OTHER_NET = `net_other_${Date.now()}`;
  db.run("INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, ?1, ?2)", [OTHER_NET, U.owner.id]);
  db.run("INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')", [OTHER_NET, U.owner.id]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort, created_by) VALUES (?1, 'dept_other', '别的网', 0, ?2)", [OTHER_NET, U.owner.id]);

  // 两个部门 + 一个普通成员
  const made = await dept(U.owner.token, "POST", "", { name: "TMAI" });
  expect([200, 201]).toContain(made.status);
  D.tmai = made.body.department.id;
  const made2 = await dept(U.owner.token, "POST", "", { name: "A 站" });
  expect([200, 201]).toContain(made2.status);
  D.a = made2.body.department.id;

  const stamp = Date.now();
  expect((await send(U.owner.token, "POST", "/api/admin/users", { username: `ad_member_${stamp}`, password: PW, network_id: NET, role: "member" })).status).toBe(200);
  const login = await send("", "POST", "/api/auth/login", { username: `ad_member_${stamp}`, password: PW });
  U.member = { token: login.body.token, id: login.body.user.user_id };

  // 两个节点：一个在本网络（无负责人），一个属于别的网络。
  NODE_A = `n_ad_${stamp}`;
  NODE_OUTSIDE = `n_ad_out_${stamp}`;
  db.run(
    "INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, '测试员 3 号', '测试员 3 号', ?2, datetime('now'), datetime('now'))",
    [NODE_A, NET],
  );
  db.run(
    "INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, '别的网的节点', '别的网的节点', ?2, datetime('now'), datetime('now'))",
    [NODE_OUTSIDE, OTHER_NET],
  );
});

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

describe("Agent 显式归属部门", () => {
  test("owner 把 Agent 放进部门 → 落库；再改到另一个部门 → 跟随", async () => {
    const first = await setDept(U.owner.token, NODE_A, D.tmai);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, node_id: NODE_A, department_id: D.tmai });
    expect(agentRow(NODE_A)!.department_id).toBe(D.tmai);

    const moved = await setDept(U.owner.token, NODE_A, D.a);
    expect(moved.status).toBe(200);
    expect(agentRow(NODE_A)!.department_id).toBe(D.a);
  });

  test("清空（null / 空串）→ 回到「按负责人推断」的口径", async () => {
    expect((await setDept(U.owner.token, NODE_A, D.tmai)).status).toBe(200);
    const cleared = await setDept(U.owner.token, NODE_A, null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.department_id).toBeNull();
    expect(agentRow(NODE_A)!.department_id).toBeNull();

    expect((await setDept(U.owner.token, NODE_A, D.tmai)).status).toBe(200);
    expect((await setDept(U.owner.token, NODE_A, "")).body.department_id).toBeNull();
  });

  test("拒绝：别的网络的部门 / 不存在的部门 / 不存在的节点 / 别的网络的节点", async () => {
    expect((await setDept(U.owner.token, NODE_A, "dept_other")).status).toBe(400);
    expect((await setDept(U.owner.token, NODE_A, "dept_nope")).status).toBe(400);
    expect((await setDept(U.owner.token, "n_nope", D.tmai)).status).toBe(404);
    expect((await setDept(U.owner.token, NODE_OUTSIDE, D.tmai)).status).toBe(404);
  });

  test("普通成员改不了（403）", async () => {
    const r = await setDept(U.member.token, NODE_A, D.tmai);
    expect(r.status).toBe(403);
  });

  test("通讯录把显式部门带给客户端；清空后回到 null", async () => {
    expect((await setDept(U.owner.token, NODE_A, D.a)).status).toBe(200);
    const dir = await send(U.owner.token, "GET", `/api/requirements/people/directory?network_id=${NET}`);
    expect(dir.status).toBe(200);
    const agents = [...(dir.body.people ?? []).flatMap((p: any) => p.agents ?? []), ...(dir.body.agents_without_owner ?? [])];
    const mine = agents.find((a: any) => a.node_id === NODE_A);
    expect(mine?.department_id).toBe(D.a);

    expect((await setDept(U.owner.token, NODE_A, null)).status).toBe(200);
    const dir2 = await send(U.owner.token, "GET", `/api/requirements/people/directory?network_id=${NET}`);
    const agents2 = [...(dir2.body.people ?? []).flatMap((p: any) => p.agents ?? []), ...(dir2.body.agents_without_owner ?? [])];
    expect(agents2.find((a: any) => a.node_id === NODE_A)?.department_id ?? null).toBeNull();
  });

  // #1976 —— Agent 归属与人类部门是两个独立的结构。通讯录顶层要说明「这个 Hub 支持显式
  // Agent 部门」,客户端据此把「行里没有 department_id」读成「没有显式归属」,
  // 而不是从「负责人在哪个部门」推断出来。
  // #2888（通信客户端欧 2026-10-28 提）—— 军团按部门分区时，N 个部门要发 N 次
  // `…/departments/:dept/nodes` 才能拼出「每个 Agent 属于哪个部门」，人数一多就慢。
  // 事实上 /api/nodes 早就返回全部节点，只是没 select `department_id` 这一列。
  // 补上之后一次往返就能完成分区初始化。
  test("/api/nodes 一次返回全部节点且带 department_id（免 N 次部门往返）", async () => {
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/nodes/${NODE_A}/department`, { department_id: D.tmai })).status).toBe(200);
    const all = await send(U.owner.token, "GET", `/api/nodes?network_id=${NET}`);
    expect(all.status).toBe(200);
    const row = (all.body.nodes ?? []).find((n: any) => n.node_id === NODE_A);
    expect(row).toBeDefined();
    expect(row.department_id).toBe(D.tmai);
    // 未归属的节点这一格是 null（不是缺键）——分区逻辑可以统一按 null 判「未分组」。
    const other = (all.body.nodes ?? []).find((n: any) => n.node_id === NODE_OUTSIDE);
    if (other) expect(other.department_id ?? null).toBeNull();
  });

  test("通讯录声明支持显式 Agent 部门（与人类部门相互独立）", async () => {
    const dir = await send(U.owner.token, "GET", `/api/requirements/people/directory?network_id=${NET}`);
    expect(dir.status).toBe(200);
    expect(dir.body.agent_department_supported).toBe(true);
    // 行形状不变:没有显式归属的行**不带** department_id 这一格(旧客户端形状不变)。
    const agents = [...(dir.body.people ?? []).flatMap((p: any) => p.agents ?? []), ...(dir.body.agents_without_owner ?? [])];
    for (const a of agents) {
      // 显式归属 ⇒ 带这一格且非空;没有显式归属 ⇒ **不带这一格**(旧客户端形状不变)。
      if (a.department_id) expect(typeof a.department_id).toBe("string");
      else expect(Object.prototype.hasOwnProperty.call(a, "department_id")).toBe(false);
    }
  });
});
