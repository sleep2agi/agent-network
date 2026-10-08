// #752:MCP org_whoami —— 节点查自己在组织架构里的位置(只读,只给节点令牌)。
// HTTP 集成测试(真实 Bun.serve + /mcp,临时库;PG 阶梯里用同一个文件跑真 PostgreSQL)。
//
// 夹具(全是占位名):研发(负责人 headA)── 前端(负责人 headB);运维(无负责人)。
// owner 在运维;member(显示名等于用户名)在前端;loner 不在任何部门。
// 节点:n1 归前端;n2(owner 的)未归部门;n3(loner 的)未归部门。
// 另一个网络 B:用同一个部门 id 建一个部门,放进 B 的人和节点 —— A 的节点一个都不能看见。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-org-whoami-"));
let BASE = "";
let hub: any = null;
const PW = "OrgWhoamiPassw0rd!xyz";
let NET = "", NET_B = "";
const U: Record<string, { token: string; id: string; username: string }> = {};
const D: Record<string, string> = {};
const T: Record<string, string> = {};
const N = { n1: "node_ow_1", n2: "node_ow_2", n3: "node_ow_3", b1: "node_ow_b1" };

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
async function rpc(token: string, method: string, params: unknown) {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const raw = await res.text();
  const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
  return line ? JSON.parse(line.slice(5)) : JSON.parse(raw);
}
const whoami = async (token: string) => JSON.parse((await rpc(token, "tools/call", { name: "org_whoami", arguments: {} })).result.content[0].text);
const toolNames = async (token: string) => ((await rpc(token, "tools/list", {})).result.tools as any[]).map(t => t.name);

async function addUser(owner: string, net: string, k: string, displayName?: string) {
  const username = `ow_${k}_${Date.now()}`;
  expect((await send(U[owner].token, "POST", "/api/admin/users", { username, password: PW, network_id: net, role: "member" })).status).toBe(200);
  const login = await send("", "POST", "/api/auth/login", { username, password: PW });
  U[k] = { token: login.body.token, id: login.body.user.user_id, username };
  db.run("UPDATE users SET display_name = ?1 WHERE user_id = ?2", [displayName ?? username, U[k].id]);
}
async function mkDept(owner: string, net: string, key: string, body: Record<string, unknown>) {
  const r = await send(U[owner].token, "POST", `/api/networks/${net}/departments`, body);
  expect(r.status).toBe(201);
  D[key] = r.body.department.id;
}
const putMember = async (owner: string, net: string, user: string, dept: string) =>
  expect((await send(U[owner].token, "PUT", `/api/networks/${net}/members/${U[user].id}/department`, { department_id: dept })).status).toBe(200);
const putNode = async (owner: string, net: string, node: string, dept: string) =>
  expect((await send(U[owner].token, "PUT", `/api/networks/${net}/nodes/${node}/department`, { department_id: dept })).status).toBe(200);
