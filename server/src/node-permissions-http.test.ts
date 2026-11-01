// RFC-041 第一阶段(#487)—— 节点自己的权限:先记录、后执行。全部经真实 HTTP 入口(bootServer + fetch REST / /mcp / SSE)。
//
// 钉住:
//   1. log(默认):正常模式的节点「本来会被拒」的写照常放行,只按 (节点, 路由, 原因, 小时) 合并记一行。
//   2. 显式模式不看开关、立刻生效:只读写什么都拒、回复 / 心跳照常;受限只看只改派给它的卡,广播 / 订阅别人的推送都拒。
//   3. enforce:同一组请求按规则拒(node_permission_denied + reason + hint),含只有人能做的事(human_only)。
//   4. off:不判也不记(显式模式仍生效)。
//   5. 改模式:节点主人 / 网络 owner、admin 能;别的成员 403、节点令牌 403、不在网络里 404。
//   6. 报表:owner/admin 看到过去 7 天每个节点「本来会拦」的计数;成员 / 节点令牌 403。
//   7. 每个注册的 MCP 工具都归了类(新工具忘了归类会红)。8. 记录有上限、会清理。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/node-permissions-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { replaceTaskGrants } from "./task-access.js";
import { db, hashToken } from "./db.js";
import { NODE_TOOL_CLASS, pruneNodePermissionLog, __resetNodePermissionLogStateForTest } from "./node-permissions.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-permissions requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const PW = "NodePerm123!";
let server: any, base = "", net = "";
const user: Record<string, { id: string; token: string }> = {};
const node: Record<string, { id: string; alias: string; token: string; tokenId: string }> = {};
const card: Record<string, string> = {};

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
const sse = async (token: string, path: string) => {
  const ac = new AbortController();
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const status = r.status;
  const body = status === 200 ? null : await r.json().catch(() => null);
  ac.abort();
  return { status, body };
};
const logRows = (nodeId: string) => db.all<{ route: string; reason: string; hits: number | string }>(
  "SELECT route, reason, hits FROM node_permission_log WHERE network_id = ?1 AND node_id = ?2 ORDER BY route, reason", net, nodeId);
const hitsOf = (nodeId: string, route: string, reason: string) =>
  Number(logRows(nodeId).find((r) => r.route === route && r.reason === reason)?.hits ?? 0);
const attrsRev = (nodeId: string) => Number(db.get<{ r: number | string | null }>("SELECT attrs_revision AS r FROM nodes WHERE node_id = ?1", nodeId)?.r ?? 0);
const setMode = (nodeKey: string, mode: string) => db.run("UPDATE nodes SET permission_mode = ?1 WHERE node_id = ?2", [mode, node[nodeKey].id]);
const newCard = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = await call(user.boss.token, "POST", "/api/requirements", { name, network_id: net, ...extra });
  expect(r.status).toBe(201);
  return r.body.requirement.id as string;
};

