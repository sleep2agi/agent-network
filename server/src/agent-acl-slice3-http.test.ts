// 多用户账号与 Agent 权限 —— slice 3:剩下的面向 Agent 的路径。
//
// slice 1(agent-acl-http.test.ts)把默认作用域做成 fail-closed,并对核心路径逐条放行。
// 这里补:授权后 task_events / messages 的「只看自己往来」、改名广播不外泄 alias、
// 排程在建的人被收权后不再代派、用户名与后注册的 Agent alias 撞名、以及
// rules / skills / files / logs 对受限成员(即使授权了)仍然拒绝 —— 这是一个明确的产品决定:
// 授权 = 能看见、能对话;不等于能管理这个 Agent。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, addNetworkMember } from "./auth.js";
import { db } from "./db.js";
import { replaceAgentGrants } from "./agent-access.js";
import { dispatchScheduledOccurrence } from "./scheduled-tasks.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-acl3-"));
let BASE = "";
let hub: any = null;
const PW = "AclSlice3Passw0rd!";
let adminToken = "", adminId = "", adminName = "", NET = "";
let carolToken = "", carolId = "";

const X = { alias: "acl3-agent-x", node: "node_acl3_x" };
const Z = { alias: "acl3-agent-z", node: "node_acl3_z" };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function get(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: auth(token) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...auth(token), "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = payload.result.content[0].text;
  // 参数没过 zod 的调用根本没进到处理函数(也就没进到权限判定),当成测试写错了而不是「被拒」。
  if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
function seedAgent(a: { alias: string; node: string }) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [a.node, a.alias, NET, adminId]);
  db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at) VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`, [`r_${a.node}`, a.alias, a.node, NET]);
}
function seedTask(id: string, from: string, to: string, content: string) {
  db.run(`INSERT INTO tasks (task_id, from_name, to_name, status, content, network_id) VALUES (?1, ?2, ?3, 'replied', ?4, ?5)`, [id, from, to, content, NET]);
  db.run(`INSERT INTO inbox (id, task_id, session_name, type, priority, content, from_session, network_id) VALUES (?1, ?2, ?3, 'task', 'normal', ?4, ?5, ?6)`, [`ib_${id}`, id, to, content, from, NET]);
  db.run(`INSERT INTO task_events (task_id, to_status, actor, network_id) VALUES (?1, 'replied', 'test', ?2)`, [id, NET]);
}
async function openStream(path: string, token: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}${path}`, { headers: auth(token), signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
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
  return { status: res.status, readFor, events: () => buf.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))), close: () => ctrl.abort() };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  adminName = `acl3_admin_${Date.now()}`;
  const admin = register(adminName, PW);
  adminToken = admin.token!; adminId = admin.user!.user_id; NET = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  seedAgent(X); seedAgent(Z);
  const carol = register("acl3_carol", PW);
  carolToken = carol.token!; carolId = carol.user!.user_id;
  expect(addNetworkMember(NET, carolId, "member", adminId).ok).toBe(true);
  expect(replaceAgentGrants({ networkId: NET, userId: carolId, grants: [{ node_id: X.node }], actorUserId: adminId }).ok).toBe(true);
  seedTask("t3_admin_x", adminName, X.alias, "admin to X");
  seedTask("t3_carol_x", "acl3_carol", X.alias, "carol to X");
  seedTask("t3_x_carol", X.alias, "acl3_carol", "X to carol");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("granted member: task_events and messages are limited to own traffic", () => {
  test("task_events: own exchange with X visible, admin's task to X not", async () => {
    const mine = await get(carolToken, `/api/task_events?task_id=t3_carol_x`);
    expect(mine.body.events.length).toBe(1);
    expect((await get(carolToken, `/api/task_events?task_id=t3_x_carol`)).body.events.length).toBe(1);
    expect((await get(carolToken, `/api/task_events?task_id=t3_admin_x`)).body.events).toEqual([]);
    const all = await get(carolToken, `/api/task_events?network_id=${NET}`);
    expect(all.body.events.map((e: any) => e.task_id).sort()).toEqual(["t3_carol_x", "t3_x_carol"]);
  });
  test("messages (alias branch): own inbox rows with X only; admin's never", async () => {
    const r = await get(carolToken, `/api/messages?network_id=${NET}&since=2000-01-01`);
    expect(r.body.messages.map((m: any) => m.content).sort()).toEqual(["X to carol", "carol to X"].sort());
    const x = await get(carolToken, `/api/messages?alias=${X.alias}&since=2000-01-01`);
    expect(x.body.messages.map((m: any) => m.content)).toEqual(["carol to X"]);
    expect(x.body.pending_count).toBe(1);
  });
});

