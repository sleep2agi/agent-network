import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { pendingSecretRequests, _resetForTest } from "./secret-request-ui.js";

// admin 2026-11-24 —— 「要密钥弹卡片」：agent 调 request_secret ⇒ 这次对话里出现一张加密输入卡，
// 值永远不经过 agent 和聊天。这里钉住 Hub 侧契约：
//   ① 卡片随回执进 inbox.meta_json.secret_request，并落到 tasks.meta_json.reply_secret_request
//      （App/Dashboard 读 tasks 行，只落 inbox 的话卡片永远画不出来）；
//   ② 同时登记 #4827 的「待填」，节点设置页也能看到；
//   ③ 回执正文是人话兜底（旧客户端看不到卡片时知道去哪填）；
//   ④ 只有节点令牌能调；key 必须是合法环境变量名。
const NET_ID = "net_req_secret";
const USER_ID = "u_req_secret";
const NODE_ID = "node_req_secret";
const ALIAS = "agent-req-secret";
const TOK_ID = "tok_req_secret";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const [sql, params] of [
    ["DELETE FROM tasks WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM inbox WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM task_events WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM sessions WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM nodes WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM api_tokens WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM network_members WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM networks WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM users WHERE user_id = ?1", [USER_ID]],
  ] as const) {
    try { db.run(sql, params as any); } catch {}
  }
  _resetForTest();
}
beforeEach(cleanup);
afterAll(cleanup);

function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER_ID, USER_ID]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET_ID, NET_ID, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER_ID, NET_ID]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, 'host', datetime('now'), datetime('now'), 'active')`,
    [NODE_ID, ALIAS, NET_ID],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'working', ?3, ?4, datetime('now'), datetime('now'))`,
    [`res_${ALIAS}`, ALIAS, NODE_ID, NET_ID],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [TOK_ID, USER_ID, NET_ID, `node:${ALIAS}`, `hash_${TOK_ID}`],
  );
}
function userTask(): string {
  const id = "t_" + Math.random().toString(36).slice(2, 14);
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, ?2, ?3, ?4, 'normal', 'delivered', '我有一个新的 GITHUB 秘钥给我存一下', 'reply', datetime('now'), ?5)`,
    [id, USER_ID, ALIAS, NODE_ID, NET_ID],
  );
  return id;
}
function handlers(asNode = true): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, d: string, s: any, h: ToolHandler) => { tools[name] = h; return orig(name, d, s, h); };
  if (asNode) registerTools(server, undefined, NET_ID, USER_ID, ALIAS, true, TOK_ID);
  else registerTools(server, undefined, NET_ID, USER_ID, USER_ID, false, null);
  return tools;
}
const call = async (h: ToolHandler, args: any) => JSON.parse((await h(args)).content[0]!.text);

describe("request_secret —— 聊天里的加密输入卡", () => {
  test("卡片随回执落到 inbox 与 tasks 行；登记待填；正文是人话兜底", async () => {
    seed();
    const taskId = userTask();
    const r = await call(handlers().request_secret!, { key: "GITHUB_TOKEN", label: "GitHub 密钥", hint: "粘贴新的 GitHub token", in_reply_to: taskId, network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.secret_request).toEqual({ key: "GITHUB_TOKEN", pending: true });

    const card = { node_id: NODE_ID, key: "GITHUB_TOKEN", label: "GitHub 密钥", hint: "粘贴新的 GitHub token" };
    const inbox = db.get<{ content: string; meta_json: string }>("SELECT content, meta_json FROM inbox WHERE in_reply_to = ?1 AND type = 'reply'", taskId)!;
    expect(JSON.parse(inbox.meta_json).secret_request).toEqual(card);
    expect(inbox.content).toContain("GitHub 密钥");
    expect(inbox.content).toContain("GITHUB_TOKEN");

    const task = db.get<{ status: string; meta_json: string }>("SELECT status, meta_json FROM tasks WHERE task_id = ?1", taskId)!;
    expect(task.status).toBe("replied");
    expect(JSON.parse(task.meta_json).reply_secret_request).toEqual(card);
    expect(JSON.parse(task.meta_json).reply_attachments).toBeUndefined();

    expect(pendingSecretRequests(NODE_ID)?.map(p => p.key)).toEqual(["GITHUB_TOKEN"]);
  });

  test("非法环境变量名 ⇒ invalid_secret_key，不登记、不回执", async () => {
    seed();
    const taskId = userTask();
    const r = await call(handlers().request_secret!, { key: "github token!", in_reply_to: taskId, network_id: NET_ID });
    expect(r).toMatchObject({ ok: false, error: "invalid_secret_key" });
    expect(pendingSecretRequests(NODE_ID)).toBeUndefined();
    expect(db.get("SELECT 1 FROM inbox WHERE in_reply_to = ?1", taskId)).toBeNull();
  });

  test("用户令牌（不是节点）⇒ node_token_required", async () => {
    seed();
    const r = await call(handlers(false).request_secret!, { key: "GITHUB_TOKEN", network_id: NET_ID });
    expect(r).toMatchObject({ ok: false, error: "node_token_required" });
    expect(pendingSecretRequests(NODE_ID)).toBeUndefined();
  });
});