beforeAll(async () => {
  const boss = register(`np_boss_${stamp}`, PW); net = boss.network_id!; user.boss = { id: boss.user!.user_id, token: boss.token! };
  for (const k of ["sco", "mem", "out"]) {
    const u = register(`np_${k}_${stamp}`, PW); user[k] = { id: u.user!.user_id, token: u.token! };
    if (k !== "out") expect(addNetworkMember(net, user[k].id, "member", user.boss.id, { agentAccess: "all" }).ok).toBe(true);
  }
  // sco:只看相关任务的成员(task_access=scoped)—— 他的节点在正常模式下会碰到「主人看不见」的卡。
  expect(replaceTaskGrants({ networkId: net, userId: user.sco.id, taskAccess: "scoped", actorUserId: user.boss.id }).ok).toBe(true);
  for (const [key, owner] of [["nN", "boss"], ["nR", "boss"], ["nRO", "boss"], ["nS", "sco"], ["other", "boss"]] as const) {
    const alias = `${key.toLowerCase()}-${stamp}`, id = `n_np_${key.toLowerCase()}_${stamp}`;
    const t = createNetworkTokenForNode(user[owner].id, net, alias, id);
    expect(t.ok).toBe(true);
    node[key] = { id, alias, token: t.token!, tokenId: t.token_id! };
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_${id}`, alias, id, net]);
  }
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  card.assigned = await newCard("assigned to nR", { agent_owner: { kind: "node", id: node.nR.id } });
  card.child = await newCard("child of assigned", { parent_id: card.assigned });
  card.boss = await newCard("boss only");
  card.scoPart = await newCard("sco participates", { participants: [{ kind: "user", id: user.sco.id }] });
  setMode("nR", "restricted");
  setMode("nRO", "readonly");
}, 60_000);
afterEach(() => { delete process.env.COMMHUB_NODE_PERMISSIONS; });
afterAll(() => { server?.stop?.(true); });

describe("log (default): never blocks a normal node, records would-be denials", () => {
  test("a write beyond the owner's visibility goes through and is logged once per hour, hits merged", async () => {
    const route = "PATCH /api/requirements/:id";
    const before = hitsOf(node.nS.id, route, "beyond_owner_visibility");
    expect((await call(node.nS.token, "PATCH", `/api/requirements/${card.boss}`, { description: "via scoped owner's node" })).status).toBe(200);
    expect((await call(node.nS.token, "PATCH", `/api/requirements/${card.boss}`, { description: "again" })).status).toBe(200);
    expect(hitsOf(node.nS.id, route, "beyond_owner_visibility")).toBe(before + 2);
    expect(logRows(node.nS.id).filter((r) => r.route === route).length).toBe(1);
  });

  test("a list read that includes cards the owner cannot see is returned in full and logged", async () => {
    const r = await call(node.nS.token, "GET", `/api/requirements?network_id=${net}`);
    expect(r.status).toBe(200);
    expect(r.body.requirements.map((x: any) => x.id)).toContain(card.boss);
    expect(hitsOf(node.nS.id, "GET /api/requirements", "beyond_owner_visibility")).toBeGreaterThan(0);
  });

  test("human-only actions are logged, not blocked by this layer", async () => {
    const r = await call(node.nN.token, "PUT", `/api/nodes/${node.other.id}/attrs`, { display_name: "renamed by a node", base_attrs_revision: attrsRev(node.other.id) });
    expect(r.status).toBe(200);
    expect(hitsOf(node.nN.id, "PUT /api/nodes/:id/attrs", "human_only")).toBe(1);
    const p = await mcp(node.nN.token, "projects_create", { network_id: net, name: `p-${stamp}` });
    expect(p.error).not.toBe("node_permission_denied");
    expect(hitsOf(node.nN.id, "mcp:projects_create", "human_only")).toBe(1);
  });

  test("an all-access owner's normal node does its usual work with zero log rows", async () => {
    expect((await mcp(node.nN.token, "send_task", { alias: node.other.alias, task: "hello" })).ok).toBe(true);
    expect((await call(node.nN.token, "PATCH", `/api/requirements/${card.boss}`, { column: "doing" })).status).toBe(200);
    expect(logRows(node.nN.id).filter((r) => r.reason !== "human_only")).toEqual([]);
  });
});

describe("explicit modes are enforced immediately (even under log)", () => {
  test("read-only: writes and dispatch refused with a hint; heartbeat, replies and reads still work", async () => {
    const w = await call(node.nRO.token, "PATCH", `/api/requirements/${card.boss}`, { description: "nope" });
    expect(w.status).toBe(403);
    expect(w.body).toMatchObject({ error: "node_permission_denied", reason: "mode_readonly" });
    expect(w.body.hint).toContain("read-only");
    expect((await mcp(node.nRO.token, "send_task", { alias: node.other.alias, task: "x" })).reason).toBe("mode_readonly");
    expect((await call(node.nRO.token, "POST", "/api/task", { alias: node.other.alias, task: "x", network_id: net })).body.reason).toBe("mode_readonly");
    expect((await mcp(node.nRO.token, "report_status", { resume_id: `r_${node.nRO.id}`, alias: node.nRO.alias, status: "idle" })).ok).toBe(true);
    const t = await mcp(node.nN.token, "send_task", { alias: node.nRO.alias, task: "please answer" });
    const reply = await mcp(node.nRO.token, "send_reply", { in_reply_to: t.task_id ?? t.message_id, text: "done", status: "replied" });
    expect(reply.ok).not.toBe(false);
    expect((await call(node.nRO.token, "GET", `/api/requirements?network_id=${net}`)).status).toBe(200);
  });

  test("restricted: sees and edits only cards assigned to it (and their subtasks)", async () => {
    const list = await call(node.nR.token, "GET", `/api/requirements?network_id=${net}`);
    expect(list.body.requirements.map((x: any) => x.id).sort()).toEqual([card.assigned, card.child].sort());
    expect((await call(node.nR.token, "GET", `/api/requirements/${card.boss}`)).status).toBe(404);
    expect((await call(node.nR.token, "PATCH", `/api/requirements/${card.assigned}`, { column: "doing" })).status).toBe(200);
    expect((await call(node.nR.token, "PATCH", `/api/requirements/${card.child}`, { column: "doing" })).status).toBe(200);
    expect((await call(node.nR.token, "POST", `/api/requirements/${card.assigned}/comments`, { text: "progress" })).status).toBe(201);
    const mine = await call(node.nR.token, "POST", "/api/requirements", { name: "mine", network_id: net, agent_owner: { kind: "node", id: node.nR.id } });
    expect(mine.status).toBe(201);
    const notMine = await call(node.nR.token, "POST", "/api/requirements", { name: "not mine", network_id: net });
    expect(notMine.status).toBe(403);
    expect(notMine.body.reason).toBe("mode_restricted_not_assigned");
    const viaMcp = await mcp(node.nR.token, "requirements_list", { network_id: net });
    expect((viaMcp.requirements ?? []).map((x: any) => x.id)).not.toContain(card.boss);
  });

  test("restricted: no broadcast, no network stream, no other session's stream; its own stream works", async () => {
    expect((await mcp(node.nR.token, "broadcast", { message: "hi all" })).reason).toBe("mode_restricted_not_assigned");
    expect((await call(node.nR.token, "POST", "/api/broadcast", { message: "hi", network_id: net })).body.reason).toBe("mode_restricted_not_assigned");
    expect((await sse(node.nR.token, `/events/network/${net}`)).status).toBe(403);
    expect((await sse(node.nR.token, `/events/${encodeURIComponent(node.other.alias)}?network_id=${net}`)).status).toBe(403);
    expect((await sse(node.nR.token, `/events/${encodeURIComponent(node.nR.alias)}?network_id=${net}`)).status).toBe(200);
  });
});

describe("enforce", () => {
  test("the same requests that were only logged are refused with node_permission_denied", async () => {
    process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
    // 主人看不见的卡:与不存在同一个 404(按主人的可见范围读)。
    expect((await call(node.nS.token, "PATCH", `/api/requirements/${card.boss}`, { description: "now refused" })).status).toBe(404);
    // 主人看得见(他是参与人)但改不了的卡:node_permission_denied。
    const w = await call(node.nS.token, "PATCH", `/api/requirements/${card.scoPart}`, { description: "now refused" });
    expect(w.status).toBe(403);
    expect(w.body).toMatchObject({ error: "node_permission_denied", reason: "beyond_owner_visibility" });
    const list = await call(node.nS.token, "GET", `/api/requirements?network_id=${net}`);
    expect(list.body.requirements.map((x: any) => x.id)).not.toContain(card.boss);
  });

  test("human-only actions are denied (REST and MCP); a node can still write its own attrs", async () => {
    process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
    const r = await call(node.nN.token, "PUT", `/api/nodes/${node.other.id}/attrs`, { display_name: "nope", base_attrs_revision: attrsRev(node.other.id) });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("human_only");
    expect((await mcp(node.nN.token, "projects_create", { network_id: net, name: `q-${stamp}` })).reason).toBe("human_only");
    expect((await call(node.nN.token, "PUT", `/api/nodes/${node.nN.id}/attrs`, { display_name: "me", base_attrs_revision: attrsRev(node.nN.id) })).status).toBe(200);
    expect((await mcp(node.nN.token, "send_task", { alias: node.other.alias, task: "still fine" })).ok).toBe(true);
  });

  test("off: nothing is evaluated or logged for normal nodes; explicit modes still apply", async () => {
    process.env.COMMHUB_NODE_PERMISSIONS = "off";
    const before = JSON.stringify(logRows(node.nS.id));
    expect((await call(node.nS.token, "PATCH", `/api/requirements/${card.boss}`, { description: "off" })).status).toBe(200);
    expect(JSON.stringify(logRows(node.nS.id))).toBe(before);
    expect((await call(node.nRO.token, "PATCH", `/api/requirements/${card.boss}`, { description: "still read-only" })).status).toBe(403);
  });
});

describe("PUT /api/nodes/:id/permission-mode", () => {
  test("owner and network owner/admin can set it and it applies on the next request; others cannot", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "readonly" })).body).toMatchObject({ ok: true, permission_mode: "readonly", previous: "normal" });
    expect((await call(node.nN.token, "PATCH", `/api/requirements/${card.boss}`, { description: "mode flip" })).body.reason).toBe("mode_readonly");
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "normal" })).status).toBe(200);
    expect((await call(node.nN.token, "PATCH", `/api/requirements/${card.boss}`, { description: "mode flip" })).status).toBe(200);
    expect((await call(user.sco.token, "PUT", `/api/nodes/${node.nS.id}/permission-mode`, { mode: "restricted" })).status).toBe(200); // sco 是 nS 的主人
    expect((await call(user.sco.token, "PUT", `/api/nodes/${node.nS.id}/permission-mode`, { mode: "normal" })).status).toBe(200);
    // #3354 —— 403 之后**行必须没变**。只断状态码时，「拒了但已经写进去」也会绿，
    // 而那是这条路由最坏的一种缺陷（拒绝语义看起来对，实际改了数据）。
    const modeBeforeDenied = db.get<{ permission_mode: string }>(
      "SELECT permission_mode FROM nodes WHERE node_id = ?1", node.nN.id)!.permission_mode;
    expect((await call(user.mem.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "readonly" })).status).toBe(403);
    const modeAfterDenied = db.get<{ permission_mode: string }>(
      "SELECT permission_mode FROM nodes WHERE node_id = ?1", node.nN.id)!.permission_mode;
    expect(modeAfterDenied).toBe(modeBeforeDenied);
    expect((await call(node.nN.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "normal" })).body.error).toBe("user_token_required");
    expect((await call(user.out.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "readonly" })).status).toBe(404);
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "admin" })).status).toBe(400);
    expect(db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'node_permission_mode_changed' AND target_id = ?1", node.nN.id)!.n).toBeTruthy();
  });
});

describe("GET /api/nodes viewer_can.permission_mode (#489)", () => {
  test("true exactly for the callers PUT …/permission-mode accepts; node tokens get false; /health advertises it", async () => {
    const canFor = async (token: string, nodeKey: string) =>
      (await call(token, "GET", `/api/nodes?node_id=${node[nodeKey].id}&network_id=${net}`)).body.nodes?.[0]?.viewer_can?.permission_mode;
    expect(await canFor(user.boss.token, "nN")).toBe(true);   // 网络 owner
    expect(await canFor(user.sco.token, "nS")).toBe(true);    // 节点主人(普通成员)
    expect(await canFor(user.sco.token, "nN")).toBe(false);   // 成员,不是主人
    expect(await canFor(user.mem.token, "nN")).toBe(false);
    expect(await canFor(node.nN.token, "nN")).toBe(false);    // 节点令牌永远不能改
    const list = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}`);
    expect(list.body.nodes.every((n: any) => !("owner_user_id" in n))).toBe(true);
    const health = await fetch(`${base}/health`).then((r) => r.json()) as any;
    expect(health.capabilities).toContain("node_permission_mode");
    // 与写接口一致:viewer_can=false 的人 PUT 得到 403
    expect((await call(user.mem.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "normal" })).status).toBe(403);
  });
});

