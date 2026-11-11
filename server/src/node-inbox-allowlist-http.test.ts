// 收件白名单(接收侧)—— 节点的主人限定「谁能给它派活 / 发消息」。全部经真实 HTTP 入口(bootServer + REST / /mcp)。
//
// 钉住:
//   1. PUT /api/nodes/:id/inbox-allowlist 与 peer-allowlist 同形:{ senders } / 200 回 { ok, node_id, senders } /
//      [] 拒收 / 非数组 400 / 超 200 条 400 / 普通成员 403 且行没变 / 节点令牌 403 / 不存在 404 / null 清空 / 审计一行。
//   2. GET /api/nodes 读回 inbox_allowlist;/health 的 capabilities 带 node_inbox_allowlist。
//   3. 节点发件人按 alias / node_id 匹配;不在名单 ⇒ node_permission_denied + sender_not_allowed + hint,
//      覆盖 MCP send_task / send_message / retry_task / reassign_task 与 REST POST /api/task;开关 off 也照拒(显式原因)。
//   4. 人类发件人按 user:<username> / user:<user_id> / user:* 匹配;节点主人、网络 owner/admin 隐式放行,!strict 关掉隐式放行。
//   5. 发给自己永远放行(含 !strict)。6. 广播跳过不收的收件人并在 inbox_skipped 里报告(没人被跳过时没有这个键),不让整条广播失败。
//
// 跑法:COMMHUB_DB=/tmp/x.db bun test server/src/node-inbox-allowlist-http.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { inboxAllows } from "./node-permissions.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-inbox-allowlist requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const PW = "InboxAllow123!";
let server: any, base = "", net = "";
const user: Record<string, { id: string; name: string; token: string }> = {};
const node: Record<string, { id: string; alias: string; token: string }> = {};

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(data ? data.slice(6) : text);
  const inner = msg.result?.content?.[0]?.text;
  try { return JSON.parse(inner); } catch { return { raw: inner ?? msg }; }
}
const setInbox = (list: string[] | null) =>
  db.run("UPDATE nodes SET inbox_allowlist = ?1 WHERE node_id = ?2", [list ? JSON.stringify(list) : null, node.tgt.id]);
const storedInbox = () => db.get<{ v: string | null }>("SELECT inbox_allowlist AS v FROM nodes WHERE node_id = ?1", node.tgt.id)!.v;
const inboxRowsFor = (alias: string) => Number(db.get<{ n: number | string }>(
  "SELECT COUNT(*) AS n FROM inbox WHERE session_name = ?1 AND network_id = ?2", alias, net)!.n);
const expectSenderDenied = (body: any, sender: string) => {
  expect(body.ok).toBe(false);
  expect(body.error).toBe("node_permission_denied");
  expect(body.reason).toBe("sender_not_allowed");
  expect(typeof body.hint).toBe("string");
  expect(body.hint).toContain("inbox allowlist");
  expect(body.target).toBe(node.tgt.alias);
  expect(body.sender).toBe(sender);
};

