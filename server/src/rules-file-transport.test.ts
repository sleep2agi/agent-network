// app#225 — 节点规则文件远程读写：走真 MCP in-process transport 的端到端。
//
// 验的是 #225 验收里 hub 能验的那几条：
//   1. 客户端只用 node_id 就能发起读/写；工具的 inputSchema 里**没有**任何
//      路径/文件名字段（验收第 5 条「不能借路径参数写任意文件」在 hub 侧的形状）。
//   2. 节点用网络 token + alias 拉到的请求里也没有路径字段；ack 后客户端轮询拿到内容。
//   3. SEC-1：跨网络节点发不了、别的节点 ack 不了、用户 token 拉不了。
//   4. 单飞 + 超时回收。
//
// 跑法：cd server && COMMHUB_DB=/tmp/rules.db bun test src/rules-file-transport.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_rules_file";
const OTHER_NET = "net_rules_file_other";
const USER = "u_rules_file_owner";
const NODE_ID = "node_rules_file_claude";
const NODE_ALIAS = "rules-file-claude";
const OTHER_NODE_ID = "node_rules_file_other";
const OTHER_NODE_ALIAS = "rules-file-other";
const NODE_TOKEN = "tok_rules_file_node";
const OTHER_NODE_TOKEN = "tok_rules_file_other_node";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    try { db.run("DELETE FROM node_rules_requests WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM network_members WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [net]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seedWorld() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [USER, USER],
  );
  for (const net of [NET, OTHER_NET]) {
    db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [net, net, USER]);
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, net]);
  }
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [NODE_ID, NODE_ALIAS, NODE_ALIAS, NET],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [OTHER_NODE_ID, OTHER_NODE_ALIAS, OTHER_NODE_ALIAS, OTHER_NET],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [NODE_TOKEN, USER, NET, `node:${NODE_ALIAS}`, "hash_rules_file_node"],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [OTHER_NODE_TOKEN, USER, OTHER_NET, `node:${OTHER_NODE_ALIAS}`, "hash_rules_file_other"],
  );
}

type Identity = { net: string; alias: string; isNetworkToken: boolean; tokenId: string };
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_rules_file_user" };
const asNode: Identity = { net: NET, alias: NODE_ALIAS, isNetworkToken: true, tokenId: NODE_TOKEN };
const asOtherNode: Identity = { net: OTHER_NET, alias: OTHER_NODE_ALIAS, isNetworkToken: true, tokenId: OTHER_NODE_TOKEN };

async function connect(id: Identity) {
  const server = new McpServer({ name: "rules-file-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "rules-file-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const first = r.content?.[0];
    if (!first || first.type !== "text") throw new Error(`no text result from ${name}`);
    return JSON.parse(first.text);
  };
  const close = async () => { await client.close(); await server.close(); };
  return { client, server, call, close };
}

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

describe("app#225 rules file — schema has no path", () => {
  test("read/write tool inputs are node id + content only; no path / file_name / dir field anywhere", async () => {
    // 🔴 不走 client.listTools():main 上 report_status / send_desktop_message /
    // update_node_config / create_node 四个存量工具的 zod 形状让 SDK 的
    // toJSONSchema 抛 `schema._zod`,listTools 整个失败(与本 PR 无关,实验见
    // PR 正文)。这里直接看 McpServer 登记表里的 zod shape —— 它就是 hub 校验
    // 入参用的那份,比 JSON schema 更接近真相。
    const u = await connect(asUser);
    try {
      const reg: Record<string, any> = (u.server as any)._registeredTools;
      const shapeKeys = (name: string): string[] => {
        expect(reg[name], name).toBeDefined();
        const schema = reg[name].inputSchema;
        const shape = schema?.shape ?? schema?._def?.shape?.() ?? schema ?? {};
        return Object.keys(shape).sort();
      };
      expect(shapeKeys("read_node_rules_file")).toEqual(["child_node_id", "network_id", "node_id"]);
      expect(shapeKeys("write_node_rules_file")).toEqual(["child_node_id", "content", "network_id", "node_id"]);
      expect(shapeKeys("get_rules_file_request")).toEqual([]);
      // ack 的 file_name 是节点**回报**它用了哪个文件,不是客户端**指定**用哪个文件。
      expect(shapeKeys("ack_rules_file_request")).toEqual(["content", "error", "exists", "file_name", "request_id", "status"]);
      expect(shapeKeys("get_rules_file_result")).toEqual(["network_id", "request_id"]);
      for (const name of ["read_node_rules_file", "write_node_rules_file", "get_rules_file_request", "get_rules_file_result"]) {
        for (const k of shapeKeys(name)) expect(k, `${name}.${k}`).not.toMatch(/path|dir|file|cwd/i);
      }
    } finally { await u.close(); }
  }, 20_000);
});

describe("app#225 rules file — read round trip", () => {
  test("user enqueues read → node pulls (no path in request) → acks content → user polls done", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: NODE_ID });
      expect(enq).toMatchObject({ ok: true, op: "read" });
      expect(enq.request_id).toMatch(/^rf_/);

      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "pending", op: "read" });

      const pulled = await n.call("get_rules_file_request", {});
      expect(pulled.ok).toBe(true);
      expect(Object.keys(pulled.request).sort()).toEqual(["op", "request_id"]);
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "read" });
      // 第二次拉:已经 in_progress,不再重复下发
      expect(await n.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });

      expect(await n.call("ack_rules_file_request", {
        request_id: enq.request_id, status: "done", file_name: "CLAUDE.md", exists: true, content: "# 规则\n",
      })).toMatchObject({ ok: true, status: "done" });

      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ ok: true, status: "done", op: "read", file_name: "CLAUDE.md", exists: true, content: "# 规则\n", error: null });
    } finally { await u.close(); await n.close(); }
  }, 20_000);

  test("write: content travels to the node verbatim; result carries no content back", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const body = "# new rules\n\n- 不碰生产 DB\n";
      const enq = await u.call("write_node_rules_file", { node_id: NODE_ID, content: body });
      expect(enq).toMatchObject({ ok: true, op: "write" });
      const pulled = await n.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "write", content: body });
      await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "CLAUDE.md", exists: true });
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ ok: true, status: "done", op: "write", file_name: "CLAUDE.md" });
      expect(res.content).toBeUndefined();
    } finally { await u.close(); await n.close(); }
  }, 20_000);

  test("node failure is surfaced with its reason", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const enq = await u.call("write_node_rules_file", { node_id: NODE_ID, content: "x" });
      await n.call("get_rules_file_request", {});
      await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "failed", file_name: "CLAUDE.md", error: "EACCES: permission denied" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "failed", error: "EACCES: permission denied" });
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});

