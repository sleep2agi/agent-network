// #460(#448 子项)—— 降级节点拒收新任务。
//
// 钉住:
//   1. 新鲜健康报告说某层坏了(app_server.ok=false / tui.ok=false / model_auth revoked|expired)
//      → REST /api/task 409、MCP send_task / retry_task / reassign_task 返回 node_degraded,带层、原因、修法;
//      定时任务的这一次 run 记 failed + error_code=node_degraded,不建任务行。
//   2. 不知道 = 放行:没有报告(老 agent-node)、报告过期(> TTL)、各层都 ok、某层没报 —— 与改动前逐字相同的成功路径。
//   3. 逃生口 force=true 只对用户令牌生效;节点令牌带 force 照样被拒(不让 agent 绕过对另一个 agent 的健康判断)。
//   4. 老客户端请求形状(不带 force)在健康 / 未知节点上完全照旧 —— 兼容回放。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/node-health-dispatch-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { clearNodeHealthStore, NODE_HEALTH_TTL_MS, recordNodeHealth } from "./node-health-store.js";
import { degradedLayers } from "./node-health-guard.js";
import { runDueScheduledTasks } from "./scheduled-tasks.js";

const dir = mkdtempSync(join(tmpdir(), "anet-health-dispatch-"));
const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-health-dispatch requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

let server: any;
let base = "";
let ownerToken = "", ownerId = "", networkId = "";
let peerNodeToken = "", peerNodeTokenId = "";
const stamp = Date.now();
const TARGET = `hd-target-${stamp}`;
const TARGET_NODE = `n_hd_target_${stamp}`;
const PEER = `hd-peer-${stamp}`;
const PEER_NODE = `n_hd_peer_${stamp}`;
let seq = 0;
const text = (what: string) => `${what} #${++seq}`; // distinct content: the 5-minute dedup must not interfere

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() as any };
}
const postTask = (token: string, extra: Record<string, unknown> = {}) =>
  api(token, "/api/task", { method: "POST", body: JSON.stringify({ alias: TARGET, task: text("rest"), network_id: networkId, ...extra }) });