describe("GET /api/networks/:id/node-permission-report", () => {
  // #3316 判据④ 在**这个字段上不可满足**，而原因是 schema：`permission_mode` 是
  // `NOT NULL DEFAULT 'normal'` ⇒ 「从未设置」在库层面不存在，任何读口都只能给出 normal。
  //
  // 我试过加 `permission_mode_source: explicit|default`，但实测它恒为 explicit
  // （因为列不可能为 NULL）⇒ 那样的字段比没有更糟：它长得像三态，实际是常量。
  // ⇒ 回滚该字段，改成把这条**结构性边界**钉住：谁若允许 NULL，这条会红并强制更新读口。
  test("permission_mode 是 NOT NULL DEFAULT 'normal' ⇒ 「没设过」在库层面不可表达（#3316 判据④ 的前置）", () => {
    const ddl = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'")!.sql;
    expect(ddl).toMatch(/permission_mode\s+TEXT\s+NOT NULL\s+DEFAULT\s+'normal'/);
    const fresh = `n_fresh_${Math.random().toString(36).slice(2, 8)}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state) VALUES (?1, ?1, ?1, ?2, 'active')", [fresh, net]);
    expect(db.get<{ permission_mode: string }>("SELECT permission_mode FROM nodes WHERE node_id = ?1", fresh)!.permission_mode).toBe("normal");
  });

  test("owner sees would-have-blocked counts per node; members and node tokens are refused", async () => {
    const r = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(r.status).toBe(200);
    const nS = r.body.nodes.find((n: any) => n.node_id === node.nS.id);
    expect(nS.by_reason.beyond_owner_visibility).toBeGreaterThanOrEqual(2);
    expect(nS.alias).toBe(node.nS.alias);
    expect(r.body.total).toBe(r.body.nodes.reduce((n: number, e: any) => n + e.total, 0));
    expect((await call(user.mem.token, "GET", `/api/networks/${net}/node-permission-report`)).status).toBe(403);
    expect((await call(node.nN.token, "GET", `/api/networks/${net}/node-permission-report`)).status).toBe(403);
    expect((await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report?since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`)).body.total).toBe(0);
  });

  // #2969 —— 设白名单之前，管理员要能看「这台节点实际用过哪些工具」，
  // 否则白名单只能凭想象写，第一次上线就拦掉在用的东西。
  //
  // 关键的第二条：一台**从不越界**但天天在用的节点，过去在报表里根本不存在
  // （nodes 只从「被拒过的行」聚合）。它恰恰是最该出现在名单里的那台。
  test("按节点的工具调用明细：从不越界的节点也要出现", async () => {
    await mcp(node.nN.token, "list_tasks", { network_id: net, limit: 1 });
    await mcp(node.nN.token, "list_tasks", { network_id: net, limit: 1 });
    const r = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(r.status).toBe(200);
    const nN = r.body.nodes.find((n: any) => n.node_id === node.nN.id);
    expect(nN).toBeTruthy();
    expect(nN.tool_calls_total).toBeGreaterThanOrEqual(2);
    const listTasks = nN.tool_calls.find((t: any) => t.tool === "mcp:list_tasks");
    expect(listTasks.hits).toBeGreaterThanOrEqual(2);
    // 排序也变了：按调用量降序，让「用得最多」的排在最前
    expect(r.body.nodes[0].tool_calls_total).toBeGreaterThanOrEqual(nN.tool_calls_total);
    // 网络级合计保持不变（旧口径不能因为这次改动而变）
    expect(r.body.tool_calls.total).toBeGreaterThanOrEqual(nN.tool_calls_total);
  });
});

// #2823 —— 调用面计数：拒绝日志给不了分母。
// 生产 30 天 `node_permission_log` 0 行，分不清「没人越界」和「没人碰过这些工具」，
// 而 #525 要切 enforce，恰恰需要一个分母。
describe("#2823 计数表的上限必须覆盖整个保留期", () => {
  // 撞上限的后果是**静默归零**（callLogFull 只给已有行加次数、不插新行），
  // 而这正是 #525 用来判「要不要切 enforce」的判据 —— 读到归零会把「没人调用」当结论。
  // 生产实测 75 行/小时（.184 上线首小时）；这里按 100 行/小时留余量。
  test("TOOL_CALL_MAX_ROWS 覆盖 LOG_RETENTION_DAYS × 100 行/小时，否则会在保留期内静默停表", async () => {
    const { TOOL_CALL_MAX_ROWS, LOG_RETENTION_DAYS } = await import("./node-permissions.js");
    const worstCasePerHour = 100;
    expect(TOOL_CALL_MAX_ROWS).toBeGreaterThanOrEqual(LOG_RETENTION_DAYS * 24 * worstCasePerHour);
    // 反向验证这条测试有判别力：旧的 20 000 必须不满足
    expect(20_000).toBeLessThan(LOG_RETENTION_DAYS * 24 * worstCasePerHour);
  });
});