describe("decision: granted ≠ administer — rules / skills / files / logs / config stay refused", () => {
  test("every read and write admin op on the GRANTED agent is refused", async () => {
    for (const [name, args] of [
      ["read_node_rules_file", { alias: X.alias, network_id: NET }],
      ["write_node_rules_file", { alias: X.alias, content: "x", network_id: NET }],
      ["list_node_skills", { alias: X.alias, network_id: NET }],
      ["list_node_files", { alias: X.alias, network_id: NET }],
      ["tail_node_logs", { alias: X.alias, network_id: NET }],
      ["update_node_config", { node_id: X.node, base_revision: 0, patch: { model: "m" }, network_id: NET }],
      ["restart_node", { node_id: X.node, network_id: NET }],
    ] as const) {
      expect((await tool(carolToken, name, args as any)).error).toBe("agent_access_restricted");
    }
    expect((await send(carolToken, "PUT", `/api/nodes/${X.node}/attrs?network_id=${NET}`, { display_name: "pwned" })).status).toBeGreaterThanOrEqual(403);
    expect(db.get<{ display_name: string | null }>("SELECT display_name FROM nodes WHERE node_id = ?1", X.node)?.display_name ?? null).toBeNull();
  });
});

describe("rename broadcast does not leak aliases to restricted members", () => {
  test("renaming Z (not granted) sends nothing to carol; renaming X (granted) does", async () => {
    const s = await openStream(`/events/acl3_carol?network_id=${NET}`, carolToken);
    expect(s.status).toBe(200);
    await s.readFor(100);
    const renameTo = async (oldAlias: string, newAlias: string) => {
      const p = await send(adminToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: oldAlias, new_alias: newAlias });
      expect(p.body.ok).toBe(true);
      expect((await send(adminToken, "POST", "/api/node-rename/commit", { txn_id: p.body.txn_id })).body.ok).toBe(true);
    };
    await renameTo(Z.alias, "acl3-agent-z2");
    await renameTo(X.alias, "acl3-agent-x2");
    await s.readFor(400);
    s.close();
    const renamed = s.events().filter(e => e.type === "node.renamed").map(e => e.data.new_alias);
    expect(renamed).toEqual(["acl3-agent-x2"]);
    // 改名后授权(按 node_id)仍然有效。
    expect((await get(carolToken, `/api/status?network_id=${NET}`)).body.sessions.map((r: any) => r.alias)).toEqual(["acl3-agent-x2"]);
    await renameTo("acl3-agent-z2", Z.alias);
    await renameTo("acl3-agent-x2", X.alias);
  });
});

describe("schedules created before a restriction stop dispatching", () => {
  function schedule(createdBy: string, target: { alias: string; node: string }) {
    const id = `sched_acl3_${createdBy}_${target.node}`;
    db.run(
      `INSERT INTO scheduled_tasks (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, schedule_type, schedule_json, next_run_at)
       VALUES (?1, ?2, ?3, 'n', ?4, ?5, 'scheduled work', 'interval', '{"type":"interval","minutes":60}', datetime('now'))`,
      [id, NET, createdBy, target.node, target.alias],
    );
    return db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", id);
  }
  test("carol (restricted) → Z (not granted): run fails creator_access_revoked, no task created", () => {
    const row = schedule(carolId, Z);
    const r = dispatchScheduledOccurrence(row, new Date().toISOString(), false);
    expect(r.status).toBe("failed");
    expect(r.taskId).toBeUndefined();
    expect(db.get<{ error_code: string }>("SELECT error_code FROM scheduled_task_runs WHERE run_id = ?1", r.runId)?.error_code).toBe("creator_access_revoked");
  });
  test("carol → X (granted, can_message): dispatches", () => {
    const r = dispatchScheduledOccurrence(schedule(carolId, X), new Date(Date.now() + 1000).toISOString(), false);
    expect(r.taskId).toBeTruthy();
  });
  test("owner-created schedules are unaffected", () => {
    const r = dispatchScheduledOccurrence(schedule(adminId, Z), new Date(Date.now() + 2000).toISOString(), false);
    expect(r.taskId).toBeTruthy();
  });
});

describe("username collides with an agent alias registered later", () => {
  test("carol's own channel and own traffic close for that network", async () => {
    expect((await get(carolToken, `/api/tasks?network_id=${NET}`)).body.tasks.length).toBeGreaterThan(0);
    db.run(`INSERT INTO sessions (resume_id, alias, status, network_id, updated_at, last_seen_at) VALUES ('r_collide', 'acl3_carol', 'idle', ?1, datetime('now'), datetime('now'))`, [NET]);
    const s = await fetch(`${BASE}/events/acl3_carol?network_id=${NET}`, { headers: auth(carolToken) });
    expect(s.status).toBe(403);
    await s.body?.cancel();
    expect((await get(carolToken, `/api/tasks?network_id=${NET}`)).body.tasks).toEqual([]);
    expect((await get(carolToken, `/api/messages?network_id=${NET}&since=2000-01-01`)).body.messages).toEqual([]);
    db.run("DELETE FROM sessions WHERE resume_id = 'r_collide'");
    expect((await get(carolToken, `/api/tasks?network_id=${NET}`)).body.tasks.length).toBeGreaterThan(0);
  });
});

