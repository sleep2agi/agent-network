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
import { db } from "./db.js";
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
    expect((await call(user.mem.token, "PUT", `/api/nodes/${node.nN.id}/permission-mode`, { mode: "readonly" })).status).toBe(403);
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
