import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// #698 supersedes the old #498 warning-only posture. send_reply is now the
// atomic peer primitive: it closes the original task and writes one
// requires_response=none reply inbox row. No follow-up send_task warning is
// emitted because creating a second requires-response task is the bug.

const NET_ID = "net_498_warn";
const USER_ID = "u_498_warn";
const NODE_ID = "node_498_warn";
const AGENT_ALIAS = "peer-agent-498";
const DISPATCHER_NODE_ID = "node_498_dispatcher";
const DISPATCHER_ALIAS = "dispatcher";
const AGENT_TOK_ID = "tok_498_warn";

interface ToolHandler {
  (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
interface Reply {
  ok?: boolean;
  message_id?: string;
  session_status?: string;
  warning?: string;
  error?: string;
  [k: string]: unknown;
}

function cleanup() {
  try { db.run("DELETE FROM tasks WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM inbox WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM task_events WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET_ID]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}

beforeEach(cleanup);
afterAll(cleanup);

function seed() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [USER_ID, USER_ID],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'), 'active')`,
    [DISPATCHER_NODE_ID, DISPATCHER_ALIAS, DISPATCHER_ALIAS, NET_ID, `host-${DISPATCHER_ALIAS}`],
  );
  db.run(
    `INSERT INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [NET_ID, NET_ID, USER_ID],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`res_${DISPATCHER_ALIAS}`, DISPATCHER_ALIAS, DISPATCHER_NODE_ID, NET_ID],
  );
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, 'owner', datetime('now'))`,
    [USER_ID, NET_ID],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'), 'active')`,
    [NODE_ID, AGENT_ALIAS, AGENT_ALIAS, NET_ID, `host-${AGENT_ALIAS}`],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`res_${AGENT_ALIAS}`, AGENT_ALIAS, NODE_ID, NET_ID],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [AGENT_TOK_ID, USER_ID, NET_ID, `node:${AGENT_ALIAS}`, `hash_${AGENT_TOK_ID}`],
  );
}

function makeTask(from: string): string {
  const id = "t_" + Math.random().toString(36).slice(2, 14);
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, ?2, ?3, ?4, 'normal', 'delivered', 'test', 'reply', datetime('now'), ?5)`,
    [id, from, AGENT_ALIAS, NODE_ID, NET_ID],
  );
  return id;
}

function buildHandlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, _schema, handler);
  };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => {
      tools[name] = handler;
      return origRegisterTool(name, _cfg, handler);
    };
  }
  // Bind as a network token whose caller alias is the sender.
  registerTools(
    server,
    undefined,
    /* enforceNetworkId */ NET_ID,
    /* enforceUserId */ USER_ID,
    /* callerAlias */ AGENT_ALIAS,
    /* callerTokenIsNetwork */ true,
    /* callerTokenId */ AGENT_TOK_ID,
  );
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

describe("send_reply atomic peer reply (#698 supersedes #498 warning)", () => {
  test("agent reply closes the original and enqueues one no-response peer result", async () => {
    seed();
    const tools = buildHandlers();
    const sendReply = tools["send_reply"];
    expect(sendReply).toBeDefined();

    const taskId = makeTask(DISPATCHER_ALIAS);
    const reply = await call(sendReply, {
      alias: DISPATCHER_ALIAS,
      text: "peer reply (atomic)",
      in_reply_to: taskId,
      status: "replied",
      from_session: AGENT_ALIAS,
    });

    expect(reply.ok).toBe(true);
    expect(reply.warning).toBeUndefined();
    expect(db.get<{ status: string; result: string }>(
      "SELECT status, result FROM tasks WHERE task_id = ?1", taskId,
    )).toEqual(expect.objectContaining({ status: "replied", result: "peer reply (atomic)" }));
    expect(db.all<{ type: string; requires_response: string; session_name: string }>(
      "SELECT type, requires_response, session_name FROM inbox WHERE in_reply_to = ?1", taskId,
    )).toEqual([{ type: "reply", requires_response: "none", session_name: DISPATCHER_ALIAS }]);
    expect(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?1", taskId,
    )?.n).toBe(0);
  });

  test("target alias is `hub` (Dashboard path) → NO warning field", async () => {
    seed();
    const tools = buildHandlers();
    const sendReply = tools["send_reply"];

    const taskId = makeTask("hub");
    const reply = await call(sendReply, {
      alias: "hub",
      text: "dashboard reply",
      in_reply_to: taskId,
      status: "replied",
      from_session: AGENT_ALIAS,
    });

    expect(reply.ok).toBe(true);
    // Silence-affirms the Dashboard path. Every reply carrying a
    // warning would train the LLM to ignore it, so absence here is
    // load-bearing.
    expect(reply.warning).toBeUndefined();
  });

  test("target alias is `api` (Dashboard path) → NO warning field", async () => {
    seed();
    const tools = buildHandlers();
    const sendReply = tools["send_reply"];

    const taskId = makeTask("api");
    const reply = await call(sendReply, {
      alias: "api",
      text: "dashboard reply via api",
      in_reply_to: taskId,
      status: "replied",
      from_session: AGENT_ALIAS,
    });

    expect(reply.ok).toBe(true);
    expect(reply.warning).toBeUndefined();
  });
});