describe("#2823 调用面计数（node_tool_calls）", () => {
  const callHits = (nodeId: string, tool: string) => Number(
    db.get<{ h: number | string | null }>(
      "SELECT SUM(hits) AS h FROM node_tool_calls WHERE network_id = ?1 AND node_id = ?2 AND tool = ?3",
      net, nodeId, tool,
    )?.h ?? 0);
  const denyRows = (nodeId: string) => logRows(nodeId).length;
  const toolCallTotal = (nodeId: string) => Number(
    db.get<{ h: number | string | null }>(
      "SELECT SUM(hits) AS h FROM node_tool_calls WHERE network_id = ?1 AND node_id = ?2",
      net, nodeId,
    )?.h ?? 0);

  test("放行的调用也计数，但**不进**拒绝日志（两张表分开）", async () => {
    const before = { calls: toolCallTotal(node.nN.id), denials: denyRows(node.nN.id) };
    expect((await mcp(node.nN.token, "send_task", { alias: node.other.alias, task: "counted" })).ok).toBe(true);
    expect((await mcp(node.nN.token, "send_task", { alias: node.other.alias, task: "counted again" })).ok).toBe(true);
    expect(toolCallTotal(node.nN.id)).toBe(before.calls + 2);
    expect(callHits(node.nN.id, "mcp:send_task")).toBeGreaterThanOrEqual(2);
    // 关键：分母涨了，分子（拒绝）没动 —— 这才叫「命中率」可算。
    expect(denyRows(node.nN.id)).toBe(before.denials);
  });

  // #2971 —— 读类 / 需求类 / 排程类原来根本不到闸里，账本因此完全看不到它们。
  // 而敏感读恰恰在这一类里（list_network_secrets / list_providers / tail_node_logs）。
  // 修法只有一个方向：**记账，但不判定** —— 拦截语义必须零变化。
  test("#2971 读类工具会被计数，且行为不变（不被拦、不进拒绝日志）", async () => {
    const before = { calls: callHits(node.nN.id, "mcp:list_providers"), denials: denyRows(node.nN.id) };
    const r = await mcp(node.nN.token, "list_providers", { network_id: net });
    expect(r.error).not.toBe("node_permission_denied");
    expect(callHits(node.nN.id, "mcp:list_providers")).toBe(before.calls + 1);
    expect(denyRows(node.nN.id)).toBe(before.denials);
  });

  test("#2971 always 类不进账本（心跳会把账本淹掉）", async () => {
    const before = toolCallTotal(node.nN.id);
    await mcp(node.nN.token, "get_inbox", { alias: node.nN.alias });
    expect(toolCallTotal(node.nN.id)).toBe(before);
  });

  test("本来会被拒的调用两个表都记（分子与分母同源）", async () => {
    const beforeCalls = callHits(node.nN.id, "mcp:projects_create");
    const beforeDeny = hitsOf(node.nN.id, "mcp:projects_create", "human_only");
    const p = await mcp(node.nN.token, "projects_create", { network_id: net, name: `p-count-${stamp}` });
    expect(p.error).not.toBe("node_permission_denied");
    expect(callHits(node.nN.id, "mcp:projects_create")).toBe(beforeCalls + 1);
    expect(hitsOf(node.nN.id, "mcp:projects_create", "human_only")).toBe(beforeDeny + 1);
  });

  test("报表同时给分母与分子，且拒绝口径 total 不被放行调用污染", async () => {
    const before = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(before.status).toBe(200);
    const beforeDenied = Number(before.body.total);
    const beforeCalls = Number(before.body.tool_calls.total);

    expect((await mcp(node.nN.token, "send_task", { alias: node.other.alias, task: "report bump" })).ok).toBe(true);

    const after = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(after.status).toBe(200);
    expect(Number(after.body.tool_calls.total)).toBe(beforeCalls + 1);
    expect(Number(after.body.total)).toBe(beforeDenied);
    expect(Array.isArray(after.body.tool_calls.by_tool)).toBe(true);
    expect(after.body.tool_calls.by_tool.every((r: any) => typeof r.tool === "string" && typeof r.hits === "number")).toBe(true);
  });

  test("节点令牌读不到报表（分母同样只给人看）", async () => {
    expect((await call(node.nN.token, "GET", `/api/networks/${net}/node-permission-report`)).status).toBe(403);
  });
});

describe("bookkeeping", () => {
  test("every MCP tool a node can call has a permission class", async () => {
    const s = new McpServer({ name: "np", version: "1" });
    registerTools(s, undefined, net, user.boss.id, node.nN.alias, true, node.nN.tokenId);
    const client = new Client({ name: "np-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await s.connect(st); await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close(); await s.close();
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((n) => !NODE_TOOL_CLASS[n])).toEqual([]);
  });

  test("log rows older than the retention window are pruned", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 13);
    db.run("INSERT INTO node_permission_log (network_id, node_id, route, reason, hour, hits) VALUES (?1, ?2, 'old', 'human_only', ?3, 5)", [net, node.nN.id, old]);
    pruneNodePermissionLog();
    __resetNodePermissionLogStateForTest();
    expect(db.get("SELECT 1 AS hit FROM node_permission_log WHERE route = 'old'")).toBeFalsy();
  });
});