function nodeToken(owner: string, net: string, alias: string, id: string) {
  const t = createNetworkTokenForNode(U[owner].id, net, alias, id);
  expect(t.error ?? null).toBe(null);
  return t.token!;
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`ow_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id, username: "" };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const b = register(`ow_ownerb_${Date.now()}`, PW, undefined, "OwnerB");
  U.ownerB = { token: b.token!, id: b.user!.user_id, username: "" };
  NET_B = b.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.ownerB.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  await addUser("owner", NET, "headA", "研发负责人");
  await addUser("owner", NET, "headB", "前端负责人");
  await addUser("owner", NET, "member"); // 显示名 = 用户名 → 输出 ""
  await addUser("owner", NET, "loner", "独行者");
  await mkDept("owner", NET, "rd", { name: "研发", leader_user_id: U.headA.id });
  await mkDept("owner", NET, "fe", { name: "前端", parent_id: D.rd, leader_user_id: U.headB.id });
  await mkDept("owner", NET, "ops", { name: "运维" });
  await putMember("owner", NET, "owner", D.ops);
  await putMember("owner", NET, "member", D.fe);
  await putMember("owner", NET, "headB", D.fe);
  T.n1 = nodeToken("owner", NET, "示例节点一", N.n1);
  T.n2 = nodeToken("owner", NET, "示例节点二", N.n2);
  T.n3 = nodeToken("owner", NET, "示例节点三", N.n3);
  db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = ?2", [U.loner.id, N.n3]); // 新成员默认受限,建不了令牌:直接改主人
  await putNode("owner", NET, N.n1, D.fe);
  db.run("INSERT INTO sessions (resume_id, alias, network_id, status, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)", ["rs_ow_1", "示例节点一", NET, "idle", new Date().toISOString()]);

  // 网络 B:同一个部门 id、B 的人和 B 的节点放进去;同名会话标在线
  await addUser("ownerB", NET_B, "outsider", "外网成员");
  const rb = await send(U.ownerB.token, "POST", `/api/networks/${NET_B}/departments`, { id: D.fe, name: "前端" });
  expect(rb.status).toBe(201);
  await putMember("ownerB", NET_B, "outsider", D.fe);
  nodeToken("ownerB", NET_B, "外网节点", N.b1);
  await putNode("ownerB", NET_B, N.b1, D.fe);
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#752 org_whoami", () => {
  test("node with a department → department, ancestors, head (display name), members", async () => {
    const r = await whoami(T.n1);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("node");
    expect(r.department).toEqual({ id: D.fe, name: "前端" });
    expect(r.ancestors).toEqual([{ id: D.rd, name: "研发" }]);
    expect(r.head).toEqual({ user_id: U.headB.id, display_name: "前端负责人" });
    expect(r.humans.map((h: any) => h.user_id).sort()).toEqual([U.member.id, U.headB.id].sort());
    expect(r.humans.find((h: any) => h.user_id === U.member.id).display_name).toBe(""); // 用户名不当显示名
    expect(JSON.stringify(r)).not.toContain(U.member.username);
    expect(r.agents).toEqual([{ node_id: N.n1, alias: "示例节点一", online: true }]);
    expect(r.truncated).toBe(false);
  });

  test("a cross-network node / person in a same-id department is never listed", async () => {
    const text = JSON.stringify(await whoami(T.n1));
    expect(text).not.toContain(N.b1);
    expect(text).not.toContain(U.outsider.id);
    expect(text).not.toContain("外网");
  });

  test("node without a department → owner's department, source=owner", async () => {
    const r = await whoami(T.n2);
    expect(r.source).toBe("owner");
    expect(r.department).toEqual({ id: D.ops, name: "运维" });
    expect(r.ancestors).toEqual([]);
    expect(r.head).toBe(null);
    expect(r.humans.map((h: any) => h.user_id)).toEqual([U.owner.id]);
  });

  test("neither node nor owner in a department → source=none", async () => {
    expect(await whoami(T.n3)).toEqual({ ok: true, source: "none", department: null, ancestors: [], head: null, humans: [], agents: [], truncated: false });
  });

  test("audience: listed for node tokens only; a user token is refused with network_token_required", async () => {
    expect((await toolNames(T.n1)).includes("org_whoami")).toBe(true);
    expect((await toolNames(U.owner.token)).includes("org_whoami")).toBe(false);
    expect((await whoami(U.owner.token)).error).toBe("network_token_required");
  });

  test("members are capped at 50 with truncated", async () => {
    for (let i = 0; i < 50; i++) {
      const id = `node_ow_bulk_${i}`;
      db.run("INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?2, ?3, ?4)", [id, id, `bulk${String(i).padStart(2, "0")}`, NET]);
      db.run("INSERT INTO network_node_departments (network_id, node_id, department_id) VALUES (?1, ?2, ?3)", [NET, id, D.fe]);
    }
    const r = await whoami(T.n1);
    expect(r.humans.length + r.agents.length).toBe(50);
    expect(r.truncated).toBe(true);
  });
});