describe("human ↔ human DM (/api/dm): restricted members can talk to people", () => {
  let daveToken = "", daveId = "";
  test("carol (restricted) DMs dave; dave sees it in thread + threads + user inbox and replies", async () => {
    const dave = register("acl3_dave", PW);
    daveToken = dave.token!; daveId = dave.user!.user_id;
    expect(addNetworkMember(NET, daveId, "member", adminId).ok).toBe(true);
    const sent = await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: daveId, message: "hi dave", client_request_id: "c1" });
    expect(sent.status).toBe(200);
    expect(sent.body.message.sender_user_id).toBe(carolId);
    // 重试同一个气泡不产生第二条。
    expect((await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: daveId, message: "hi dave", client_request_id: "c1" })).body.message.message_id).toBe(sent.body.message.message_id);
    const threads = await get(daveToken, `/api/dm/threads?network_id=${NET}`);
    expect(threads.body.threads).toEqual([expect.objectContaining({ other_user_id: carolId, unread: 1 })]);
    expect((await get(daveToken, `/api/messages?scope=user&network_id=${NET}`)).body.messages.map((m: any) => m.content)).toContain("hi dave");
    expect((await send(daveToken, "POST", "/api/dm", { network_id: NET, to_username: "acl3_carol", message: "hi carol" })).status).toBe(200);
    const thread = await get(carolToken, `/api/dm?network_id=${NET}&with=${daveId}`);
    expect(thread.body.messages.map((m: any) => [m.direction, m.content])).toEqual([["in", "hi carol"], ["out", "hi dave"]]);
    const daveThread = await get(daveToken, `/api/dm?network_id=${NET}&with=${carolId}`);
    expect(daveThread.body.messages.map((m: any) => m.direction)).toEqual(["out", "in"]);
  });
  test("sender identity comes from the token, not from the body", async () => {
    await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: daveId, message: "who am i", from: adminName, sender_user_id: adminId });
    const row = db.get<{ sender_user_id: string; from_session: string }>("SELECT sender_user_id, from_session FROM user_inbox WHERE content = 'who am i'");
    expect(row).toEqual({ sender_user_id: carolId, from_session: "acl3_carol" });
  });
  test("a third party cannot read someone else's thread", async () => {
    const eve = register("acl3_eve", PW);
    expect(addNetworkMember(NET, eve.user!.user_id, "member", adminId).ok).toBe(true);
    // eve 查「她和 dave」的会话:空(carol↔dave 的不会出现)。
    expect((await get(eve.token!, `/api/dm?network_id=${NET}&with=${daveId}`)).body.messages).toEqual([]);
    expect((await get(eve.token!, `/api/dm/threads?network_id=${NET}`)).body.threads).toEqual([]);
  });
  test("non-members and outsiders are refused; unknown and outside users look the same", async () => {
    const out = register("acl3_out", PW);
    expect((await send(out.token!, "POST", "/api/dm", { network_id: NET, to_user_id: daveId, message: "x" })).status).toBe(403);
    expect((await get(out.token!, `/api/dm/threads?network_id=${NET}`)).status).toBe(403);
    const a = await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: out.user!.user_id, message: "x" });
    const b = await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: "u_nobody", message: "x" });
    expect(a).toEqual(b);
    expect(a.status).toBe(404);
  });
  test("a restricted member cannot smuggle a file they cannot see into a DM", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "a.bin");
    const up = await fetch(`${BASE}/api/upload?network_id=${NET}`, { method: "POST", body: form, headers: auth(adminToken) });
    const fid = (await up.json()).file_id;
    const r = await send(carolToken, "POST", "/api/dm", { network_id: NET, to_user_id: daveId, message: "f", attachments: [{ type: "file", file_id: fid }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("attachment_not_accessible");
    // 管理员(不受限)可以附带本网络文件发给 carol;carol 因此能下载它。
    expect((await send(adminToken, "POST", "/api/dm", { network_id: NET, to_user_id: carolId, message: "file for you", attachments: [{ type: "file", file_id: fid }] })).status).toBe(200);
    expect((await fetch(`${BASE}/api/files/${fid}`, { headers: auth(carolToken) })).status).toBe(200);
  });
  test("node tokens cannot use the DM API", async () => {
    const r = await fetch(`${BASE}/api/dm/threads?network_id=${NET}`, { headers: { Authorization: "Bearer ntok_x" } });
    expect(r.status).toBeGreaterThanOrEqual(401);
  });
});
