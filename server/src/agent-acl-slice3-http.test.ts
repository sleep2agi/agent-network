// 多用户账号与 Agent 权限 —— slice 3:剩下的面向 Agent 的路径。
//
// slice 1(agent-acl-http.test.ts)把默认作用域做成 fail-closed,并对核心路径逐条放行。
// 这里补:授权后 task_events 跟随授权 Agent 的时间线(#563)、messages 的「只看自己往来」、改名广播不外泄 alias、
// 排程在建的人被收权后不再代派、用户名与后注册的 Agent alias 撞名、以及
// rules / skills / files / logs 对受限成员(即使授权了)仍然拒绝 —— 这是一个明确的产品决定:
// 授权 = 能看见、能对话;不等于能管理这个 Agent。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, addNetworkMember, createNetworkTokenForNode } from "./auth.js";
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

describe("granted member: task_events follow X's timeline (#563); messages stay own traffic", () => {
  test("task_events: every task on granted X's timeline is visible, including admin's (#563)", async () => {
    const mine = await get(carolToken, `/api/task_events?task_id=t3_carol_x`);
    expect(mine.body.events.length).toBe(1);
    expect((await get(carolToken, `/api/task_events?task_id=t3_x_carol`)).body.events.length).toBe(1);
    expect((await get(carolToken, `/api/task_events?task_id=t3_admin_x`)).body.events.length).toBe(1);
    const all = await get(carolToken, `/api/task_events?network_id=${NET}`);
    expect(all.body.events.map((e: any) => e.task_id).sort()).toEqual(["t3_admin_x", "t3_carol_x", "t3_x_carol"]);
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
    // 2026-10-31 —— **顺序承载语义**的行为对照（#3214）。
    // `/api/messages` 在 server.ts 里有两处：:5581 是 `?scope=user`，:5648 是通用（inbox，按 Agent）。
    // 若有人把通用分支挪到前面，这一句带 scope 的请求会被它吃掉 —— 而响应仍是合法 200，
    // 只是形状从 user_inbox 变成 inbox。两组断言必须同时在场，才能把这件事钉住。
    const withScope = await get(daveToken, `/api/messages?scope=user&network_id=${NET}`);
    const withoutScope = await get(daveToken, `/api/messages?network_id=${NET}`);
    // user 视角：来自 user_inbox，字段是 message_id / acked_at
    expect(withScope.body.messages[0]).toHaveProperty("message_id");
    // 通用视角：来自 inbox，字段是 id / to_alias / from_alias
    expect(withoutScope.body.messages[0] ?? {}).not.toHaveProperty("message_id");
    expect(withScope.body.messages.map((m: any) => m.content)).toContain("hi dave");
    expect((withoutScope.body.messages ?? []).map((m: any) => m.content)).not.toContain("hi dave");
    expect((await send(daveToken, "POST", "/api/dm", { network_id: NET, to_username: "acl3_carol", message: "hi carol" })).status).toBe(200);
    const thread = await get(carolToken, `/api/dm?network_id=${NET}&with=${daveId}`);
    expect(thread.body.messages.map((m: any) => [m.direction, m.content])).toEqual([["in", "hi carol"], ["out", "hi dave"]]);
    // 私信不进按 Agent 的未读(发信人不是 Agent)。
    const inbox = await get(daveToken, `/api/messages?scope=user&network_id=${NET}`);
    expect(inbox.body.unread_by_agent["acl3_carol"]).toBeUndefined();
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

// 响应体是契约：update_node_config 的成功体被客户端按字段名读取，
// 任何「多加一栏」都应当是一次**有意识的**决定，而不是顺手。
// 这条测试钉住当前的键集（顺序无关，sorted 后比较），
// 让下一次加字段必须先让它变红、再明确决定要不要更新契约。
describe("update_node_config 响应键集（exact key set）", () => {
  test("成功体恰好 {apply_mode, ok, update_id}，不多不少", async () => {
    const r = await tool(adminToken, "update_node_config", {
      node_id: X.node, base_revision: 0, patch: { model: "exact-keys-model" }, network_id: NET,
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["apply_mode", "ok", "update_id"]);
  });

  test("在途冲突恰好 {age_ms, error, existing_update_id, ok}", async () => {
    const r = await tool(adminToken, "update_node_config", {
      node_id: X.node, base_revision: 0, patch: { model: "again" }, network_id: NET,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("update_in_flight");
    expect(Object.keys(r).sort()).toEqual(["age_ms", "error", "existing_update_id", "ok"]);
  });

  // 2026-10-31 —— 「意图」与「能力」两份不一致时，冲突必须被说出来。
  // 否则 restart_supervised=true 会被读成「已验证」，而观测说没人拉它。
  test("declared restart_supervised=true + observed not_supervised ⇒ the warning names the conflict", async () => {
    const C = { alias: "acl3-conflict-c", node: "node_acl3_conflict_c" };
    db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, config_snapshot)
            VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
      [C.node, C.alias, NET, adminId,
       JSON.stringify({ restart_supervised: true, systemd_supervision: "not_supervised" })]);
    db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at)
            VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
      [`r_${C.node}`, C.alias, C.node, NET]);

    const r = await tool(adminToken, "update_node_config", {
      node_id: C.node, base_revision: 0, patch: { channels: [] }, network_id: NET,
    });
    expect(r.ok).toBe(true);
    const w = (r.warnings || []).find((x: any) => x.code === "restart_requires_manual_respawn");
    expect(w).toBeTruthy();
    expect(w.message).toContain("DECLARES restart_supervised=true");
    expect(w.message).toContain("the observation wins");
  });

  // 2026-10-31 —— #3171：剩下两个待核（get_all_status / list_node_skills）。
  describe("get_all_status pinned (list_node_skills needs a live node → covered elsewhere)", () => {
    test("⇒ {ok, sessions, sessions_returned, summary, summary_scope}; sessions 与 sessions_returned 同源", async () => {
      const g = await tool(adminToken, "get_all_status", { network_id: NET });
      expect(Object.keys(g).sort()).toEqual(["ok", "sessions", "sessions_returned", "summary", "summary_scope"]);
      expect(Array.isArray(g.sessions)).toBe(true);
      expect(g.sessions_returned).toBe(g.sessions.length);      // 计数与数组同源
      expect(typeof g.summary_scope).toBe("string");
    });
  });

  // 2026-10-31 —— #3171：再补两个「文件级算过、邻近级没有」的工具。
  describe("projects_list / get_session_status: pinned key sets next to the call", () => {
    test("projects_list ⇒ {network_id, ok, projects}; get_session_status ⇒ {inbox_pending, ok, recent_completions, session}", async () => {
      const pl = await tool(adminToken, "projects_list", { network_id: NET });
      expect(Object.keys(pl).sort()).toEqual(["network_id", "ok", "projects"]);
      expect(Array.isArray(pl.projects)).toBe(true);

      const gs = await tool(adminToken, "get_session_status", { alias: "acl3-agent-x", network_id: NET });
      expect(Object.keys(gs).sort()).toEqual(["inbox_pending", "ok", "recent_completions", "session"]);
      expect(typeof gs.inbox_pending).toBe("number");
      expect(Array.isArray(gs.recent_completions)).toBe(true);
    });
  });

  // 2026-10-31 —— #3171：补一个「文件级算过、邻近级没有」的工具（list_tasks）。
  // 之前该文件里唯一的 Object.keys 断言测的是 humans[0]，与本工具无关 —— 这正是「测空气」。
  describe("list_tasks: pinned key set next to the call", () => {
    test("⇒ {count, next_cursor, ok, stats, tasks} and count === tasks.length", async () => {
      const r = await tool(adminToken, "list_tasks", { network_id: NET });
      // ⚠️ 我从源码里读到的形状（capability / next_terminal_seq）与实际返回不同 ——
      //    这一条断言当场纠正了我：**读码得到的形状必须由一次真实调用确认**。
      expect(Object.keys(r).sort()).toEqual(["count", "next_cursor", "ok", "stats", "tasks"]);
      expect(Array.isArray(r.tasks)).toBe(true);
      expect(r.count).toBe(r.tasks.length);            // 计数与数组同源
    });
  });

  // 2026-10-31 —— #3171 续：再一个节点侧读面（count/counts 同源的那类）。
  describe("list_my_pending_create_requests: pinned key set", () => {
    test("⇒ {clone_count, clone_requests, count, ok, requests}, and count === requests.length", async () => {
      const N3 = { alias: "acl3-pend-n", node: "node_acl3_pend_n" };
      seedAgent({ alias: N3.alias, node: N3.node });
      const minted = createNetworkTokenForNode(adminId, NET, N3.alias, N3.node);
      expect(minted.ok).toBe(true);
      const r = await tool(minted.token!, "list_my_pending_create_requests", {});
      expect(Object.keys(r).sort()).toEqual(["clone_count", "clone_requests", "count", "ok", "requests"]);
      expect(Array.isArray(r.requests)).toBe(true);
      expect(Array.isArray(r.clone_requests)).toBe(true);
      expect(r.count).toBe(r.requests.length);        // 计数与数组同源
      expect(r.clone_count).toBe(r.clone_requests.length);
    });
  });

  // 2026-10-31 —— #3171 续：两个节点侧只读工具的键集（有 ntok 夹具后成本很低）。
  describe("node-side read tools: pinned key sets", () => {
    test("list_my_children ⇒ {children, count, ok}; get_completions ⇒ {completions, ok}", async () => {
      const N2 = { alias: "acl3-node-read-n", node: "node_acl3_node_read_n" };
      seedAgent({ alias: N2.alias, node: N2.node });
      const minted = createNetworkTokenForNode(adminId, NET, N2.alias, N2.node);
      expect(minted.ok).toBe(true);
      const ntok = minted.token!;

      const children = await tool(ntok, "list_my_children", {});
      expect(Object.keys(children).sort()).toEqual(["children", "count", "ok"]);
      expect(Array.isArray(children.children)).toBe(true);
      expect(children.count).toBe(children.children.length); // 计数与数组同源

      const completions = await tool(ntok, "get_completions", {});
      expect(Object.keys(completions).sort()).toEqual(["completions", "ok"]);
      expect(Array.isArray(completions.completions)).toBe(true);
    });
  });

  // 2026-10-31 —— #3171 续：org_whoami 也是**两支**（第二支多一个 pacing）。
  // 它同时是「工具自带节流提示」的唯一一处，所以顺便把节流也钉住。
  describe("org_whoami: base shape + the conditional pacing key", () => {
    test("first call ⇒ no pacing; after the pacer trips ⇒ pacing appears (keys still pinned)", async () => {
      const O = { alias: "acl3-whoami-o", node: "node_acl3_whoami_o" };
      seedAgent({ alias: O.alias, node: O.node });
      const minted = createNetworkTokenForNode(adminId, NET, O.alias, O.node);
      expect(minted.ok).toBe(true);
      const ntok = minted.token!;

      const first = await tool(ntok, "org_whoami", {});
      expect(first.ok).toBe(true);
      expect(Object.keys(first)).not.toContain("pacing"); // 基线：第一次不该被提示

      // 节流阈值 8 次/60 秒 ⇒ 连续调用后最后一条必须带 pacing
      let last: any = null;
      for (let i = 0; i < 10; i++) last = await tool(ntok, "org_whoami", {});
      expect(Object.keys(last)).toContain("pacing");
      expect(typeof last.pacing).toBe("object");
    });
  });

  // 2026-10-31 —— #3171 续：**条件出现的键**（与 update_node_config 的 warnings 同族）。
  // get_inbox 在 human 模式下多带一个 human_inbox —— 只钉无 flag 那一支，
  // 等于允许另一支任意变形。
  describe("get_inbox: both shapes are pinned (the second key is conditional)", () => {
    test("default ⇒ {messages, ok}; human ⇒ {human_inbox, messages, ok} and human_inbox is {examined, mode, version}", async () => {
      const I = { alias: "acl3-inbox-i", node: "node_acl3_inbox_i" };
      seedAgent({ alias: I.alias, node: I.node });
      const minted = createNetworkTokenForNode(adminId, NET, I.alias, I.node);
      expect(minted.ok).toBe(true);
      const ntok = minted.token!;

      const plain = await tool(ntok, "get_inbox", { alias: I.alias, limit: 5 });
      expect(Object.keys(plain).sort()).toEqual(["messages", "ok"]);
      expect(Array.isArray(plain.messages)).toBe(true);

      const human = await tool(ntok, "get_inbox", { alias: I.alias, limit: 5, human_first: true });

      // 2026-10-31 —— **先证两份夹具彼此不同，再各自断言**（外部复核 (c)：
      // 「若四份夹具序列化出的字节相同，它只有一种形状 —— 后面的『各自断言』就是四次自拍」）。
      // 这里两态也一样：若 human_first 其实没生效，下面两条键集断言会变成「同一个形状断两次」。
      expect(JSON.stringify(Object.keys(plain).sort())).not.toBe(JSON.stringify(Object.keys(human).sort()));
      expect(Object.keys(human).sort()).toEqual(["human_inbox", "messages", "ok"]);
      expect(Object.keys(human.human_inbox).sort()).toEqual(["examined", "mode", "version"]);
      expect(human.human_inbox.mode).toBe("metadata-keyset");
    });
  });

  // 2026-10-31 —— #3171 续：两个「读面」工具的键集。
  // 选它们的理由：这两个是**客户端会按字段名逐个读**的（provider 列表 / 密钥名列表），
  // 而它们此前没有任何精确键集断言 —— 覆盖率脚本把它们列在 59 个未覆盖里。
  describe("read-surface tools have pinned key sets", () => {
    test("list_providers ⇒ exactly {ok, providers}; list_network_secrets ⇒ exactly {keys, ok}", async () => {
      const providers = await tool(adminToken, "list_providers", { network_id: NET });
      // 2026-10-31 —— 载荷扩容：`[]` 有四种含义（未配 / 全停用 / 配了没模型 / 查询失败），
      // 所以 `state` 与 `counts` 必须与 providers 同载荷；否则客户端只能显示「没有」。
      // 键集有**两种合法形状**（不是放宽成数组包含）：configured 时不给 hint，其余状态必须给 ——
      // 「有理由」和「没理由」在载荷上必须可区分，否则客户端只能说「没有」。
      const baseKeys = ["counts", "ok", "providers", "state"];
      expect(Object.keys(providers).sort()).toEqual(
        providers.state === "configured" ? baseKeys : [...baseKeys, "hint"].sort(),
      );
      if (providers.state !== "configured") expect(String(providers.hint).length).toBeGreaterThan(10);
      expect(Object.keys(providers.counts).sort()).toEqual(
        ["models_enabled", "providers_disabled", "providers_enabled", "providers_without_models"],
      );
      expect(["configured", "all_disabled", "unconfigured"]).toContain(providers.state);
      // 唯一一条跨字段不变量：state 与 providers 数组必须自洽
      expect(providers.state === "configured").toBe(providers.providers.length > 0);
      expect(Array.isArray(providers.providers)).toBe(true);

      const secrets = await tool(adminToken, "list_network_secrets", { network_id: NET });
      expect(Object.keys(secrets).sort()).toEqual(["keys", "ok"]);
      expect(Array.isArray(secrets.keys)).toBe(true);
      // 值永远不出来：这是 RFC-028 的承诺，键集测试顺手把它钉住
      for (const k of secrets.keys) expect(typeof k).toBe("string");
    });
  });

  // 2026-10-31 —— **空的 providers 数组有四种含义**（外部复核「兜底值必须说出自己是兜底」）。
  // 这条测试把 ①②③ 三种状态逐个造出来，断言 state 与 hint 各自不同 ——
  // 只测「空 == 空」的话，三种状态在载荷里长得一样，客户端的空状态就只能显示「没有」。
  test("list_providers: an empty registry says WHY it is empty (unconfigured / all_disabled / no models)", async () => {
    const pid = `acl3-probe-${Date.now()}`;
    const readState = async () => await tool(adminToken, "list_providers", { network_id: NET });
    const cleanup = () => {
      db.run(`DELETE FROM provider_models WHERE provider_id = ?1`, [pid]);
      db.run(`DELETE FROM providers WHERE provider_id = ?1`, [pid]);
    };
    try {
      // ① 未配置
      const a = await readState();
      expect(a.providers.length).toBe(0);
      expect(a.state).toBe("unconfigured");
      expect(String(a.hint)).toContain("还没有任何 provider");

      // ② 配过但停用
      db.run(
        `INSERT INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
         VALUES (?1, ?2, ?3, 'openai', 'https://api.example.com', 'K', ?4, 'test', 0)`,
        [pid, NET, pid, Date.now()],
      );
      const b = await readState();
      expect(b.providers.length).toBe(0);
      expect(b.state).toBe("all_disabled");
      expect(b.counts.providers_disabled).toBe(1);
      expect(String(b.hint)).toContain("停用");

      // ③ 启用但一条模型都没有
      db.run(`UPDATE providers SET enabled = 1 WHERE provider_id = ?1`, [pid]);
      const c = await readState();
      expect(c.state).toBe("configured");
      expect(c.providers.length).toBe(1);
      expect(c.providers[0].models.length).toBe(0);
      expect(c.providers[0].models_state).toBe("none_configured");
      expect(c.counts.providers_without_models).toBe(1);
      expect("hint" in c).toBe(false);   // configured 时不带 hint（载荷不变胖）

      // 2026-10-31 —— **键集变化必须是结构性可枚举的，不是「测到哪算哪」**（外部复核 (b)：
      // 「不造业务上限，改成结构性证明：键集对任意 n 恒定，不再依赖枚举」）。
      // 本载荷的 n 是「provider 条数」，键集必须与 n 无关；唯一的条件字段是 `hint`，
      // 且它只由 `state` 决定 ⇒ 用「所有 state 的键集集合」把这条结构钉死：
      //   不同的键集恰好 2 种，且它们的差恰好是 {"hint"}。
      // 这样新增第三个条件字段时会红 —— 而不是「反正测试里的 n 只有 0 和 1，没测到」。
      // ④ 有模型但不启用 ⇒ all_disabled（不是 none_configured）
      db.run(
        `INSERT INTO provider_models (model_id, provider_id, model_name, enabled, created_at)
         VALUES (?1, ?2, 'm1', 0, ?3)`,
        [`${pid}-m1`, pid, Date.now()],
      );
      const d = await readState();
      expect(d.providers[0].models_state).toBe("all_disabled");

      // 结构性键集：四次读数覆盖 4 种 state，键集只允许有 2 种，且差恰好 {"hint"}
      const keySets = new Map<string, string[]>();
      for (const [label, payload] of [["unconfigured", a], ["all_disabled", b], ["configured", c], ["models disabled", d]] as const) {
        keySets.set(label, Object.keys(payload).sort());
      }
      const distinct = [...new Set([...keySets.values()].map((k) => k.join(",")))];
      expect(distinct.length).toBe(2);
      const withHint = distinct.find((k) => k.includes("hint"))!;
      const withoutHint = distinct.find((k) => !k.includes("hint"))!;
      expect(withHint.split(",").filter((k) => !withoutHint.split(",").includes(k))).toEqual(["hint"]);
      expect(withoutHint.split(",").filter((k) => !withHint.split(",").includes(k))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // 2026-10-31 —— **#3168 的核心分支此前没有任何测试**：
  // 「节点没声明 supervisor（config_update_capable=false）、也没报 systemd_supervision」，
  // 这条分支会给出 `restart_supervision_unknown` 警告 —— 而它正是「手工起的节点被一次
  // restart-tier 下发弄死」的那一格。警告不是拒绝：Hub 不替调用方判断安全性，但必须说出来。
  describe("#3168: a node that declares no supervisor gets a warning, not silence", () => {
    test("restart-tier patch ⇒ warnings 含 restart_supervision_unknown（且 message 给出两种处置）", async () => {
      const U = { alias: "acl3-nosup-u", node: "node_acl3_nosup_u" };
      db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, config_snapshot)
              VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
        [U.node, U.alias, NET, adminId, JSON.stringify({ config_update_capable: false })]);
      const r = await tool(adminToken, "update_node_config", {
        node_id: U.node, base_revision: 0, patch: { channels: [] }, network_id: NET,
      });
      expect(r.ok).toBe(true);
      const w = (r.warnings || []).find((x: any) => x.code === "restart_supervision_unknown");
      expect(w).toBeTruthy();
      // 警告必须带**可执行的处置**（否则它只是把风险念了一遍）。
      // 实测这一支给的是「先确认它是怎么被拉起的（anet start / pm2 / systemd）」，
      // 而 Stop→Start 那句在**另一支**（systemd_supervision=not_supervised 已报告）里。
      expect(String(w.message)).toContain("anet start / pm2 / systemd");
      expect(String(w.message)).toContain("restart-tier");
      // 2026-10-31 —— **「存在」不是断言，「存在且值等于 X」才是**（外部复核 (b)：
      // 「写『存在』⇒ 它被改成任何值都绿」）。这一条把 warning 的形状也钉住：
      // 多一个键 = 又一处没人读的字段；少一个键 = 客户端拿不到处置。
      expect(Object.keys(w).sort()).toEqual(["code", "message"]);
    });
  });

  // 2026-10-31 —— #3171 第 2 项：restart_node 的成功体与 update_node_config 同构。
  describe("restart_node success body", () => {
    test("pinned key set (same shape family as update_node_config)", async () => {
      const R = { alias: "acl3-restart-r", node: "node_acl3_restart_r" };
      seedAgent({ alias: R.alias, node: R.node });
      const r = await tool(adminToken, "restart_node", { node_id: R.node, network_id: NET });
      // 与 update_node_config 同构（不含 warnings：restart 不带 patch，分档固定为 restart_only）
      expect(Object.keys(r).sort()).toEqual(["apply_mode", "ok", "update_id"]);
      expect(r.ok).toBe(true);
      expect(r.apply_mode).toBe("restart_only");
    });
  });

  // 2026-10-31 —— #3171 第 3 项：get_config_update 的两态。
  // 「有 pending」与「无 pending」是**两条不同形状**，而旧测试只在 SQL 层模拟过它们，
  // 从没有一条断言钉住工具真正返回的那两个 JSON。
  describe("get_config_update: both states have pinned shapes", () => {
    test("no pending ⇒ exactly {ok, update:null}; with pending ⇒ exactly {ok, update:{apply_mode,base_revision,patch,update_id}}", async () => {
      const N = { alias: "acl3-puller-n", node: "node_acl3_puller_n" };
      seedAgent({ alias: N.alias, node: N.node });
      const minted = createNetworkTokenForNode(adminId, NET, N.alias, N.node);
      expect(minted.ok).toBe(true);
      const ntok = minted.token!;

      // ① 无 pending
      const empty = await tool(ntok, "get_config_update", {});
      expect(Object.keys(empty).sort()).toEqual(["ok", "update"]);
      expect(empty.ok).toBe(true);
      expect(empty.update).toBeNull();

      // ② 有 pending
      db.run(`INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token)
              VALUES (?1, ?2, ?3, ?4, 'hot', 0, 'pending', ?5, 'test')`,
        ["u_acl3_pending", N.node, NET, JSON.stringify({ model: "m" }), Date.now()]);
      const one = await tool(ntok, "get_config_update", {});
      expect(Object.keys(one).sort()).toEqual(["ok", "update"]);
      expect(Object.keys(one.update).sort()).toEqual(["apply_mode", "base_revision", "patch", "update_id"]);
      expect(one.update.update_id).toBe("u_acl3_pending");
      expect(one.update.apply_mode).toBe("hot");

      // ③ #3171 第 4 项：ack 成功回执恰好 {ok, status}
      const ack = await tool(ntok, "ack_config_update", {
        update_id: "u_acl3_pending", status: "applied", new_revision: 1,
      });
      expect(Object.keys(ack).sort()).toEqual(["ok", "status"]);
      expect(ack.ok).toBe(true);
      expect(ack.status).toBe("applied");
    });
  });

  // 2026-10-31 —— #3171 第 5 项：错误信封的形状也要钉住。
  // 今天它们是「约定俗成」：每个出口手写 {ok:false,error}，
  // 于是谁顺手多塞一个字段，客户端的分支就多一个没人知道的键。
  describe("error envelope: exactly {ok, error} unless the error carries its own fields", () => {
    test("get_config_update without a node token ⇒ exactly {error, ok}", async () => {
      const r = await tool(adminToken, "get_config_update", {});
      expect(r.ok).toBe(false);
      expect(r.error).toBe("network_token_required");
      expect(Object.keys(r).sort()).toEqual(["error", "ok"]);
    });

    test("ack_config_update without a node token ⇒ exactly {error, ok}", async () => {
      const r = await tool(adminToken, "ack_config_update", {
        update_id: "u_missing", status: "applied", network_id: NET,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("network_token_required");
      expect(Object.keys(r).sort()).toEqual(["error", "ok"]);
    });
  });

  // 2026-10-31 —— #3171：warnings 出现时的成功体也必须被钉住。
  // 上面那条钉的是「没有 warning」的形状；而 warnings 是**条件出现**的 ⇒
  // 只断言前者，等于允许后者任意变形（今天它没出事，靠的是客户端宽松解析）。
  test("带 warning 的成功体恰好 {apply_mode, ok, update_id, warnings}，且 warning 项恰好 {code, message}", async () => {
    const W = { alias: "acl3-agent-w", node: "node_acl3_w" };
    db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, config_snapshot)
            VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
      [W.node, W.alias, NET, adminId, JSON.stringify({ systemd_supervision: "not_supervised" })]);
    db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at)
            VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
      [`r_${W.node}`, W.alias, W.node, NET]);

    const r = await tool(adminToken, "update_node_config", {
      node_id: W.node, base_revision: 0, patch: { channels: [] }, network_id: NET,
    });

    expect(r.ok).toBe(true);
    expect(r.apply_mode).not.toBe("hot");                       // restart-tier：这正是危险的那一档
    // 两个方向都钉：少一个键红，多一个键也红
    expect(Object.keys(r).sort()).toEqual(["apply_mode", "ok", "update_id", "warnings"]);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings.length).toBe(1);
    expect(Object.keys(r.warnings[0]).sort()).toEqual(["code", "message"]);
    // code 是稳定枚举，不是自由文本 —— 客户端要靠它分支
    expect(r.warnings[0].code).toBe("restart_requires_manual_respawn");
    expect(typeof r.warnings[0].message).toBe("string");
  });

  test("revision 冲突恰好 {current_revision, error, ok}", async () => {
    // 用另一台干净节点，避开上面那条的在途状态
    const r = await tool(adminToken, "update_node_config", {
      node_id: Z.node, base_revision: 99, patch: { model: "stale" }, network_id: NET,
    });
    expect(r.ok).toBe(false);
    // 实际契约：code 是 revision_conflict（不是 config_revision_conflict），
    // 且带 base_revision —— 顺手纠正了卡上写错的错误名。
    expect(r.error).toBe("revision_conflict");
    expect(Object.keys(r).sort()).toEqual(["base_revision", "current_revision", "error", "ok"]);
  });
});
