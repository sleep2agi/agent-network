// f015d9d6 根因隔离：admin(dashboard/人类) 发给「无 node_id 的 MCP 会话」的任务，
// 其回执被 reply_target_mismatch 拒绝。
//
// 上报时给出的假设是「校验依赖投递绑定 ⇒ 任务还没真正 deliver 进会话时回执会被拒」。
// 本文件把两个变量分开量，一次只动一个：
//   变量 1 = 任务是否已投递（status created vs delivered，有无 SSE 订阅者）
//   变量 2 = 调用方是否显式传 alias
// 如果假设成立，变量 1 应当决定结果；如果 alias 推导才是决定因素，变量 2 才会。
import { beforeEach, afterAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { __resetSSEClientsForTest, createSSEStream } from "./push.js";

const NET = "net_admin_reply_f015";
const USER = "user_admin_reply_f015";
const ADMIN = "admin-f015";           // 人类/dashboard 发起方，无 node
const AGENT = "agent-mcp-f015";       // MCP 会话：sessions 行 node_id = NULL
const AGENT_NODE = "node-agent-f015"; // token 绑定的 node（会话本身仍无 node_id）

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  __resetSSEClientsForTest();
  for (const t of ["tasks", "inbox", "task_events", "sessions", "api_tokens", "nodes", "rename_txn"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'admin', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  db.run(
    "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, config_snapshot, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', '{}', datetime('now'), datetime('now'), 'active')",
    [AGENT_NODE, AGENT, NET],
  );
  // 🔴 关键夹具属性：会话行 node_id 为 NULL —— 这正是 MCP 挂载的 claude-code 会话的形状
  db.run(
    "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', NULL, ?3, datetime('now'), datetime('now'))",
    [`cc-n_${AGENT}`, AGENT, NET],
  );
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id) VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6)",
    [`token-${AGENT}`, `hash-${AGENT}`, USER, NET, `node:${AGENT}`, AGENT_NODE],
  );
}

function toolsFor(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "admin-reply-f015", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler; return original(name, description, schema, handler);
  };
  registerTools(server, undefined, NET, USER, alias, true, `token-${alias}`);
  return tools;
}

function parse(res: { content: Array<{ text: string }> }) { return JSON.parse(res.content[0].text); }

/** 造一条 admin(人类) → AGENT 的任务；delivered 控制「是否已投递」这一个变量。 */
function seedAdminTask(taskId: string, delivered: boolean) {
  db.run(
    `INSERT INTO tasks (task_id, from_name, from_node_id, to_name, to_node_id, content, status, priority, network_id, created_at)
     VALUES (?1, ?2, NULL, ?3, NULL, 'ping', ?4, 'normal', ?5, datetime('now'))`,
    [taskId, ADMIN, AGENT, delivered ? "delivered" : "created", NET],
  );
}

describe("f015d9d6 — admin→无 node_id 的 MCP 会话，回执绑定", () => {
  beforeEach(() => { cleanup(); seed(); });
  afterAll(() => cleanup());

  test("变量1：任务【未投递】+ 省略 alias（走 #1085 推导）⇒ 回执应当成功", async () => {
    seedAdminTask("t-undelivered", false);
    const r = parse(await toolsFor(AGENT).send_reply({ in_reply_to: "t-undelivered", text: "done", status: "completed" }));
    expect(r).toEqual(expect.objectContaining({ ok: true }));
  });

  test("变量1 对照：任务【已投递且有 SSE 订阅者】+ 省略 alias ⇒ 同样成功", async () => {
    seedAdminTask("t-delivered", true);
    createSSEStream(AGENT, NET);
    const r = parse(await toolsFor(AGENT).send_reply({ in_reply_to: "t-delivered", text: "done", status: "completed" }));
    expect(r).toEqual(expect.objectContaining({ ok: true }));
  });

  test("变量2：显式传一个不等于任务发起方的 alias ⇒ reply_target_mismatch", async () => {
    seedAdminTask("t-wrong-alias", true);
    const r = parse(await toolsFor(AGENT).send_reply({ alias: "someone-else", in_reply_to: "t-wrong-alias", text: "done", status: "completed" }));
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "reply_target_mismatch" }));
  });
});
