// 多用户账号与 Agent 权限 —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 场景:Hub 管理员 admin 的网络 NET 里有 3 个 Agent(X、Y、Z)。admin 通过 POST /api/admin/users
// 建出 alice、bob 两个成员 —— 新成员默认 agent_access='granted',看不到任何 Agent。
// 每条面向 Agent 的路径都各测一次:受限成员拿到空 / 403,被授权后只看到 / 只能联系授权的那个。
// 末尾一组「不能被滥用」:猜 alias / node_id、订阅 SSE、下载文件、看日志、借网络令牌、塞别人的附件。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { hashToken, generateNetworkToken, generateId } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-acl-"));
let BASE = "";
let hub: any = null;

const PW = "AclTestPassw0rd!x";
let adminToken = "";
let adminId = "";
let NET = "";
let aliceToken = "";
let aliceId = "";
let aliceOwnNet = "";
let bobToken = "";
let bobId = "";
let adminFileId = "";

const X = { alias: "acl-agent-x", node: "node_acl_x" };
const Y = { alias: "acl-agent-y", node: "node_acl_y" };
const Z = { alias: "acl-agent-z", node: "node_acl_z" };

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), "Content-Type": "application/json" });

async function get(token: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: auth(token) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function send(token: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: json(token), body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...json(token), Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const dataLines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = dataLines.length ? JSON.parse(dataLines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}
async function login(username: string): Promise<{ token: string; userId: string }> {
  const r = await send("", "POST", "/api/auth/login", { username, password: PW });
  expect(r.status).toBe(200);
  return { token: r.body.token, userId: r.body.user.user_id };
}
const aliases = (rows: any[]) => rows.map((r: any) => r.alias).filter((a: any) => [X.alias, Y.alias, Z.alias].includes(a)).sort();
const grantsPath = (uid: string) => `/api/networks/${NET}/members/${uid}/agent-grants`;

function seedAgent(a: { alias: string; node: string }) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at) VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [a.node, a.alias, NET, adminId],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
    [`resume_${a.node}`, a.alias, a.node, NET],
  );
}
function seedTask(id: string, from: string, to: string, content: string, meta?: unknown) {
  const toNode = [X, Y, Z].find(a => a.alias === to)?.node ?? null;
  const fromNode = [X, Y, Z].find(a => a.alias === from)?.node ?? null;
  db.run(
    `INSERT INTO tasks (task_id, from_name, from_node_id, to_name, to_node_id, status, content, network_id, meta_json)
     VALUES (?1, ?2, ?3, ?4, ?5, 'replied', ?6, ?7, ?8)`,
    [id, from, fromNode, to, toNode, content, NET, meta === undefined ? null : JSON.stringify(meta)],
  );
  db.run(
    `INSERT INTO inbox (id, task_id, session_name, type, priority, content, from_session, network_id, meta_json)
     VALUES (?1, ?2, ?3, 'task', 'normal', ?4, ?5, ?6, ?7)`,
    [`ib_${id}`, id, to, content, from, NET, meta === undefined ? null : JSON.stringify(meta)],
  );
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const admin = register(`acl_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminId = admin.user!.user_id;
  NET = admin.network_id!;
  // 第一个注册的用户是 Hub 管理员;共享库里跑时不一定是第一个,显式设上。
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  for (const a of [X, Y, Z]) seedAgent(a);

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  // admin 在 NET 里的私有流量:任何受限成员都不该看见。
  seedTask("t_admin_to_x", admin.user!.username, X.alias, "admin secret for X");
  seedTask("t_admin_to_y", admin.user!.username, Y.alias, "admin secret for Y");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([7, 7, 7])], { type: "application/octet-stream" }), "secret.bin");
  const up = await fetch(`${BASE}/api/upload?network_id=${NET}`, { method: "POST", body: form, headers: auth(adminToken) });
  expect(up.status).toBe(200);
  adminFileId = (await up.json()).file_id;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("POST/GET /api/admin/users", () => {
  test("hub admin creates a restricted member in a network (no tokens handed to the admin)", async () => {
    const r = await send(adminToken, "POST", "/api/admin/users", { username: "acl_alice", password: PW, display_name: "Alice", network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.membership).toEqual({ network_id: NET, role: "member", agent_access: "granted" });
    expect(r.body.token).toBeUndefined();
    expect(r.body.network_token).toBeUndefined();
    const b = await send(adminToken, "POST", "/api/admin/users", { username: "acl_bob", password: PW, network_id: NET });
    expect(b.status).toBe(200);
    ({ token: aliceToken, userId: aliceId } = await login("acl_alice"));
    ({ token: bobToken, userId: bobId } = await login("acl_bob"));
    aliceOwnNet = db.get<{ network_id: string }>("SELECT network_id FROM networks WHERE owner_id = ?1", aliceId)!.network_id;
  });

  test("password rules are register()'s: < 8 chars and common passwords rejected", async () => {
    expect((await send(adminToken, "POST", "/api/admin/users", { username: "acl_short", password: "Ab1!" })).status).toBe(400);
    expect((await send(adminToken, "POST", "/api/admin/users", { username: "acl_common", password: "password" })).status).toBe(400);
  });

  test("username equal to an agent alias in the target network → 409, and the account is NOT created", async () => {
    const r = await send(adminToken, "POST", "/api/admin/users", { username: X.alias, password: PW, network_id: NET });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("username_collides_with_agent_alias");
    expect(db.get("SELECT 1 FROM users WHERE username = ?1", X.alias)).toBeNull();
  });

  test("non-admin cannot create users or list them; audit log records creation", async () => {
    expect((await send(aliceToken, "POST", "/api/admin/users", { username: "acl_evil", password: PW })).status).toBe(403);
    expect((await send(aliceToken, "POST", "/api/admin/users", { username: "acl_evil", password: PW, network_id: NET })).status).toBe(403);
    expect((await get(aliceToken, "/api/admin/users")).status).toBe(403);
    const list = await get(adminToken, "/api/admin/users");
    expect(list.status).toBe(200);
    const alice = list.body.users.find((u: any) => u.username === "acl_alice");
    expect(alice.networks.find((n: any) => n.network_id === NET)).toMatchObject({ role: "member", agent_access: "granted" });
    expect(alice.password_hash).toBeUndefined();
    expect(db.get("SELECT 1 FROM audit_log WHERE action = 'admin_user_created' AND target_id = ?1", aliceId)).toBeTruthy();
  });
});

describe("restricted member with NO grants sees no agents (one test per path)", () => {
  test("GET /api/status (explicit network and default scope)", async () => {
    const r = await get(aliceToken, `/api/status?network_id=${NET}`);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toEqual([]);
    expect((await get(aliceToken, "/api/status?light=1")).body.sessions.filter((s: any) => s.network_id === NET)).toEqual([]);
  });
  test("GET /api/nodes", async () => {
    expect((await get(aliceToken, `/api/nodes?network_id=${NET}`)).body.nodes).toEqual([]);
    expect((await get(aliceToken, `/api/nodes?node_id=${X.node}`)).body.nodes).toEqual([]);
  });
  test("GET /api/servers, /api/stats, /api/completions, /api/host-supervisors", async () => {
    expect((await get(aliceToken, `/api/servers?network_id=${NET}`)).body.servers ?? []).toEqual([]);
    const stats = await get(aliceToken, `/api/stats?network_id=${NET}`);
    expect(stats.body.nodes.total).toBe(0);
    expect(stats.body.recent_tasks).toEqual([]);
    expect((await get(aliceToken, `/api/completions?network_id=${NET}`)).body.completions).toEqual([]);
    const hs = await get(aliceToken, `/api/host-supervisors?network_id=${NET}`);
    expect(hs.body.daemons).toEqual([]);
  });
  test("GET /api/networks/:id stats count nothing", async () => {
    const r = await get(aliceToken, `/api/networks/${NET}`);
    expect(r.status).toBe(200);
    expect(r.body.stats.nodes).toBe(0);
    expect(r.body.stats.sessions).toBe(0);
    expect(r.body.stats.tasks).toEqual([]);
  });
  test("GET /api/tasks, /api/tasks/:id, /api/task_events, /api/messages hide other people's agent traffic", async () => {
    expect((await get(aliceToken, `/api/tasks?network_id=${NET}`)).body.tasks).toEqual([]);
    expect((await get(aliceToken, `/api/tasks/t_admin_to_x`)).status).toBe(404);
    expect((await get(aliceToken, `/api/task_events?task_id=t_admin_to_x`)).body.events).toEqual([]);
    expect((await get(aliceToken, `/api/messages?network_id=${NET}&since=2000-01-01`)).body.messages).toEqual([]);
    expect((await get(aliceToken, `/api/messages?alias=${X.alias}&since=2000-01-01`)).body.messages).toEqual([]);
  });
  test("POST /api/task to an agent → 403 agent_not_granted; nonexistent alias gets the identical response", async () => {
    const real = await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "hi", network_id: NET });
    const fake = await send(aliceToken, "POST", "/api/task", { alias: "no-such-agent", task: "hi", network_id: NET });
    expect(real.status).toBe(403);
    expect(real.body.error).toBe("agent_not_granted");
    expect(fake).toEqual(real);
  });
  test("POST /api/broadcast → 403", async () => {
    expect((await send(aliceToken, "POST", `/api/broadcast?network_id=${NET}`, { message: "hi" })).status).toBe(403);
  });
  test("node write endpoints (delete / config / attrs / avatar) → not found", async () => {
    expect((await send(aliceToken, "DELETE", `/api/nodes/${X.node}?network_id=${NET}`)).status).toBeGreaterThanOrEqual(403);
    expect((await get(aliceToken, `/api/nodes/${X.node}/config?network_id=${NET}`)).status).toBeGreaterThanOrEqual(403);
    expect((await send(aliceToken, "PUT", `/api/nodes/${X.node}/avatar?network_id=${NET}`, { avatar_url: null })).status).toBeGreaterThanOrEqual(403);
    expect(db.get("SELECT 1 FROM nodes WHERE node_id = ?1", X.node)).toBeTruthy();
  });
  test("MCP get_all_status / get_session_status / list_tasks / get_task", async () => {
    const all = await tool(aliceToken, "get_all_status", { network_id: NET });
    expect(all.sessions).toEqual([]);
    const one = await tool(aliceToken, "get_session_status", { alias: X.alias });
    expect(one.session ?? null).toBeNull();
    expect((await tool(aliceToken, "list_tasks", { network_id: NET })).tasks).toEqual([]);
    expect((await tool(aliceToken, "get_task", { task_id: "t_admin_to_x" })).ok).toBe(false);
  });
  test("MCP send_task / send_message → agent_not_granted", async () => {
    expect((await tool(aliceToken, "send_task", { alias: X.alias, task: "hi", network_id: NET })).error).toBe("agent_not_granted");
    expect((await tool(aliceToken, "send_message", { alias: X.alias, message: "hi", network_id: NET })).error).toBe("agent_not_granted");
  });
  test("MCP non-allowlisted agent tools → agent_access_restricted (with and without network_id)", async () => {
    for (const [name, args] of [
      ["tail_node_logs", { alias: X.alias, network_id: NET }],
      ["list_node_files", { alias: X.alias, network_id: NET }],
      ["broadcast", { message: "x", network_id: NET }],
      ["cancel_task", { task_id: "t_admin_to_x", network_id: NET }],
      ["tail_node_logs", { alias: X.alias }],
    ] as const) {
      expect((await tool(aliceToken, name, args as any)).error).toBe("agent_access_restricted");
    }
  });
  test("requirements people list: humans only, no nodes", async () => {
    const r = await get(aliceToken, `/api/requirements/people?network_id=${NET}`);
    expect(r.status).toBe(200);
    expect(r.body.people.filter((p: any) => p.kind === "node")).toEqual([]);
    expect(r.body.people.filter((p: any) => p.kind === "user").map((p: any) => p.id).sort()).toEqual([adminId, aliceId, bobId].sort());
  });
});

describe("humans: restricted members can still see and DM other humans", () => {
  test("GET /api/networks/:id/humans lists only people (for any member)", async () => {
    const r = await get(aliceToken, `/api/networks/${NET}/humans`);
    expect(r.status).toBe(200);
    expect(r.body.humans.map((h: any) => h.user_id).sort()).toEqual([adminId, aliceId, bobId].sort());
    expect(Object.keys(r.body.humans[0]).sort()).toEqual(["display_name", "user_id", "username"]);
    // 非成员拿不到。
    const outsider = register(`acl_out_${Date.now()}`, PW);
    expect((await get(outsider.token!, `/api/networks/${NET}/humans`)).status).toBe(403);
  });
  test("alice → bob send_desktop_message works; bob reads it from his user inbox", async () => {
    const r = await tool(aliceToken, "send_desktop_message", { to_username: "acl_bob", message: "hello bob", network_id: NET });
    expect(r.ok).toBe(true);
    const inbox = await get(bobToken, `/api/messages?scope=user&network_id=${NET}`);
    expect(inbox.body.messages.map((m: any) => m.content)).toContain("hello bob");
    expect(inbox.body.messages.find((m: any) => m.content === "hello bob").from_session).toBe("acl_alice");
  });
  test("a restricted member cannot DM under someone else's name", async () => {
    const r = await tool(aliceToken, "send_desktop_message", { to_username: "acl_bob", message: "spoof", from_session: X.alias, network_id: NET });
    expect(r.error).toBe("from_session_identity_mismatch");
  });
});

describe("grant API", () => {
  test("only network owner/admin (or hub admin) can read or change grants", async () => {
    expect((await get(aliceToken, grantsPath(aliceId))).status).toBe(403);
    expect((await send(aliceToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: X.node }] })).status).toBe(403);
    expect((await send(bobToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: X.node }] })).status).toBe(403);
    const r = await get(adminToken, grantsPath(aliceId));
    expect(r.body).toMatchObject({ ok: true, agent_access: "granted", restricted: true, grants: [] });
  });
  test("unknown / foreign node ids are rejected whole-batch", async () => {
    const r = await send(adminToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: X.node }, { node_id: "node_not_here" }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("agent_not_in_network");
    expect((await get(adminToken, grantsPath(aliceId))).body.grants).toEqual([]);
  });
  test("admin grants alice X (can message) and Y (read-only); audited", async () => {
    const r = await send(adminToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: X.node }, { node_id: Y.node, can_message: false }] });
    expect(r.status).toBe(200);
    expect(r.body.grants).toEqual([
      { node_id: X.node, alias: null, can_message: true },
      { node_id: Y.node, alias: null, can_message: false },
    ]);
    expect(db.get("SELECT 1 FROM audit_log WHERE action = 'member_agent_grants_changed' AND target_id = ?1", NET)).toBeTruthy();
  });
});

describe("granted member sees and messages ONLY what was granted", () => {
  test("/api/status and /api/nodes show X and Y, never Z", async () => {
    expect(aliases((await get(aliceToken, `/api/status?network_id=${NET}`)).body.sessions)).toEqual([X.alias, Y.alias]);
    expect(aliases((await get(aliceToken, `/api/nodes?network_id=${NET}`)).body.nodes)).toEqual([X.alias, Y.alias]);
    expect((await get(aliceToken, `/api/nodes?node_id=${Z.node}`)).body.nodes).toEqual([]);
  });
  test("MCP get_all_status shows X and Y only; summary counts only them", async () => {
    const r = await tool(aliceToken, "get_all_status", { network_id: NET });
    expect(aliases(r.sessions)).toEqual([X.alias, Y.alias]);
    expect(r.summary.reduce((n: number, s: any) => n + s.count, 0)).toBe(2);
  });
  test("REST send to X works and is recorded as alice; Y is read-only; Z is not granted", async () => {
    const ok = await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "hello X", network_id: NET });
    expect(ok.status).toBe(200);
    const row = db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE to_name = ?1 AND content = 'hello X'", X.alias);
    expect(row?.from_name).toBe("acl_alice");
    expect((await send(aliceToken, "POST", "/api/task", { alias: Y.alias, task: "hi", network_id: NET })).body.error).toBe("agent_not_granted");
    expect((await send(aliceToken, "POST", "/api/task", { alias: Z.alias, task: "hi", network_id: NET })).body.error).toBe("agent_not_granted");
  });
  test("MCP send_task to X works; to Z fails", async () => {
    expect((await tool(aliceToken, "send_task", { alias: X.alias, task: "mcp hello X", network_id: NET })).ok).toBe(true);
    expect((await tool(aliceToken, "send_task", { alias: Z.alias, task: "hi", network_id: NET })).error).toBe("agent_not_granted");
  });
  test("tasks: alice sees her own exchange with X, not admin's", async () => {
    seedTask("t_x_to_alice", X.alias, "acl_alice", "X answers alice");
    const ids = (await get(aliceToken, `/api/tasks?network_id=${NET}`)).body.tasks.map((t: any) => t.content).sort();
    expect(ids).toEqual(["X answers alice", "hello X", "mcp hello X"].sort());
    expect((await get(aliceToken, `/api/tasks/t_admin_to_x`)).status).toBe(404);
    expect((await get(aliceToken, `/api/tasks/t_x_to_alice`)).status).toBe(200);
    expect((await tool(aliceToken, "list_tasks", { network_id: NET })).tasks.map((t: any) => t.content)).not.toContain("admin secret for X");
  });
  test("requirements people now include X and Y nodes but not Z", async () => {
    const nodes = (await get(aliceToken, `/api/requirements/people?network_id=${NET}`)).body.people.filter((p: any) => p.kind === "node").map((p: any) => p.id).sort();
    expect(nodes).toEqual([X.node, Y.node].sort());
  });
  test("owner / hub admin are unaffected: admin still sees all three", async () => {
    expect(aliases((await get(adminToken, `/api/status?network_id=${NET}`)).body.sessions)).toEqual([X.alias, Y.alias, Z.alias]);
  });
  test("bob (no grants) still sees nothing", async () => {
    expect((await get(bobToken, `/api/status?network_id=${NET}`)).body.sessions).toEqual([]);
  });
});

describe("requirements: agent references alice cannot see are hidden and protected", () => {
  let reqId = "";
  test("a card owned by Z shows agent_owner=null to alice, Z to admin", async () => {
    const c = await send(adminToken, "POST", "/api/requirements", { name: "card", network_id: NET, agent_owner: { kind: "node", id: Z.node }, participants: [{ kind: "node", id: Z.node }, { kind: "user", id: aliceId }] });
    expect(c.status).toBe(201);
    reqId = c.body.requirement.id;
    const mine = await get(aliceToken, `/api/requirements/${reqId}?network_id=${NET}`);
    expect(mine.body.requirement.agent_owner).toBeNull();
    expect(mine.body.requirement.participants).toEqual([{ kind: "user", id: aliceId }]);
    expect((await get(adminToken, `/api/requirements/${reqId}`)).body.requirement.agent_owner).toEqual({ kind: "node", id: Z.node });
  });
  test("alice cannot reassign or clear the hidden agent owner, nor assign an ungranted node", async () => {
    expect((await send(aliceToken, "PATCH", `/api/requirements/${reqId}?network_id=${NET}`, { agent_owner: null })).body.error).toBe("agent_owner_not_granted");
    const c = await send(aliceToken, "POST", "/api/requirements", { name: "mine", network_id: NET, agent_owner: { kind: "node", id: Z.node } });
    expect(c.body.error).toBe("person_not_in_network");
  });
  test("saving participants keeps the hidden Z participant", async () => {
    const r = await send(aliceToken, "PATCH", `/api/requirements/${reqId}?network_id=${NET}`, { participants: [{ kind: "user", id: aliceId }, { kind: "node", id: X.node }] });
    expect(r.status).toBe(200);
    const stored = JSON.parse(db.get<{ participants_json: string }>("SELECT participants_json FROM requirements WHERE requirement_id = ?1", reqId)!.participants_json);
    expect(stored).toContainEqual({ kind: "node", id: Z.node });
    expect(stored).toContainEqual({ kind: "node", id: X.node });
  });
  test("filtering the board by a hidden agent owner returns nothing", async () => {
    const r = await get(aliceToken, `/api/requirements?network_id=${NET}&agent_owner=node:${Z.node}`);
    expect(r.body.requirements).toEqual([]);
  });
  test("q= does not match on a hidden agent's name (no 'who owns this card' probe); admin's q= does", async () => {
    const zName = db.get<{ name: string }>("SELECT COALESCE(NULLIF(display_name,''), NULLIF(alias,''), node_name) AS name FROM nodes WHERE node_id = ?1", Z.node)!.name;
    const ids = async (token: string, q: string) => (await get(token, `/api/requirements?network_id=${NET}&q=${encodeURIComponent(q)}`)).body.requirements.map((r: any) => r.id);
    expect(await ids(aliceToken, zName)).not.toContain(reqId);
    expect(await ids(adminToken, zName)).toContain(reqId);
    // 看得见的字段照样能搜到(标题)
    expect(await ids(aliceToken, "card")).toContain(reqId);
  });
});

describe("cannot be abused", () => {
  test("guessing node ids / aliases on every read path returns the same empty result", async () => {
    for (const ref of [Z.alias, Z.node, "does-not-exist"]) {
      expect((await get(aliceToken, `/api/nodes?alias=${ref}`)).body.nodes).toEqual([]);
      expect((await get(aliceToken, `/api/nodes?node_id=${ref}`)).body.nodes).toEqual([]);
    }
    expect((await tool(aliceToken, "get_all_status", { network_id: NET, filter_alias: Z.alias })).sessions).toEqual([]);
  });
  test("SSE: agent channels are refused even for a granted agent; own channel is fine", async () => {
    for (const alias of [Z.alias, X.alias]) {
      const r = await fetch(`${BASE}/events/${encodeURIComponent(alias)}?network_id=${NET}`, { headers: auth(aliceToken) });
      expect(r.status).toBe(403);
      await r.body?.cancel();
    }
    const ctrl = new AbortController();
    const own = await fetch(`${BASE}/events/acl_alice?network_id=${NET}`, { headers: auth(aliceToken), signal: ctrl.signal });
    expect(own.status).toBe(200);
    ctrl.abort();
  });
  test("SSE network observer stream only carries events alice is part of", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/events/network/${NET}`, { headers: auth(aliceToken), signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // 一次只挂一个 read():超时放弃的那个 read 仍在排队,下一轮必须接着等它,否则它拿走的块就丢了。
    let pending: ReturnType<typeof reader.read> | null = null;
    const readFor = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const chunk = await Promise.race([pending, new Promise<null>(r => setTimeout(() => r(null), until - Date.now()))]);
        if (!chunk) break;
        pending = null;
        if (chunk.done) break;
        buf += decoder.decode(chunk.value);
      }
    };
    await readFor(150);
    // admin → Z:alice 不该收到任何路由事件。
    expect((await send(adminToken, "POST", "/api/task", { alias: Z.alias, task: "admin to Z", network_id: NET })).status).toBe(200);
    // alice → X:她自己的,应当收到。
    expect((await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "alice to X again", network_id: NET })).status).toBe(200);
    await readFor(400);
    ctrl.abort();
    const events = buf.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)));
    expect(events.some(e => e.type === "new_task" && e.to === X.alias && e.from === "acl_alice")).toBe(true);
    expect(events.some(e => e.to === Z.alias)).toBe(false);
  });
  test("/health SSE topology omits the restricted network", async () => {
    const ctrl = new AbortController();
    const sub = await fetch(`${BASE}/events/${Z.alias}?network_id=${NET}`, { headers: auth(adminToken), signal: ctrl.signal });
    expect(sub.status).toBe(200);
    const h = await get(aliceToken, "/health");
    ctrl.abort();
    expect(JSON.stringify(h.body.sse_sessions ?? {})).not.toContain(NET);
  });
  test("files: admin's upload in the network is 404 for alice; smuggling its id as an attachment is refused", async () => {
    const r = await fetch(`${BASE}/api/files/${adminFileId}`, { headers: auth(aliceToken) });
    expect(r.status).toBe(404);
    const t = await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "read this", network_id: NET, attachments: [{ type: "file", file_id: adminFileId }] });
    expect(t.status).toBe(403);
    expect(t.body.error).toBe("attachment_not_accessible");
    const m = await tool(aliceToken, "send_task", { alias: X.alias, task: "read", network_id: NET, meta: { attachments: [{ type: "file", file_id: adminFileId }] } });
    expect(m.error).toBe("attachment_not_accessible");
    expect((await fetch(`${BASE}/api/files/${adminFileId}`, { headers: auth(aliceToken) })).status).toBe(404);
  });
  test("files: a file X sends TO alice becomes downloadable for her", async () => {
    seedTask("t_x_file_to_alice", X.alias, "acl_alice", "here is a file", { attachments: [{ type: "file", file_id: adminFileId }] });
    expect((await fetch(`${BASE}/api/files/${adminFileId}`, { headers: auth(aliceToken) })).status).toBe(200);
    db.run("DELETE FROM tasks WHERE task_id = 't_x_file_to_alice'");
    db.run("DELETE FROM inbox WHERE task_id = 't_x_file_to_alice'");
  });
  test("logs / files / rules via MCP are refused", async () => {
    expect((await tool(aliceToken, "tail_node_logs", { alias: X.alias, network_id: NET })).error).toBe("agent_access_restricted");
    expect((await tool(aliceToken, "read_node_rules_file", { alias: X.alias, network_id: NET })).error).toBe("agent_access_restricted");
  });
  test("no network tokens: node-token / tokens endpoints refuse, and an old ntok stops resolving once restricted", async () => {
    expect((await send(aliceToken, "POST", "/api/auth/node-token", { network_id: NET, node_name: "alice-node" })).body.ok).toBe(false);
    expect((await send(aliceToken, "POST", "/api/auth/tokens", { name: "x", network_id: NET })).body.ok).toBe(false);
    // 一个在「受限」之前签发的网络令牌:
    const ntok = generateNetworkToken();
    db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, 'legacy', 'network')", [generateId("tok"), hashToken(ntok), aliceId, NET]);
    expect((await get(ntok, `/api/status`)).status).toBe(401);
    const res = await fetch(`${BASE}/events/${Z.alias}?network_id=${NET}`, { headers: auth(ntok) });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
  test("renaming an agent is refused", async () => {
    const r = await send(aliceToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: X.alias, new_alias: "stolen" });
    expect(r.body.ok).toBe(false);
  });
  test("from spoofing on REST send is refused", async () => {
    const r = await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "spoof", network_id: NET, from: "admin-name" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("from_session_identity_mismatch");
  });
});

