// #3309 读数覆盖第五批 —— 四个 error 字面量此前在测试里一次都没出现过：
//
//   ack_start_request : request_not_ackable / child_pid_required
//   get_create_request: not_a_clone / env_blob_unavailable
//
// 这四条有一个共同形状：**请求存在、也确实是发给你的，但当前这一刻的载荷/状态不对**。
// 只断言 ok===false 时，它们与 request_not_found / not_your_request / cross_network_request
// 完全同形 —— 而前三者的处置是「换个 id / 换台机器 / 换网络」，后两者的处置是
// 「按当前状态重发」或「别按 clone 流程要」。所以必须断言确切值。
//
// ⚠ 故意没测 `request_vanished` 与 `finalize_tx_failed`：
//   · 前者在代码里标着 "Should never happen given the earlier row read" ——
//     要让它发生只能伪造一个不可能的中间态（先读到行、再让行消失），
//     那种测试证明不了真实系统里的任何东西；
//   · 后者要求事务里的 SQL 真的失败，而本仓没有可注入的失败点。
//   宁可写明「这两条没有读数」，也不写一条用手段造出来的绿。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_5th_err";
const DAEMON_NODE = "node_5th_daemon";
const DAEMON_ALIAS = "5th-daemon";
const DAEMON_USER = "u_5th_owner";
const DAEMON_TOKEN = "tok_5th_daemon";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const t of ["audit_log", "node_start_requests", "node_create_requests", "nodes", "api_tokens", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [DAEMON_USER]); } catch {}
}

function seedDaemon() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [DAEMON_USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, DAEMON_USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [DAEMON_USER, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'))`,
    [DAEMON_NODE, DAEMON_ALIAS, NET],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOKEN, DAEMON_USER, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOKEN}`],
  );
}

function handlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  const origReg = server.registerTool?.bind(server);
  if (origReg) server.registerTool = (n: string, cfg: any, h: ToolHandler) => { out[n] = h; return origReg(n, cfg, h); };
  registerTools(server, undefined, NET, DAEMON_USER, DAEMON_ALIAS, true, DAEMON_TOKEN);
  return out;
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await handlers()[name](args);
  return JSON.parse(r.content[0].text) as { ok?: boolean; error?: string; [k: string]: unknown };
}

function seedStartRequest(request_id: string, status: string) {
  db.run(
    `INSERT INTO node_start_requests (request_id, network_id, daemon_node_id, child_node_id, child_alias,
                                      created_by_token, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'child-5th', ?5, ?6, ?7)`,
    [request_id, NET, DAEMON_NODE, `n_5th_child_${request_id}`, DAEMON_TOKEN, status, Date.now()],
  );
}

function seedCreateRequest(request_id: string, opts: { status?: string; clone?: boolean } = {}) {
  db.run(
    `INSERT INTO node_create_requests (request_id, daemon_node_id, child_name, network_id, runtime, model,
                                       flags_json, env_keys, status, created_at, created_by_token)
     VALUES (?1, ?2, 'child-5th', ?3, 'opencode-cli', NULL, '{}', '[]', ?4, ?5, ?6)`,
    [request_id, DAEMON_NODE, NET, opts.status ?? "pending", Date.now(), DAEMON_TOKEN],
  );
}

beforeEach(seedDaemon);
afterAll(cleanup);

describe("#3309 ack_start_request / get_create_request 的错误值域", () => {
  test("ack 一个已结束的启动请求 ⇒ request_not_ackable（带当前 status）", async () => {
    seedStartRequest("sr_done", "succeeded");
    const r = await call("ack_start_request", { request_id: "sr_done", status: "started", child_pid: 1234 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("request_not_ackable");
    // 带上当前状态：只看「不可 ack」时，读的人还得回查库里那行现在是什么。
    expect(r.status).toBe("succeeded");
  });

  test("ack started 但不给 child_pid ⇒ child_pid_required", async () => {
    seedStartRequest("sr_nopid", "pending");
    const r = await call("ack_start_request", { request_id: "sr_nopid", status: "started" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("child_pid_required");
    // 与 request_not_ackable 的区别：这个请求**本来可以** ack，只是少了一个字段。
    expect(r.error).not.toBe("request_not_ackable");
  });

  test("按 clone 流程要一个非 clone 请求 ⇒ not_a_clone", async () => {
    seedCreateRequest("cr_plain", { status: "pending" });
    const r = await call("get_create_request", { request_id: "cr_plain", expect_clone: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_a_clone");
    // 反方向（clone 请求却没按 clone 要）是 clone_request —— 两个方向都要能分开。
    expect(r.error).not.toBe("clone_request");
  });

  test("pending 但没有 env blob ⇒ env_blob_unavailable", async () => {
    seedCreateRequest("cr_noblob", { status: "pending" });
    const r = await call("get_create_request", { request_id: "cr_noblob" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("env_blob_unavailable");
    // 不是 request_not_pending：那一格的 status 是对的，缺的是 blob 本身。
    expect(r.error).not.toBe("request_not_pending");
  });

  test("这四条载荷都没有 code 字段（现状，不是契约）", async () => {
    seedStartRequest("sr_done2", "succeeded");
    seedStartRequest("sr_nopid2", "pending");
    seedCreateRequest("cr_plain2", { status: "pending" });
    const replies = [
      await call("ack_start_request", { request_id: "sr_done2", status: "started", child_pid: 1 }),
      await call("ack_start_request", { request_id: "sr_nopid2", status: "started" }),
      await call("get_create_request", { request_id: "cr_plain2", expect_clone: true }),
      await call("get_create_request", { request_id: "cr_plain2" }),
    ];
    for (const r of replies) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});