// #2969 / #1510 —— 「能设」之外还差一半：「能看到当前设的是什么」。
//
// 两张白名单原先只有 PUT，`GET /api/nodes` 里一个字都没有，客户端因此做不出
// 「当前设置」这一屏 —— 能写不能读，等于逼用户凭记忆操作。
// 同一处还给 #1510 的严格模式留了眼睛：管理员要能看出谁的 transport 未知。
describe("GET /api/nodes 读回白名单与 transport", () => {
  const rowOf = async (nodeId: string) => {
    const r = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${nodeId}`);
    expect(r.status).toBe(200);
    expect(r.body.nodes).toHaveLength(1);
    return r.body.nodes[0];
  };

  test("默认是 null（= 不限制），不是空数组", async () => {
    const row = await rowOf(node.other.id);
    expect(row.peer_allowlist).toBeNull();
    expect(row.tool_allowlist).toBeNull();
  });

  test("写进去什么，读出来就是什么", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: ["boss", node.nR.id] })).status).toBe(200);
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: ["send_task", "get_inbox"] })).status).toBe(200);
    const row = await rowOf(node.other.id);
    expect(row.peer_allowlist).toEqual(["boss", node.nR.id]);
    expect(row.tool_allowlist).toEqual(["send_task", "get_inbox"]);
  });

  // #3354 —— 白名单路由的 L3 证据：拒绝必须同时证明「403」与「行没变」，允许要有镜像。
  test("改白名单：成员 403 且**行没变**；owner 200 且行真的变（镜像）", async () => {
    const read = () => db.get<{ tool_allowlist: string | null }>(
      "SELECT tool_allowlist FROM nodes WHERE node_id = ?1", node.other.id)!.tool_allowlist;
    const before = read();
    const denied = await call(user.mem.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: ["send_task"] });
    expect(denied.status).toBe(403);
    // 只断 403 时，「拒了但已经写进去」也会绿 —— 而那正是这条路由最坏的一种缺陷。
    expect(read()).toBe(before);
    // 镜像：允许时必须真的变，否则「永远拒绝」也会绿。
    const ok = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: ["send_task"] });
    expect(ok.status).toBe(200);
    expect(read()).not.toBe(before);
  });

  // #3354 —— rest-allowlist 此前**一条测试都没有**（同族里唯一零覆盖的写路由）。
  // 它改的是「这个节点能调哪些 REST 路由」，与 tool-allowlist 同一套授权口径。
  // #3354 —— POST /api/tmux/:id/send：三层门里最外层的一条。
  // 门 = TMUX_ENABLED → IP 白名单 → 管理员。测试环境默认第 1 层就是关的，
  // 于是这条路由在**功能未启用**时必须是 404 拒绝，而不是「悄悄成功」。
  // ⚠ 允许路径需要真 tmux，本仓测试不具条件 ⇒ 只验拒绝（证据表里标了 note）。
  test("tmux send：功能未启用时 404 拒绝，且不返回任何执行痕迹", async () => {
    const r = await call(user.boss.token, "POST", "/api/tmux/whatever/send", { text: "echo pwned" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("tmux disabled");
    // 「拒了」还要求「没有假装成功」：ok 必须是 false（不是 true、也不是缺失 ——
    // 缺失会让调用方按 `if (!body.ok)` 之外的写法读成成功），且不许有 sent 字段。
    expect(r.body.ok).toBe(false);
    expect(r.body.sent).toBeUndefined();
  });

  // #3354 —— PUT /api/nodes/:id/avatar：拒绝之后 avatar_url 必须没变。
  // 门与 attrs 相同（canRestWriteNetwork + restNodeDenied）⇒ 拒绝方是 readonly 模式下的节点自己，
  // 不是普通成员（成员有网络写权是设计如此 —— 第一次按节点主人模板写就猜错了）。
  // #3018 判据④ —— 「GET 只可能返回 null 或非空数组」这句话要能扛住**库里的历史 []**。
  // 客户端收不到 []，才无从把它读成「全部禁止」。
  test("库里有历史 [] ⇒ GET 读回 null（不是 []），三条白名单都一样", async () => {
    const target = node.other.id;
    db.run("UPDATE nodes SET tool_allowlist = '[]', rest_allowlist = '[]', peer_allowlist = '[]' WHERE node_id = ?1", [target]);
    const row = (await call(user.boss.token, "GET", `/api/nodes?node_id=${target}&network_id=${net}`)).body.nodes[0];
    expect(row.tool_allowlist).toBeNull();
    expect(row.rest_allowlist).toBeNull();
    expect(row.peer_allowlist).toBeNull();
    // 否定断言配镜像：非空的仍然原样返回
    db.run(`UPDATE nodes SET tool_allowlist = '["send_task"]' WHERE node_id = ?1`, [target]);
    const row2 = (await call(user.boss.token, "GET", `/api/nodes?node_id=${target}&network_id=${net}`)).body.nodes[0];
    expect(row2.tool_allowlist).toEqual(["send_task"]);
    db.run("UPDATE nodes SET tool_allowlist = NULL WHERE node_id = ?1", [target]);
  });

  test("改节点头像：readonly 节点被拒且 avatar_url 没变；owner 200 且真的变了（镜像）", async () => {
    const read = () => db.get<{ avatar_url: string | null }>(
      "SELECT avatar_url FROM nodes WHERE node_id = ?1", node.other.id)!.avatar_url;
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "readonly" })).status).toBe(200);
    const before = read();
    const denied = await call(node.other.token, "PUT", `/api/nodes/${node.other.id}/avatar`, { avatar_url: "/avatars/avatar-11.webp" });
    expect(denied.status).toBe(403);
    expect(read()).toBe(before);
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "normal" })).status).toBe(200);
    const ok = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/avatar`, { avatar_url: "/avatars/avatar-11.webp" });
    expect(ok.status).toBe(200);
    expect(read()).not.toBe(before);
  });

  // #3354 —— DELETE /api/nodes/:id：拒绝之后**行必须还在**。
  // 这是唯一一条「只要写进去了就不可逆」的写路由 —— 拒了但删了，没有任何读数能复原。
  // 用**可丢弃的 scratch 节点**做靶子：拒绝方是 readonly 模式下的 node.other，
  // 这样 witness 若让闸失效，被误删的也只是 scratch，不会连带毁掉后面用例的公共夹具。
  test("删节点：readonly 调用者被拒且行还在；owner 允许且行真的没了", async () => {
    const scratch = `n_del_${Math.random().toString(36).slice(2, 8)}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state) VALUES (?1, ?1, ?1, ?2, 'active')", [scratch, net]);
    expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", scratch)).toBeTruthy();
    // ① 拒绝：readonly 的 node.other 去删 scratch ⇒ 403，且 scratch 还在
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "readonly" })).status).toBe(200);
    const denied = await call(node.other.token, "DELETE", `/api/nodes/${scratch}`);
    expect(denied.status).toBe(403);
    expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", scratch)).toBeTruthy();
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "normal" })).status).toBe(200);
    // ② 允许：owner 删同一个 scratch ⇒ 200 且行真的没了（镜像）
    const ok = await call(user.boss.token, "DELETE", `/api/nodes/${scratch}`);
    expect(ok.status).toBe(200);
    expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", scratch)).toBeFalsy();
  });

  // #3354 —— ATTRS：这条的门是 canRestWriteNetwork + restNodeDenied，另有**乐观锁**。
  // 普通成员有网络写权是设计如此 ⇒ 这里的拒绝方是「readonly 模式下的节点自己」。
  // 三件事必须一起钉：① 拒绝且行没变 ② 允许且行真变 ③ 旧 revision ⇒ 409 且行没变。
  test("改 attrs：readonly 节点被拒且行没变；owner 200 且行真变；旧 revision 409 且行没变", async () => {
    const row = () => db.get<{ display_name: string | null; attrs_revision: number | string }>(
      "SELECT display_name, attrs_revision FROM nodes WHERE node_id = ?1", node.other.id)!;
    // 先把节点设成 readonly（owner 才做得动），再让节点自己写属性 ⇒ 必须被拒
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "readonly" })).status).toBe(200);
    const before = row();
    const denied = await call(node.other.token, "PUT", `/api/nodes/${node.other.id}/attrs`, {
      display_name: "pwned", base_attrs_revision: Number(before.attrs_revision),
    });
    expect(denied.status).toBe(403);
    expect(row()).toEqual(before);          // 拒绝不许改数据（名字与 revision 都要看）
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/permission-mode`, { mode: "normal" })).status).toBe(200);
    // 允许：200 且名字变了、revision 前进
    const ok = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/attrs`, {
      display_name: "renamed-by-owner", base_attrs_revision: Number(before.attrs_revision),
    });
    expect(ok.status).toBe(200);
    const after = row();
    expect(after.display_name).toBe("renamed-by-owner");
    expect(Number(after.attrs_revision)).toBeGreaterThan(Number(before.attrs_revision));
    // 旧 revision 再写：409，且行不许被这次写入改掉
    const conflict = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/attrs`, {
      display_name: "lost-the-race", base_attrs_revision: Number(before.attrs_revision),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("attrs_revision_conflict");
    expect(row()).toEqual(after);
  });

  // #3354 —— peer-allowlist 原本只有 200 / 400 / null，没有 403 分支。
  // 它改的是「这个节点能跟哪些 peer 通信」⇒ 被拒失败等于任何人可改它的通信边界。
  test("改 peer 白名单：成员 403 且**行没变**；owner 200 且行真的变（镜像）", async () => {
    const read = () => db.get<{ peer_allowlist: string | null }>(
      "SELECT peer_allowlist FROM nodes WHERE node_id = ?1", node.other.id)!.peer_allowlist;
    const before = read();
    const denied = await call(user.mem.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: ["boss"] });
    expect(denied.status).toBe(403);
    expect(read()).toBe(before);   // 拒绝不许改数据
    const ok = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: ["boss"] });
    expect(ok.status).toBe(200);
    expect(read()).not.toBe(before); // 镜像：允许时必须真的变
  });

  test("改 REST 白名单：成员 403 且**行没变**；owner 200 且行真的变（镜像）；[] 歧义 400", async () => {
    const read = () => db.get<{ rest_allowlist: string | null }>(
      "SELECT rest_allowlist FROM nodes WHERE node_id = ?1", node.other.id)!.rest_allowlist;
    const before = read();
    // ① 拒绝：403 且行必须没变（只断 403 时「拒了但已写入」也会绿）
    const denied = await call(user.mem.token, "PUT", `/api/nodes/${node.other.id}/rest-allowlist`, { routes: ["POST /api/task"] });
    expect(denied.status).toBe(403);
    expect(read()).toBe(before);
    // ② 镜像：允许时必须真的变（只测拒绝时「永远拒绝」也会绿）
    const ok = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/rest-allowlist`, { routes: ["POST /api/task"] });
    expect(ok.status).toBe(200);
    expect(read()).not.toBe(before);
    // ③ 空数组是歧义的：拒收，且不许落库（与 tool-allowlist 同一决定）
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/rest-allowlist`, { routes: [] })).body.error)
      .toBe("empty_allowlist_ambiguous");
    expect(read()).toBe(JSON.stringify(["POST /api/task"]));
    // ④ 清空请传 null
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/rest-allowlist`, { routes: null })).status).toBe(200);
    expect(read()).toBeNull();
  });

  test("清空后回到 null，而不是 []", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: null })).status).toBe(200);
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: null })).status).toBe(200);
    const row = await rowOf(node.other.id);
    expect(row.peer_allowlist).toBeNull();
    expect(row.tool_allowlist).toBeNull();
  });

  test("env_transport 取该节点最新一次上报（老上报不能盖掉新的）", async () => {
    // 两行同 node_id、不同时间：取 updated_at 更大的那条。
    db.run("DELETE FROM sessions WHERE node_id = ?1", [node.nR.id]);
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at) VALUES (?1, ?2, 'idle', ?3, ?4, 'plain', datetime('now','-2 hour'))",
      [`r_old_${node.nR.id}`, "r-old-alias", node.nR.id, net]);
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at) VALUES (?1, ?2, 'idle', ?3, ?4, 'https', datetime('now','-1 minute'))",
      [`r_new_${node.nR.id}`, "r-new-alias", node.nR.id, net]);
    expect((await rowOf(node.nR.id)).env_transport).toBe("https");
  });

  test("从没上报过的节点是 null（不是猜一个值填上）", async () => {
    db.run("UPDATE sessions SET env_transport = NULL WHERE node_id = ?1", [node.nR.id]);
    expect((await rowOf(node.nR.id)).env_transport).toBeNull();
  });

  test("别的网络里的同名字段不会串到这一格（alias 兜底必须带网络约束）", async () => {
    // 场景：本网络有一台节点，它的 sessions 行只用 alias 命中（node_id 为空，
    // alias 就等于节点 id —— 老注册路径就是这样）。
    // 另一个网络里**恰好也有一个 alias 相同的 sessions 行**，而且是明文公网、时间更新。
    //
    // 如果兜底查询不按网络约束，这一格会把 B 网的 'plain' 显示成 A 网这台节点的 transport。
    // 这一格是给人做安全决策用的（决定要不要打开 strict）——
    // 显示错的 'plain' 会让人以为挡住了，其实挡的是别人；显示 null 至少会让人去查。
    const shadowId = `n_np_shadow_${stamp}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state) VALUES (?1, ?1, ?2, ?3, 'active')",
      [shadowId, `shadow-${stamp}`, net]);
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at) VALUES (?1, ?2, 'idle', NULL, ?3, 'https', datetime('now','-1 hour'))",
      [`s_shadow_${stamp}`, shadowId, net]);
    const otherOwner = register(`np_othernet_${stamp}_${Date.now()}`, PW);
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at) VALUES (?1, ?2, 'idle', NULL, ?3, 'plain', datetime('now','+1 hour'))",
      [`s_shadow_other_${stamp}`, shadowId, otherOwner.network_id!]);

    // 本网络这台的 'https' 必须赢；时间更新的 'plain' 不能跨网络串进来。
    expect((await rowOf(shadowId)).env_transport).toBe("https");
  });
});