describe("lifecycle", () => {
  test("agent_access=all lifts the restriction (legacy member); back to granted restores it", async () => {
    expect((await send(adminToken, "PUT", grantsPath(bobId), { agent_access: "all" })).body.restricted).toBe(false);
    expect(aliases((await get(bobToken, `/api/status?network_id=${NET}`)).body.sessions)).toEqual([X.alias, Y.alias, Z.alias]);
    expect((await send(adminToken, "PUT", grantsPath(bobId), { agent_access: "granted" })).body.restricted).toBe(true);
    expect((await get(bobToken, `/api/status?network_id=${NET}`)).body.sessions).toEqual([]);
  });
  test("revoking a grant takes effect on the next request", async () => {
    expect((await send(adminToken, "PUT", grantsPath(aliceId), { grants: [] })).status).toBe(200);
    expect((await get(aliceToken, `/api/status?network_id=${NET}`)).body.sessions).toEqual([]);
    expect((await send(aliceToken, "POST", "/api/task", { alias: X.alias, task: "again", network_id: NET })).body.error).toBe("agent_not_granted");
  });
  test("removing a member drops their grants; re-adding starts from zero", async () => {
    await send(adminToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: X.node }] });
    expect((await send(adminToken, "DELETE", `/api/networks/${NET}/members/${aliceId}`)).status).toBe(200);
    expect(db.get("SELECT 1 FROM network_member_agent_grants WHERE user_id = ?1", aliceId)).toBeNull();
    expect((await send(adminToken, "POST", `/api/networks/${NET}/members`, { user_id: aliceId, role: "member" })).status).toBe(200);
    expect((await get(adminToken, grantsPath(aliceId))).body).toMatchObject({ agent_access: "granted", grants: [] });
  });
  test("joining by invite code lands restricted and mints no network token", async () => {
    const inv = await send(adminToken, "POST", `/api/networks/${NET}/invite`, { role: "member" });
    const carol = register(`acl_carol_${Date.now()}`, PW);
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?1 AND network_id = ?2", carol.user!.user_id, NET)!.n;
    const j = await send(carol.token!, "POST", "/api/networks/join", { invite_code: inv.body.invite_code });
    expect(j.status).toBe(200);
    expect((await get(carol.token!, `/api/status?network_id=${NET}`)).body.sessions).toEqual([]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?1 AND network_id = ?2", carol.user!.user_id, NET)!.n).toBe(before);
  });
  test("existing members from before the upgrade keep full access (column default 'all')", async () => {
    const dave = register(`acl_dave_${Date.now()}`, PW);
    db.run("INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'member')", [NET, dave.user!.user_id]);
    expect(aliases((await get(dave.token!, `/api/status?network_id=${NET}`)).body.sessions)).toEqual([X.alias, Y.alias, Z.alias]);
  });
  test("alice still sees her own personal network normally", async () => {
    const r = await get(aliceToken, `/api/status?network_id=${aliceOwnNet}`);
    expect(r.status).toBe(200);
  });
});
