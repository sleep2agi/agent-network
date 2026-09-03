import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// #1548 —— 一个活着、能收发任务的节点可以在名册里永远显示 `blocked`:
// 只有 report_completion 会把 sessions.status 拉回 idle,而现在大多数 agent 用
// send_reply(终态)结束任务、用 send_task 派活 —— 这两条路径此前都不碰 sessions.status。
// 「它刚回了我一条终态消息 / 刚派了一条任务」本身就是最强的活性证据。
// 只出 `blocked`;`working` 可能真在忙别的任务,不碰(保守)。
const NET_ID = "net_1548_blocked";
const USER_ID = "u_1548";
const NODE_ID = "node_1548_agent";
const AGENT_ALIAS = "agent-1548";
const DISPATCHER_NODE_ID = "node_1548_dispatcher";
const DISPATCHER_ALIAS = "dispatcher-1548";
const AGENT_TOK_ID = "tok_1548";

type ToolHandler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

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
}
beforeEach(cleanup);
afterAll(cleanup);

function seed(agentStatus: string) {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER_ID, USER_ID]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET_ID, NET_ID, USER_ID]);
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, 'owner', datetime('now'))`,
    [USER_ID, NET_ID],
  );
  for (const [nodeId, alias] of [[DISPATCHER_NODE_ID, DISPATCHER_ALIAS], [NODE_ID, AGENT_ALIAS]] as const) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'), 'active')`,
      [nodeId, alias, alias, NET_ID, `host-${alias}`],
    );
  }
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`res_${DISPATCHER_ALIAS}`, DISPATCHER_ALIAS, DISPATCHER_NODE_ID, NET_ID],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`,
    [`res_${AGENT_ALIAS}`, AGENT_ALIAS, agentStatus, NODE_ID, NET_ID],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [AGENT_TOK_ID, USER_ID, NET_ID, `node:${AGENT_ALIAS}`, `hash_${AGENT_TOK_ID}`],
  );
}
function makeTask(): string {
  const id = "t_" + Math.random().toString(36).slice(2, 14);
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, ?2, ?3, ?4, 'normal', 'delivered', 'test', 'reply', datetime('now'), ?5)`,
    [id, DISPATCHER_ALIAS, AGENT_ALIAS, NODE_ID, NET_ID],
  );
  return id;
}
function buildHandlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => { tools[name] = handler; return origTool(name, _desc, _schema, handler); };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => { tools[name] = handler; return origRegisterTool(name, _cfg, handler); };
  }
  registerTools(server, undefined, NET_ID, USER_ID, AGENT_ALIAS, true, AGENT_TOK_ID);
  return tools;
}
async function call(handler: ToolHandler, args: any): Promise<any> {
  const r = await handler(args);
  return JSON.parse(r.content[0]!.text);
}
function agentStatus(): string {
  return (db.get("SELECT status FROM sessions WHERE alias = ?1 AND network_id = ?2", [AGENT_ALIAS, NET_ID]) as { status: string }).status;
}

describe("#1548 blocked has an exit: a terminal reply or an outbound task proves the agent is alive", () => {
  test("terminal send_reply from a blocked agent puts it back to idle", async () => {
    seed("blocked");
    const tools = buildHandlers();
    const taskId = makeTask();
    const r = await call(tools.send_reply!, { text: "done", in_reply_to: taskId, status: "replied", from_session: AGENT_ALIAS, network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(agentStatus()).toBe("idle");
  });
  test("send_task from a blocked agent puts it back to idle", async () => {
    seed("blocked");
    const tools = buildHandlers();
    const r = await call(tools.send_task!, { alias: DISPATCHER_ALIAS, task: "ping", priority: "normal", from_session: AGENT_ALIAS, network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(agentStatus()).toBe("idle");
  });
  test("a working agent is left alone (it may be busy with another task)", async () => {
    seed("working");
    const tools = buildHandlers();
    const taskId = makeTask();
    await call(tools.send_reply!, { text: "done", in_reply_to: taskId, status: "replied", from_session: AGENT_ALIAS, network_id: NET_ID });
    expect(agentStatus()).toBe("working");
  });
});