// #2969 —— 空数组是歧义的，Hub 直接拒，不猜。
//
// 客户端（PR #1165）把「[] = 不允许任何」做进了界面，而 Hub 的 `length ? … : null`
// 会把 [] 规范化成 null = 不限制。两边语义相反：用户以为收紧了，系统其实放开了。
// 三种做法里选了最不含糊的一种 —— 拒收，让调用方当场看到 400 和「清空请传 null」。
describe("空数组不猜：拒收，清空请传 null", () => {
  test("PUT tool-allowlist [] → 400 empty_allowlist_ambiguous，且没改动库里已有值", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: ["send_task"] })).status).toBe(200);
    const r = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("empty_allowlist_ambiguous");
    // 关键：拒收不能顺手把它清掉 —— 那等于「报错了，但行为已经变了」。
    const row = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.other.id}`);
    expect(row.body.nodes[0].tool_allowlist).toEqual(["send_task"]);
  });

  test("PUT peer-allowlist [] → 400，库里也没变", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: ["boss"] })).status).toBe(200);
    const r = await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/peer-allowlist`, { peers: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("empty_allowlist_ambiguous");
    const row = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.other.id}`);
    expect(row.body.nodes[0].peer_allowlist).toEqual(["boss"]);
  });

  test("清空走 null：200，读回来是 null（不是 []）", async () => {
    expect((await call(user.boss.token, "PUT", `/api/nodes/${node.other.id}/tool-allowlist`, { tools: null })).status).toBe(200);
    const row = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.other.id}`);
    expect(row.body.nodes[0].tool_allowlist).toBeNull();
  });
});

// #2969 / #2971 —— 未绑定节点的令牌是权限体系的一个真实盲点：
// 账本用 `token:<token_id>` 当键，它们没有 nodes 行 ⇒ 两张白名单都管不到（toolAllowlist 为 null）。
// 报表必须把它们标出来，否则管理员会以为「名单之外没有别人在派活」。
describe("未绑定节点的令牌在报表里必须可见", () => {
  test("token: 键的条目带 unbound_token=true，真实节点不带", async () => {
    db.run(`INSERT INTO node_tool_calls (network_id, node_id, tool, hour, hits) VALUES (?1, ?2, 'mcp:send_task', ?3, 4)
            ON CONFLICT(network_id, node_id, tool, hour) DO UPDATE SET hits = node_tool_calls.hits + 4`,
      [net, "token:tok_unbound_test", new Date().toISOString().slice(0, 13)]);
    const r = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(r.status).toBe(200);
    const unbound = r.body.nodes.find((n: any) => n.node_id === "token:tok_unbound_test");
    expect(unbound).toBeTruthy();
    expect(unbound.unbound_token).toBe(true);
    expect(unbound.tool_calls_total).toBeGreaterThanOrEqual(4);
    const real = r.body.nodes.find((n: any) => n.node_id === node.nN.id);
    expect(real.unbound_token).toBeUndefined();
    // 令牌名要带出来 —— 只看 `token:tok_xxx` 无法处理；名字才是「该改哪个令牌」的答案。
    const tokRow = db.get<{ token_id: string }>("SELECT token_id FROM api_tokens LIMIT 1");
    db.run(`INSERT INTO node_tool_calls (network_id, node_id, tool, hour, hits) VALUES (?1, ?2, 'mcp:send_task', ?3, 1)
            ON CONFLICT(network_id, node_id, tool, hour) DO UPDATE SET hits = node_tool_calls.hits + 1`,
      [net, `token:${tokRow.token_id}`, new Date().toISOString().slice(0, 13)]);
    const r2 = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    const withName = r2.body.nodes.find((n: any) => n.node_id === `token:${tokRow.token_id}`);
    expect(withName.unbound_token_name).toBeTruthy();
  });
});