beforeAll(async () => {
  const boss = register(`ia_boss_${stamp}`, PW);
  net = boss.network_id!;
  user.boss = { id: boss.user!.user_id, name: `ia_boss_${stamp}`, token: boss.token! };
  for (const [k, role] of [["own", "member"], ["adm", "admin"], ["mem", "member"], ["out", null]] as const) {
    const name = `ia_${k}_${stamp}`;
    const u = register(name, PW);
    user[k] = { id: u.user!.user_id, name, token: u.token! };
    if (role) expect(addNetworkMember(net, user[k].id, role, user.boss.id, { agentAccess: "all" }).ok).toBe(true);
  }
  // tgt 的主人是普通成员 own(不是网络 owner),这样「节点主人放行」与「网络 owner 放行」能分开测。
  for (const [key, owner] of [["tgt", "own"], ["a", "boss"], ["b", "boss"], ["c", "boss"]] as const) {
    const alias = `ia-${key}-${stamp}`, id = `n_ia_${key}_${stamp}`;
    const t = createNetworkTokenForNode(user[owner].id, net, alias, id);
    expect(t.ok).toBe(true);
    node[key] = { id, alias, token: t.token! };
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_${id}`, alias, id, net]);
  }
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);
afterEach(() => { delete process.env.COMMHUB_NODE_PERMISSIONS; setInbox(null); });
afterAll(() => { server?.stop?.(true); });

describe("PUT /api/nodes/:id/inbox-allowlist —— 与 peer-allowlist 同形", () => {
  const put = (token: string, body: unknown, nodeId = node.tgt.id) => call(token, "PUT", `/api/nodes/${nodeId}/inbox-allowlist`, body);

  test("节点主人设 → 200 { ok, node_id, senders },GET 读回,审计一行 {from,to}", async () => {
    const r = await put(user.own.token, { senders: [node.a.alias, " user:" + user.mem.name + " "] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, node_id: node.tgt.id, senders: [node.a.alias, `user:${user.mem.name}`] });
    const g = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.tgt.id}`);
    expect(g.body.nodes[0].inbox_allowlist).toEqual([node.a.alias, `user:${user.mem.name}`]);
    const audit = db.get<{ detail: string | null; user_id: string | null }>(
      "SELECT detail, user_id FROM audit_log WHERE action = 'node_inbox_allowlist_changed' AND target_id = ?1 ORDER BY id DESC LIMIT 1", node.tgt.id);
    expect(audit?.user_id).toBe(user.own.id);
    expect(JSON.parse(audit!.detail!)).toEqual({ from: null, to: JSON.stringify([node.a.alias, `user:${user.mem.name}`]) });
  });

  test("网络 owner / admin 也能设;null 清空 → GET 读回 null", async () => {
    expect((await put(user.boss.token, { senders: ["x"] })).status).toBe(200);
    expect((await put(user.adm.token, { senders: ["y"] })).body.senders).toEqual(["y"]);
    const cleared = await put(user.adm.token, { senders: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.senders).toBeNull();
    expect(storedInbox()).toBeNull();
    const g = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.tgt.id}`);
    expect(g.body.nodes[0].inbox_allowlist).toBeNull();
  });

  test("普通成员 403 且行没变;主人 200 且行真的变(镜像)", async () => {
    setInbox(["keep"]);
    const denied = await put(user.mem.token, { senders: ["sneak"] });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("permission_denied");
    expect(storedInbox()).toBe(JSON.stringify(["keep"]));
    expect((await put(user.own.token, { senders: ["changed"] })).status).toBe(200);
    expect(storedInbox()).toBe(JSON.stringify(["changed"]));
  });

  test("错误形状:[] / 非数组 / 超 200 条 / 坏 JSON → 400,库没变", async () => {
    setInbox(["keep"]);
    const empty = await put(user.own.token, { senders: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_allowlist_ambiguous");
    expect((await put(user.own.token, { senders: "a" })).body.error).toBe("invalid_senders");
    const many = await put(user.own.token, { senders: Array.from({ length: 201 }, (_, i) => `s${i}`) });
    expect(many.status).toBe(400);
    expect(many.body.error).toBe("too_many_senders");
    const bad = await fetch(`${base}/api/nodes/${node.tgt.id}/inbox-allowlist`, {
      method: "PUT", headers: { Authorization: `Bearer ${user.own.token}`, "Content-Type": "application/json" }, body: "{",
    });
    expect(bad.status).toBe(400);
    expect(storedInbox()).toBe(JSON.stringify(["keep"]));
  });

  test("节点令牌 403 user_token_required;网络外的人 / 不存在的节点 404;无令牌 401", async () => {
    const asNode = await put(node.tgt.token, { senders: ["x"] });
    expect(asNode.status).toBe(403);
    expect(asNode.body.error).toBe("user_token_required");
    expect((await put(user.out.token, { senders: ["x"] })).status).toBe(404);
    expect((await put(user.boss.token, { senders: ["x"] }, "n_does_not_exist")).status).toBe(404);
    const anon = await fetch(`${base}/api/nodes/${node.tgt.id}/inbox-allowlist`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(anon.status).toBe(401);
    expect(storedInbox()).toBeNull();
  });

  test("/health 宣告 node_inbox_allowlist", async () => {
    const r = await fetch(`${base}/health`);
    expect((await r.json()).capabilities).toContain("node_inbox_allowlist");
  });
});

describe("节点发件人 —— alias / node_id 匹配,显式原因", () => {
  test("null = 谁都能发(与今天一致)", async () => {
    expect((await mcp(node.b.token, "send_task", { alias: node.tgt.alias, task: "open inbox" })).ok).toBe(true);
  });

  test("MCP send_task:名单上的(alias)放行,不在名单上的拒并记在目标节点名下,且不入库", async () => {
    setInbox([node.a.alias]);
    expect((await mcp(node.a.token, "send_task", { alias: node.tgt.alias, task: "from a" })).ok).toBe(true);
    const before = inboxRowsFor(node.tgt.alias);
    const denied = await mcp(node.b.token, "send_task", { alias: node.tgt.alias, task: "from b" });
    expectSenderDenied(denied, node.b.alias);
    expect(denied.route).toBe("mcp:send_task");
    expect(inboxRowsFor(node.tgt.alias)).toBe(before);
    const row = db.get<{ hits: number | string; sample: string | null }>(
      "SELECT hits, sample FROM node_permission_log WHERE network_id = ?1 AND node_id = ?2 AND reason = 'sender_not_allowed' AND route = 'mcp:send_task'", net, node.tgt.id);
    expect(Number(row?.hits)).toBeGreaterThan(0);
    expect(row?.sample).toBe(node.b.alias);
  });

  test("按 node_id 写也命中", async () => {
    setInbox([node.b.id]);
    expect((await mcp(node.b.token, "send_task", { alias: node.tgt.alias, task: "by id" })).ok).toBe(true);
  });

  test("显式原因:COMMHUB_NODE_PERMISSIONS=off 也照拒", async () => {
    process.env.COMMHUB_NODE_PERMISSIONS = "off";
    setInbox([node.a.alias]);
    expectSenderDenied(await mcp(node.b.token, "send_task", { alias: node.tgt.alias, task: "off" }), node.b.alias);
  });

  test("MCP send_message / retry_task / reassign_task 同样拒", async () => {
    setInbox([node.a.alias]);
    expectSenderDenied(await mcp(node.b.token, "send_message", { alias: node.tgt.alias, message: "hi" }), node.b.alias);

    setInbox(null);
    const t = await mcp(node.a.token, "send_task", { alias: node.tgt.alias, task: "to retry" });
    expect(t.ok).toBe(true);
    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [t.message_id]);
    setInbox([node.a.alias]);
    const retry = await mcp(node.b.token, "retry_task", { task_id: t.message_id });
    expectSenderDenied(retry, node.b.alias);
    expect(retry.route).toBe("mcp:retry_task");
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", t.message_id)!.status).toBe("failed");

    const r = await mcp(node.a.token, "send_task", { alias: node.c.alias, task: "to reassign" });
    expect(r.ok).toBe(true);
    const re = await mcp(node.b.token, "reassign_task", { task_id: r.message_id, new_alias: node.tgt.alias });
    expectSenderDenied(re, node.b.alias);
    expect(db.get<{ to_name: string }>("SELECT to_name FROM tasks WHERE task_id = ?1", r.message_id)!.to_name).toBe(node.c.alias);
  });

  test("REST POST /api/task(节点令牌)→ 403 同一形状", async () => {
    setInbox([node.a.alias]);
    const r = await call(node.b.token, "POST", "/api/task", { alias: node.tgt.alias, task: "rest from b", network_id: net });
    expect(r.status).toBe(403);
    expectSenderDenied(r.body, node.b.alias);
    expect(r.body.route).toBe("POST /api/task");
    expect((await call(node.a.token, "POST", "/api/task", { alias: node.tgt.alias, task: "rest from a", network_id: net })).status).toBe(200);
  });

  test("发给自己永远放行(含 !strict)", async () => {
    setInbox(["!strict"]);
    expect((await mcp(node.tgt.token, "send_task", { alias: node.tgt.alias, task: "note to self" })).ok).toBe(true);
  });
});

describe("人类发件人 —— user:<username|user_id> / user:*,主人与管理员隐式放行", () => {
  const send = (who: string, task = "hello") =>
    call(user[who].token, "POST", "/api/task", { alias: node.tgt.alias, task: `${task} ${who} ${Math.random()}`, network_id: net });

  test("名单只有节点 ⇒ 普通成员被拒;节点主人、网络 owner、网络 admin 照常能发", async () => {
    setInbox([node.a.alias]);
    const denied = await send("mem");
    expect(denied.status).toBe(403);
    expectSenderDenied(denied.body, `user:${user.mem.name}`);
    for (const who of ["own", "boss", "adm"]) expect((await send(who)).status).toBe(200);
  });

  test("user:<username>、user:<user_id>、user:* 都命中", async () => {
    for (const entry of [`user:${user.mem.name}`, `user:${user.mem.id}`, "user:*"]) {
      setInbox([node.a.alias, entry]);
      expect((await send("mem")).status).toBe(200);
    }
  });

  test("!strict 关掉隐式放行:主人与网络 owner 也必须在名单上", async () => {
    setInbox([node.a.alias, "!strict"]);
    expect((await send("own")).status).toBe(403);
    expect((await send("boss")).status).toBe(403);
    setInbox([node.a.alias, "!strict", `user:${user.own.name}`]);
    expect((await send("own")).status).toBe(200);
  });

  test("MCP 用户令牌同一口径", async () => {
    setInbox([node.a.alias]);
    expectSenderDenied(await mcp(user.mem.token, "send_task", { alias: node.tgt.alias, task: "mcp human", network_id: net }), `user:${user.mem.name}`);
    expect((await mcp(user.own.token, "send_task", { alias: node.tgt.alias, task: "mcp owner", network_id: net })).ok).toBe(true);
  });
});

describe("广播 —— 跳过不收的收件人,报告而不失败", () => {
  test("REST /api/broadcast:tgt 被跳过并出现在 inbox_skipped,其他人照收", async () => {
    setInbox([node.a.alias]);
    const before = { tgt: inboxRowsFor(node.tgt.alias), c: inboxRowsFor(node.c.alias) };
    const r = await call(user.mem.token, "POST", `/api/broadcast?network_id=${net}`, { message: `bc ${stamp}`, network_id: net });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.inbox_skipped).toEqual([{ alias: node.tgt.alias, node_id: node.tgt.id, reason: "sender_not_allowed" }]);
    expect(inboxRowsFor(node.tgt.alias)).toBe(before.tgt);
    expect(inboxRowsFor(node.c.alias)).toBe(before.c + 1);
  });

  test("MCP broadcast(节点令牌)同样跳过;没人被跳过时回执恰好三键、没有 inbox_skipped", async () => {
    const open = await mcp(node.b.token, "broadcast", { message: `open ${stamp}` });
    expect(open.ok).toBe(true);
    expect(Object.keys(open).sort()).toEqual(["message_ids", "ok", "recipients"]);
    setInbox([node.a.alias]);
    const r = await mcp(node.b.token, "broadcast", { message: `mcp bc ${stamp}` });
    expect(r.ok).toBe(true);
    expect(r.inbox_skipped.map((s: any) => s.alias)).toEqual([node.tgt.alias]);
    expect(r.recipients).toBe(open.recipients - 1);
  });
});

describe("排程 —— 每次触发按建排程的人现判", () => {
  test("普通成员建的排程:名单不收他 ⇒ 这次运行 failed / sender_not_allowed,不建任务;收他 ⇒ 照常派发", async () => {
    const { dispatchScheduledOccurrence } = await import("./scheduled-tasks.js");
    const schedule = (suffix: string) => {
      const id = `sched_ia_${suffix}_${stamp}`;
      db.run(
        `INSERT INTO scheduled_tasks (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, schedule_type, schedule_json, next_run_at)
         VALUES (?1, ?2, ?3, 'n', ?4, ?5, 'scheduled work', 'interval', '{"type":"interval","minutes":60}', datetime('now'))`,
        [id, net, user.mem.id, node.tgt.id, node.tgt.alias],
      );
      return db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", id);
    };
    setInbox([node.a.alias]);
    const denied = dispatchScheduledOccurrence(schedule("deny"), new Date().toISOString(), false);
    expect(denied.status).toBe("failed");
    expect(denied.taskId).toBeUndefined();
    expect(db.get<{ error_code: string }>("SELECT error_code FROM scheduled_task_runs WHERE run_id = ?1", denied.runId)?.error_code).toBe("sender_not_allowed");
    setInbox([node.a.alias, `user:${user.mem.name}`]);
    const ok = dispatchScheduledOccurrence(schedule("allow"), new Date().toISOString(), false);
    expect(ok.taskId).toBeTruthy();
  });
});

describe("部门授权 dept:<department_id>（admin 11-11「以部门去授权」）", () => {
  const mkDept = (id: string, parent: string | null) =>
    db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort, created_by) VALUES (?1, ?2, ?3, ?4, 0, ?5)", [net, id, id, parent, user.boss.id]);
  const setDept = (nodeId: string, dept: string | null) => db.run("UPDATE nodes SET department_id = ?1 WHERE node_id = ?2", [dept, nodeId]);
  test("名单写上级部门：子部门里的节点能派活，别的部门 / 未分配的被拒", async () => {
    const top = `dept_top_${stamp}`, child = `dept_child_${stamp}`, other = `dept_other_${stamp}`;
    mkDept(top, null); mkDept(child, top); mkDept(other, null);
    setDept(node.a.id, child); setDept(node.b.id, other); setDept(node.c.id, null);
    try {
      setInbox([`dept:${top}`]);
      const ok = await mcp(node.a.token, "send_task", { alias: node.tgt.alias, task: "dept ok" });
      expect(ok.ok).not.toBe(false);
      expectSenderDenied(await mcp(node.b.token, "send_task", { alias: node.tgt.alias, task: "dept other" }), node.b.alias);
      expectSenderDenied(await mcp(node.c.token, "send_task", { alias: node.tgt.alias, task: "dept none" }), node.c.alias);
    } finally {
      setDept(node.a.id, null); setDept(node.b.id, null);
      db.run("DELETE FROM network_departments WHERE network_id = ?1 AND department_id IN (?2, ?3, ?4)", [net, top, child, other]);
    }
  });
  test("人按 network_members.department_id 匹配；!strict 下同样只看名单", async () => {
    const d = `dept_people_${stamp}`;
    mkDept(d, null);
    db.run("UPDATE network_members SET department_id = ?1 WHERE network_id = ?2 AND user_id = ?3", [d, net, user.mem.id]);
    try {
      const ctx = { targetNodeId: node.tgt.id, targetAlias: node.tgt.alias, ownerUserId: user.own.id, networkId: net };
      const mem = { kind: "user" as const, userId: user.mem.id, username: user.mem.name };
      expect(inboxAllows([`dept:${d}`, "!strict"], mem, ctx)).toBe(true);
      expect(inboxAllows(["dept:dept_nope", "!strict"], mem, ctx)).toBe(false);
    } finally {
      db.run("UPDATE network_members SET department_id = NULL WHERE network_id = ?1 AND user_id = ?2", [net, user.mem.id]);
      db.run("DELETE FROM network_departments WHERE network_id = ?1 AND department_id = ?2", [net, d]);
    }
  });
});

describe("inboxAllows —— 纯判定", () => {
  const ctx = { targetNodeId: "n_t", targetAlias: "t", ownerUserId: "u_owner", networkId: null };
  test("null 放行一切;legacy 默认放行,!strict 拒", () => {
    expect(inboxAllows(null, { kind: "legacy" }, ctx)).toBe(true);
    expect(inboxAllows(["x"], { kind: "legacy" }, ctx)).toBe(true);
    expect(inboxAllows(["x", "!strict"], { kind: "legacy" }, ctx)).toBe(false);
  });
  test("Hub 管理员隐式放行;!strict 下不放行", () => {
    const admin = { kind: "user" as const, userId: "u_admin", username: "root", isHubAdmin: true };
    expect(inboxAllows(["x"], admin, ctx)).toBe(true);
    expect(inboxAllows(["x", "!strict"], admin, ctx)).toBe(false);
  });
  test("节点条目不会匹配到同名的人(user: 前缀才是人)", () => {
    expect(inboxAllows(["alice"], { kind: "user", userId: "u_a", username: "alice" }, ctx)).toBe(false);
    expect(inboxAllows(["user:*"], { kind: "node", nodeId: "n_x", aliases: ["x"] }, ctx)).toBe(false);
  });
});