describe("app#225 rules file — SEC-1 and lifecycle", () => {
  test("cross-network node cannot be targeted", async () => {
    const u = await connect(asUser);
    try {
      expect(await u.call("read_node_rules_file", { node_id: OTHER_NODE_ID })).toMatchObject({ ok: false, error: "cross_network_node" });
      expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM node_rules_requests WHERE node_id = ?1", OTHER_NODE_ID)?.c).toBe(0);
    } finally { await u.close(); }
  }, 20_000);

  test("a node in another network can neither pull nor ack this node's request", async () => {
    const u = await connect(asUser);
    const o = await connect(asOtherNode);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: NODE_ID });
      expect(await o.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
      expect(await o.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "stolen" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(db.get<{ status: string }>("SELECT status FROM node_rules_requests WHERE request_id = ?1", enq.request_id)?.status).toBe("pending");
    } finally { await u.close(); await o.close(); }
  }, 20_000);

  test("user token (not a network token) cannot use the node-side pull/ack", async () => {
    const u = await connect(asUser);
    try {
      expect(await u.call("get_rules_file_request", {})).toMatchObject({ ok: false, error: "network_token_required" });
      expect(await u.call("ack_rules_file_request", { request_id: "rf_nope", status: "done" })).toMatchObject({ ok: false, error: "network_token_required" });
    } finally { await u.close(); }
  }, 20_000);

  test("single flight: a second request while one is pending is refused; a stale one is superseded", async () => {
    const u = await connect(asUser);
    try {
      const first = await u.call("read_node_rules_file", { node_id: NODE_ID });
      expect(await u.call("read_node_rules_file", { node_id: NODE_ID })).toMatchObject({ ok: false, error: "request_in_flight", existing_request_id: first.request_id });
      db.run("UPDATE node_rules_requests SET created_at = ?1 WHERE request_id = ?2", [Date.now() - 120_000, first.request_id]);
      const second = await u.call("read_node_rules_file", { node_id: NODE_ID });
      expect(second.ok).toBe(true);
      expect(db.get<{ status: string }>("SELECT status FROM node_rules_requests WHERE request_id = ?1", first.request_id)?.status).toBe("timeout");
    } finally { await u.close(); }
  }, 20_000);

  test("polling a request the node never answered flips it to timeout with a readable reason", async () => {
    const u = await connect(asUser);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: NODE_ID });
      db.run("UPDATE node_rules_requests SET created_at = ?1 WHERE request_id = ?2", [Date.now() - 120_000, enq.request_id]);
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ ok: true, status: "timeout" });
      expect(res.error).toMatch(/did not answer/);
    } finally { await u.close(); }
  }, 20_000);

  test("oversized content is refused before anything is queued", async () => {
    const u = await connect(asUser);
    try {
      const r: any = await u.client.callTool({ name: "write_node_rules_file", arguments: { node_id: NODE_ID, content: "x".repeat(256 * 1024 + 1) } });
      expect(r.isError).toBe(true);
      expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM node_rules_requests WHERE node_id = ?1", NODE_ID)?.c).toBe(0);
    } finally { await u.close(); }
  }, 20_000);
});