// #2969 续 —— 令牌解析不到节点行时，两张白名单都管不到它。
// 先按「记录」跑：`unbound_token` 不在 MODE_REASONS 里 ⇒ 默认 log 模式只记账、不改变行为。
// 这样「要不要强制要求绑定令牌」这个决定，将来自有数据可依据（而不是靠猜会不会炸）。
describe("未绑定令牌的写调用：默认只记录，不拦", () => {
  // 造一个**解析不到节点**的令牌：名字里的 alias 在本网络没有对应 nodes 行。
  // 这就是线上那 4 个令牌的真实形状（节点改名、令牌名没跟着改）。
  const unboundKey = () => {
    const alias = `ghost-alias-${stamp}`;
    const tokenId = `tok_ghost_${stamp}`;
    // 🔴 不能用 `INSERT OR IGNORE`：那是 SQLite 专有语法，PostgreSQL 会直接
    // `syntax error at or near "OR"`（test2123-hub-postgres-ladder 实测）。
    // 两边都认的写法是 ON CONFLICT ... DO NOTHING。
    db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'network') ON CONFLICT (token_id) DO NOTHING",
      [tokenId, `hash_${tokenId}`, user.boss.id, net, `node:${alias}`]);
    return tokenId;
  };

  test("log 模式：写调用照常成功，但进 node_permission_log（reason=unbound_token）", async () => {
    const tokenId = unboundKey();
    const key = `token:${tokenId}`;
    const before = Number(db.get<{ h: number | string | null }>(
      "SELECT SUM(hits) AS h FROM node_permission_log WHERE network_id = ?1 AND node_id = ?2 AND reason = 'unbound_token'",
      net, key)?.h ?? 0);
    // 用一个「解析不到节点」的身份直接走判定，绕开 HTTP 令牌构造（这里验的是判据与记账）
    const { nodeIdentity, nodeDecide } = await import("./node-permissions.js");
    const id = nodeIdentity(tokenId, net)!;
    expect(id.nodeId).toBeNull();
    const allowed = nodeDecide(id, "mcp:send_task", { reason: "unbound_token", sample: "send_task" });
    expect(allowed).toBe(false); // log 模式：不拦
    const after = Number(db.get<{ h: number | string | null }>(
      "SELECT SUM(hits) AS h FROM node_permission_log WHERE network_id = ?1 AND node_id = ?2 AND reason = 'unbound_token'",
      net, key)?.h ?? 0);
    expect(after).toBe(before + 1); // 但记了一笔
  });

  // 🔴 令牌前缀必须是 `ntok_`：`atok_` 会被当成**用户**令牌（服务端按前缀分流），
  // 那样测出来的是「用户派活」，不是「未绑定节点令牌派活」—— 我第一次就这么写错了，
  // 结果任务记在 boss 名下、账本一行都没有。
  // 🔴 上面两条只调了**判据函数**（nodeDecide），而生产里真正决定「记不记」的是
  // tools.ts 里那层 MCP 包装：它只在 `if (id)` 内部才走到判据。如果哪天有人把包装
  // 改成「只对绑定节点记账」，上面两条测试仍然全绿，而未绑定令牌的写调用会**静默消失** ——
  // 那正是 #3221 想解决的问题。所以这里补一条真正走 HTTP + MCP 的端到端。
  test("HTTP 端到端：未绑定令牌真的调 MCP send_task ⇒ 进 node_permission_log", async () => {
    const alias = `ghost-e2e-${stamp}`;
    const tokenId = `tok_ghost_e2e_${stamp}`;
    const plain = `ntok_ghost_e2e_${stamp}`;
    db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'network') ON CONFLICT (token_id) DO NOTHING",
      [tokenId, hashToken(plain), user.boss.id, net, `node:${alias}`]);

    const out = await mcp(plain, "send_task", { alias: node.nN.alias, task: "hello from a ghost token" });
    // log 模式（默认）：不因「未绑定」被拦 —— 拦不拦是另一个开关的事
    expect(out.error ?? "").not.toBe("unbound_token");

    const hits = Number(db.get<{ h: number | string | null }>(
      `SELECT SUM(hits) AS h FROM node_permission_log
        WHERE network_id = ?1 AND node_id = ?2 AND reason = 'unbound_token' AND route = 'mcp:send_task'`,
      net, `token:${tokenId}`)?.h ?? 0);
    expect(hits).toBe(1);
  });

  test("enforce 模式：同一个调用被拒，原因是 unbound_token", async () => {
    process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
    const { nodeIdentity, nodeDecide } = await import("./node-permissions.js");
    const id = nodeIdentity(unboundKey(), net)!;
    expect(nodeDecide(id, "mcp:send_task", { reason: "unbound_token", sample: "send_task" })).toBe(true);
  });
});

// #2719 —— 凭据台账：把「哪把钥匙、绑没绑、还在不在用」变成可查的东西。
//
// 为什么需要它：node-permission-report 是按**流量**聚合的，只列出「近 N 天有调用」的身份。
// 生产实测 760 个未吊销令牌里 381 个是 `node:` 开头但未绑定，而其中只有 4 个近 24h 出现过 ——
// 剩下 377 个在任何报表里都不存在，于是「这把钥匙还有人在用吗」永远答不清，也就不敢吊销。
describe("#2719 凭据台账", () => {
  test("owner 能看到未绑定令牌，区分「有流量」与「零流量」", async () => {
    const loudId = `tok_ledger_loud_${stamp}`;
    const quietId = `tok_ledger_quiet_${stamp}`;
    for (const [id, nm] of [[loudId, "node:ledger-loud"], [quietId, "node:ledger-quiet"]] as const) {
      db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'network') ON CONFLICT (token_id) DO NOTHING",
        [id, `hash_${id}`, user.boss.id, net, nm]);
    }
    const hour = new Date().toISOString().slice(0, 13);
    db.run(`INSERT INTO node_tool_calls (network_id, node_id, tool, hour, hits) VALUES (?1, ?2, 'mcp:send_task', ?3, 5)
            ON CONFLICT(network_id, node_id, tool, hour) DO UPDATE SET hits = node_tool_calls.hits + 5`,
      [net, `token:${loudId}`, hour]);

    const r = await call(user.boss.token, "GET", `/api/networks/${net}/token-ledger?limit=1000`);
    expect(r.status).toBe(200);
    const loud = r.body.tokens.find((t: any) => t.token_id === loudId);
    const quiet = r.body.tokens.find((t: any) => t.token_id === quietId);
    expect(loud.unbound_node).toBe(true);
    expect(loud.calls_24h).toBe(5);
    expect(loud.writes_24h).toBe(5);
    expect(quiet.calls_24h).toBe(0);          // 零流量也要在名单里 —— 这正是它存在的理由
    expect(r.body.summary.unbound_node).toBeGreaterThanOrEqual(2);
    // 绑定的节点令牌必须被标成「已绑定」，不能被算进未绑定
    const bound = r.body.tokens.find((t: any) => t.token_id === node.nN.tokenId);
    expect(bound.bound_node_id).toBe(node.nN.id);
    expect(bound.unbound_node).toBe(false);
  });

  // 🔴 线上第一次真实调用就抓到的 bug：`?limit=5` 时 summary.total 报 5，
  // 而那个网络实际有 580 个令牌。分页只该影响 tokens 数组，不该影响计数。
  test("分页只截断 tokens，不影响 summary（summary 必须是全量）", async () => {
    const full = await call(user.boss.token, "GET", `/api/networks/${net}/token-ledger?limit=1000`);
    expect(full.status).toBe(200);
    const page = await call(user.boss.token, "GET", `/api/networks/${net}/token-ledger?limit=1`);
    expect(page.status).toBe(200);
    expect(page.body.tokens.length).toBe(1);
    expect(page.body.returned).toBe(1);
    // 两个请求的 summary 必须完全一样
    expect(page.body.summary).toEqual(full.body.summary);
    expect(page.body.summary.total).toBeGreaterThan(1);
  });

  test("成员（非 owner/admin）看不到；节点令牌也看不到", async () => {
    const r = await call(user.mem.token, "GET", `/api/networks/${net}/token-ledger`);
    expect(r.status).toBe(403);
    const n = await call(node.nN.token, "GET", `/api/networks/${net}/token-ledger`);
    expect(n.status).toBe(403);
  });
});