async function mcpAs(identity: { net: string | null; user: string; alias: string; isNetworkToken: boolean; tokenId: string }) {
  const s = new McpServer({ name: "health-dispatch", version: "1" });
  registerTools(s, undefined, identity.net, identity.user, identity.alias, identity.isNetworkToken, identity.tokenId);
  const client = new Client({ name: "health-dispatch-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const raw = r.content?.[0]?.text ?? "null";
    try { return JSON.parse(raw); } catch { return { raw }; }
  };
  return { call, close: async () => { await client.close(); await s.close(); } };
}

const DOWN_APP = { bridge: "ok" as const, app_server: { ok: false, rtt_ms: null, last_error: "connect ECONNREFUSED 127.0.0.1:4500" }, model_auth: "ok" as const };
const HEALTHY = { bridge: "ok" as const, app_server: { ok: true, rtt_ms: 3, last_error: null }, tui: { ok: true, reason: "running" }, model_auth: "ok" as const };
const setHealth = (h: any, at?: number) => recordNodeHealth(networkId, TARGET, h, at);
const taskCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE to_name = ?1 AND network_id = ?2", TARGET, networkId)!.n;

beforeAll(async () => {
  process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
  process.env.HOST = "127.0.0.1";
  const owner = register(`hd_owner_${stamp}`, "HealthDispatchOwner123!", undefined, "seed");
  ownerToken = owner.token!; ownerId = owner.user!.user_id; networkId = owner.network_id!;
  for (const [nodeId, alias] of [[TARGET_NODE, TARGET], [PEER_NODE, PEER]]) {
    db.run(`INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1, ?2, ?2, 'codex-app-server', ?3, ?4)`, [nodeId, alias, networkId, ownerId]);
    db.run(`INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)`, [`r_${nodeId}`, alias, nodeId, networkId]);
  }
  const minted = createNetworkTokenForNode(ownerId, networkId, PEER, PEER_NODE);
  peerNodeToken = minted.token!; peerNodeTokenId = minted.token_id!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);
afterAll(() => { server?.stop?.(true); clearNodeHealthStore(); });
beforeEach(() => clearNodeHealthStore());

describe("#460 which layers count as degraded", () => {
  test("each failing layer is named; ok / missing layers are not", () => {
    expect(degradedLayers(null)).toEqual([]);
    expect(degradedLayers(HEALTHY)).toEqual([]);
    expect(degradedLayers({ bridge: "ok", model_auth: "unknown" })).toEqual([]);
    expect(degradedLayers(DOWN_APP).map(l => [l.layer, l.label])).toEqual([["app_server", "App Server 断开"]]);
    expect(degradedLayers({ tui: { ok: false, reason: "sleep-placeholder" } }).map(l => [l.layer, l.reason, l.label])).toEqual([["tui", "sleep-placeholder", "TUI 被占位(sleep)"]]);
    expect(degradedLayers({ model_auth: "revoked" }).map(l => l.label)).toEqual(["需要重新登录"]);
    expect(degradedLayers({ model_auth: "expired" }).map(l => l.label)).toEqual(["登录已过期"]);
    // 修法只指向本节点重新登录,不教人拷别人的凭据
    expect(degradedLayers({ model_auth: "revoked" })[0].hint).toContain("不要拷别的节点的 auth.json");
  });
});

describe("#460 REST /api/task", () => {
  test("unknown health (old agent-node) → dispatched exactly as before", async () => {
    const before = taskCount();
    const r = await postTask(ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(taskCount()).toBe(before + 1);
  });

  test("healthy report → dispatched", async () => {
    setHealth(HEALTHY);
    expect((await postTask(ownerToken)).status).toBe(200);
  });

  test("App Server down → 409 node_degraded with layer, reason and hint; no task row", async () => {
    setHealth(DOWN_APP);
    const before = taskCount();
    const r = await postTask(ownerToken);
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("node_degraded");
    expect(r.body.alias).toBe(TARGET);
    expect(r.body.layers.map((l: any) => l.layer)).toEqual(["app_server"]);
    expect(r.body.layers[0].reason).toContain("ECONNREFUSED");
    expect(r.body.message).toContain("App Server 断开");
    expect(r.body.hint).toContain("force=true");
    expect(r.body.force_allowed).toBe(true);
    expect(typeof r.body.health_observed_ms_ago).toBe("number");
    expect(taskCount()).toBe(before);
  });

  test("TUI gone and login revoked are refused too, all layers listed", async () => {
    setHealth({ bridge: "ok", app_server: { ok: true, rtt_ms: 2, last_error: null }, tui: { ok: false, reason: "session-missing" }, model_auth: "revoked" });
    const r = await postTask(ownerToken);
    expect(r.status).toBe(409);
    expect(r.body.layers.map((l: any) => l.layer)).toEqual(["tui", "model_auth"]);
  });

  test("expired login alone is refused", async () => {
    setHealth({ bridge: "ok", model_auth: "expired" });
    expect((await postTask(ownerToken)).body.error).toBe("node_degraded");
  });

  test("stale report (older than the TTL) = unknown → dispatched", async () => {
    setHealth(DOWN_APP, Date.now() - NODE_HEALTH_TTL_MS - 1_000);
    expect((await postTask(ownerToken)).status).toBe(200);
  });

  test("owner escape hatch: force=true with a user token dispatches", async () => {
    setHealth(DOWN_APP);
    const before = taskCount();
    const r = await postTask(ownerToken, { force: true });
    expect(r.status).toBe(200);
    expect(taskCount()).toBe(before + 1);
  });

  test("a node token cannot force past another node's health", async () => {
    setHealth(DOWN_APP);
    const r = await api(peerNodeToken, "/api/task", { method: "POST", body: JSON.stringify({ alias: TARGET, task: text("node-force"), force: true }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("node_degraded");
    expect(r.body.force_allowed).toBe(false);
    expect(r.body.hint).not.toContain("force=true");
  });

  test("old-client request shapes are untouched on a healthy node (compat replay)", async () => {
    setHealth(HEALTHY);
    // the app's send (meta + client_request_id), a plain anet send, and a parent-linked dispatch
    const shapes = [
      { alias: TARGET, task: text("app"), network_id: networkId, priority: "normal", meta: { client_request_id: `cr_${stamp}_${seq}` } },
      { alias: TARGET, task: text("anet"), network_id: networkId },
      { alias: TARGET, task: text("ttl"), network_id: networkId, priority: "high", ttl_seconds: 600 },
    ];
    for (const shape of shapes) {
      const r = await api(ownerToken, "/api/task", { method: "POST", body: JSON.stringify(shape) });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    }
  });
});

describe("#460 MCP send_task / retry_task / reassign_task", () => {
  const asOwner = () => ({ net: null, user: ownerId, alias: `hd_owner_${stamp}`, isNetworkToken: false, tokenId: "tok_hd_owner_login" });
  const asPeerNode = () => ({ net: networkId, user: ownerId, alias: PEER, isNetworkToken: true, tokenId: peerNodeTokenId });

  test("send_task from an agent to a degraded node → node_degraded (no queueing); force ignored for node tokens", async () => {
    setHealth(DOWN_APP);
    const peer = await mcpAs(asPeerNode());
    try {
      const before = taskCount();
      const r = await peer.call("send_task", { alias: TARGET, task: text("mcp"), force: true });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("node_degraded");
      expect(r.force_allowed).toBe(false);
      expect(taskCount()).toBe(before);
    } finally { await peer.close(); }
  });

  test("send_task: unknown health → ok; owner force → ok", async () => {
    const owner = await mcpAs(asOwner());
    try {
      expect((await owner.call("send_task", { alias: TARGET, task: text("mcp-unknown"), network_id: networkId })).ok).toBe(true);
      setHealth({ bridge: "ok", model_auth: "revoked" });
      expect((await owner.call("send_task", { alias: TARGET, task: text("mcp-refused"), network_id: networkId })).error).toBe("node_degraded");
      expect((await owner.call("send_task", { alias: TARGET, task: text("mcp-forced"), network_id: networkId, force: true })).ok).toBe(true);
    } finally { await owner.close(); }
  });

  test("retry_task and reassign_task onto a degraded node are refused", async () => {
    const owner = await mcpAs(asOwner());
    try {
      const sent = await owner.call("send_task", { alias: PEER, task: text("to-peer"), network_id: networkId });
      expect(sent.ok).toBe(true);
      setHealth(DOWN_APP);
      const re = await owner.call("reassign_task", { task_id: sent.task_id ?? sent.message_id, new_alias: TARGET, network_id: networkId });
      expect(re.error).toBe("node_degraded");
      const failed = await owner.call("send_task", { alias: TARGET, task: text("to-fail"), network_id: networkId, force: true });
      const failedId = failed.task_id ?? failed.message_id;
      db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [failedId]);
      const retry = await owner.call("retry_task", { task_id: failedId, network_id: networkId });
      expect(retry.error).toBe("node_degraded");
      clearNodeHealthStore();
      expect((await owner.call("retry_task", { task_id: failedId, network_id: networkId })).ok).toBe(true);
    } finally { await owner.close(); }
  });
});

describe("#460 scheduled tasks", () => {
  test("a due run on a degraded node fails with node_degraded and creates no task", async () => {
    const created = await api(ownerToken, "/api/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, name: `hd-schedule-${stamp}`, target_node_id: TARGET_NODE, task: text("scheduled"), timezone: "UTC", schedule: { type: "interval", every_seconds: 60 } }),
    });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.schedule_id;
    setHealth({ bridge: "ok", tui: { ok: false, reason: "pane-dead" }, model_auth: "ok" });
    const before = taskCount();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [new Date(Date.now() - 60_000).toISOString(), scheduleId]);
    runDueScheduledTasks();
    const run = db.get<{ status: string; error_code: string | null; error_message: string | null; task_id: string | null }>(
      "SELECT status, error_code, error_message, task_id FROM scheduled_task_runs WHERE schedule_id = ?1 ORDER BY created_at DESC LIMIT 1", scheduleId);
    expect(run?.status).toBe("failed");
    expect(run?.error_code).toBe("node_degraded");
    expect(run?.error_message).toContain("TUI 已退出");
    expect(run?.task_id ?? null).toBeNull();
    expect(taskCount()).toBe(before);
  });
});