// #2969 续 —— REST 写接口白名单：唯一 choke point。
//
// 为什么必须在中央判一次：节点令牌的 REST 写面分散在两套判据里
// （server.ts 的 restNodeDenied + requirements.ts 的 nodeTaskGate）。
// 逐站点加会变成第三套规则，且漏掉任一处就是「装了一半的安全开关」——
// 那比没有更危险，因为它会被当成已经收紧了。
describe("#2969 REST 写白名单", () => {
  test("路径归一化：11 条节点路由的标签逐字一致", async () => {
    const { restRouteLabel } = await import("./node-permissions.js");
    const cases: Array<[string, string, string]> = [
      ["POST", "/api/task", "POST /api/task"],
      ["POST", "/api/broadcast", "POST /api/broadcast"],
      ["DELETE", "/api/nodes/n_abc123", "DELETE /api/nodes/:id"],
      ["PUT", "/api/nodes/n_abc123/attrs", "PUT /api/nodes/:id/attrs"],
      ["PUT", "/api/nodes/node_9f8e7d/avatar", "PUT /api/nodes/:id/avatar"],
      ["PATCH", "/api/requirements/req_123", "PATCH /api/requirements/:id"],
      ["PATCH", "/api/requirements/req_123/checklist/it_9", "PATCH /api/requirements/:id/checklist/:id"],
      ["POST", "/api/requirements", "POST /api/requirements"],
      ["POST", "/api/requirements/req_123/comments", "POST /api/requirements/:id/comments"],
      ["PUT", "/api/nodes/tmwork_4ff6a3ee-f0b1-492c-abf6-132eea7b5e09/attrs", "PUT /api/nodes/:id/attrs"],
    ];
    for (const [m, p, want] of cases) expect(restRouteLabel(m, p)).toBe(want);
  });

  test("未设置清单 ⇒ 不判（不限制），行为与现在一致", async () => {
    const { nodeIdentity, restAllowlistVerdict } = await import("./node-permissions.js");
    const id = nodeIdentity(node.nN.tokenId, net)!;
    expect(id.restAllowlist).toBeNull();
    expect(restAllowlistVerdict(id, "POST /api/broadcast")).toBeNull();
  });

  test("设置了清单 ⇒ 清单外的写路由被拒，清单内的放行", async () => {
    const { nodeIdentity, restAllowlistVerdict } = await import("./node-permissions.js");
    db.run("UPDATE nodes SET rest_allowlist = ?1 WHERE node_id = ?2", [JSON.stringify(["POST /api/task"]), node.nN.id]);
    const id = nodeIdentity(node.nN.tokenId, net)!;
    expect(restAllowlistVerdict(id, "POST /api/task")).toBeNull();
    expect(restAllowlistVerdict(id, "POST /api/broadcast")).toMatchObject({ reason: "rest_not_allowed" });
    db.run("UPDATE nodes SET rest_allowlist = NULL WHERE node_id = ?1", [node.nN.id]);
  });

  test("HTTP：节点只有 POST /api/task 时，广播返回 403 rest_not_allowed", async () => {
    db.run("UPDATE nodes SET rest_allowlist = ?1 WHERE node_id = ?2", [JSON.stringify(["POST /api/task"]), node.nN.id]);
    const r = await call(node.nN.token, "POST", "/api/broadcast", { message: "should be blocked" });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("rest_not_allowed");
    db.run("UPDATE nodes SET rest_allowlist = NULL WHERE node_id = ?1", [node.nN.id]);
  });

  test("HTTP：用户令牌不受 REST 白名单影响（只对节点令牌生效）", async () => {
    db.run("UPDATE nodes SET rest_allowlist = ?1 WHERE node_id = ?2", [JSON.stringify(["POST /api/task"]), node.nN.id]);
    const r = await call(user.boss.token, "POST", `/api/requirements`, { name: `rest-allow-user-${stamp}`, network_id: net });
    expect(r.status).toBe(201);
    db.run("UPDATE nodes SET rest_allowlist = NULL WHERE node_id = ?1", [node.nN.id]);
  });

  test("GET 读回 rest_allowlist（null = 不限制）", async () => {
    db.run("UPDATE nodes SET rest_allowlist = ?1 WHERE node_id = ?2", [JSON.stringify(["POST /api/task", "PATCH /api/requirements/:id"]), node.nN.id]);
    const r = await call(user.boss.token, "GET", `/api/nodes?network_id=${net}&node_id=${node.nN.id}`);
    expect(r.body.nodes[0].rest_allowlist).toEqual(["POST /api/task", "PATCH /api/requirements/:id"]);
    db.run("UPDATE nodes SET rest_allowlist = NULL WHERE node_id = ?1", [node.nN.id]);
  });
});

// #2970 判据④ —— 演练发现的口径问题：
// `node_permission_log` 的行数**不等于**「打开 enforce 行为会变」的次数。
// 演练现场：log 模式下 projects_create 已被处理函数拒（user_token_required），
// 但仍记了一行 human_only —— 计入影响面就会高估。
describe("#2970 enforce 影响面分层", () => {
  test("原因码分三类：显式永久拒 / 多数已在下游被拦 / 只有 enforce 才改变行为", async () => {
    const { enforceImpactOf } = await import("./node-permissions.js");
    // 显式原因：与开关无关，永远拒 ⇒ 不是增量
    for (const r of ["mode_readonly", "mode_restricted_not_assigned", "peer_not_allowed", "tool_not_allowed", "rest_not_allowed"]) {
      expect(enforceImpactOf(r as any)).toBe("explicit");
    }
    // human_only：多数写路由自带「只有人能操作」检查，log 下调用方本来就被拒
    expect(enforceImpactOf("human_only")).toBe("likely_already_blocked");
    // 只有这三类 + unbound_token 是 enforce 的真增量
    for (const r of ["beyond_owner_visibility", "agent_not_granted_to_owner", "owner_unknown", "unbound_token"]) {
      expect(enforceImpactOf(r as any)).toBe("changes_behavior");
    }
  });

  test("报表带 enforce_impact 分层汇总", async () => {
    const r = await call(user.boss.token, "GET", `/api/networks/${net}/node-permission-report`);
    expect(r.status).toBe(200);
    expect(r.body.enforce_impact).toBeTruthy();
    // 每个节点也带同名结构
    for (const n of r.body.nodes) expect(n.enforce_impact).toBeTruthy();
  });
});
