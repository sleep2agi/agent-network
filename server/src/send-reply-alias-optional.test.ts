// #1085 — send_reply must not require `alias` when `in_reply_to` is set.
//
// Symptom (deployed SDK-runtime nodes): `mcp__commhub__send_reply(task_id,
// text)` → `-32602 Invalid input: expected string, received undefined at
// alias`. That is the HUB's Zod schema rejecting a required `alias` the
// client never sent — the request dies before the handler runs, so the
// original task is never terminalized and its inbox row stays unacked
// (pending inflation).
//
// Fix (two parts, both in tools.ts):
//   1. `replyToolSchema.alias` → optional (stops the MCP-layer Zod -32602).
//   2. `handleReply` derives the target from the in_reply_to task's
//      `from_name` when alias is omitted — the target was always knowable
//      from the task the hub already looks up, so the param was redundant.
//
// This suite drives the registered handler directly (MCP Zod layer is
// exercised separately by the framework), so it pins part (2): omit alias
// → derive → reply lands on the original sender; omit both → clean error.
//
// 改坏报红 gate: revert the derive block (require alias again) and
// "alias omitted → derives to original sender" flips to a resolve failure.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET_ID = "net_1085";
const USER_ID = "u_1085";
const NODE_ID = "node_1085";
const AGENT_ALIAS = "worker-1085";
const ORIGIN_ALIAS = "boss-1085"; // the task's from_name — the derive target
const AGENT_TOK_ID = "tok_1085";

interface ToolHandler {
  (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
interface Reply { ok?: boolean; message_id?: string; error?: string; message?: string; [k: string]: unknown; }

function cleanup() {
  for (const t of ["tasks", "inbox", "task_events", "sessions", "nodes", "api_tokens", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET_ID]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}
beforeEach(cleanup);
afterAll(cleanup);

function seed(): { taskId: string } {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER_ID, USER_ID]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET_ID, NET_ID, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER_ID, NET_ID]);
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'), 'active')`, [NODE_ID, AGENT_ALIAS, AGENT_ALIAS, NET_ID, `host-${AGENT_ALIAS}`]);
  db.run(`INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`, [`res_${AGENT_ALIAS}`, AGENT_ALIAS, NODE_ID, NET_ID]);
  // The reply TARGET session (the task originator). Its alias is what the
  // handler must derive from the task's from_name.
  db.run(`INSERT INTO sessions (resume_id, alias, status, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, datetime('now'), datetime('now'))`, [`res_${ORIGIN_ALIAS}`, ORIGIN_ALIAS, NET_ID]);
  // A task from ORIGIN_ALIAS → the worker. Replying to it should land on
  // ORIGIN_ALIAS even when the caller omits alias.
  const taskId = `task_1085_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  db.run(`INSERT INTO tasks (task_id, from_name, to_name, status, content, requires_response, created_at, delivered_at, expires_at, network_id, priority) VALUES (?1, ?2, ?3, 'delivered', 'do the thing', 'reply', datetime('now'), datetime('now'), datetime('now', '+1 hour'), ?4, 'normal')`, [taskId, ORIGIN_ALIAS, AGENT_ALIAS, NET_ID]);
  return { taskId };
}

async function getHandler(): Promise<ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" });
  const tools: Record<string, ToolHandler> = {};
  const originalTool = (server as any).tool.bind(server);
  (server as any).tool = (name: string, ...rest: any[]) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === "function") tools[name] = handler;
    return originalTool(name, ...rest);
  };
  registerTools(server, {
    enforceNetworkId: NET_ID,
    enforceUserId: USER_ID,
    callerAlias: AGENT_ALIAS,
    callerTokenIsNetwork: true,
    callerTokenId: AGENT_TOK_ID,
  } as any);
  const handler = tools.send_reply;
  if (!handler) throw new Error("send_reply handler not registered");
  return handler;
}

async function call(h: ToolHandler, args: any): Promise<Reply> {
  return JSON.parse((await h(args)).content[0].text) as Reply;
}

describe("#1085 send_reply — alias optional, derived from in_reply_to", () => {
  test("alias OMITTED + in_reply_to set → derives target from task from_name, reply lands on originator", async () => {
    const { taskId } = seed();
    const h = await getHandler();
    const r = await call(h, { in_reply_to: taskId, text: "done", status: "replied", from_session: AGENT_ALIAS });
    expect(r.ok).toBe(true);
    // The reply inbox row must be addressed to the derived originator.
    const row = db.get<{ session_name: string; in_reply_to: string }>(
      "SELECT session_name, in_reply_to FROM inbox WHERE id = ?1", [r.message_id],
    );
    expect(row?.session_name).toBe(ORIGIN_ALIAS);
    expect(row?.in_reply_to).toBe(taskId);
    // And the original task is terminalized (no longer pending).
    const task = db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", [taskId]);
    expect(task?.status).toBe("replied");
  });

  test("alias EXPLICIT still works (unchanged path)", async () => {
    const { taskId } = seed();
    const h = await getHandler();
    const r = await call(h, { alias: ORIGIN_ALIAS, in_reply_to: taskId, text: "done", from_session: AGENT_ALIAS });
    expect(r.ok).toBe(true);
    const row = db.get<{ session_name: string }>("SELECT session_name FROM inbox WHERE id = ?1", [r.message_id]);
    expect(row?.session_name).toBe(ORIGIN_ALIAS);
  });

  test("alias OMITTED + no in_reply_to → clean error, not a crash", async () => {
    seed();
    const h = await getHandler();
    const r = await call(h, { text: "orphan reply", from_session: AGENT_ALIAS });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("reply_target_required");
  });

  test("alias OMITTED + in_reply_to points at nonexistent task → resolve error", async () => {
    seed();
    const h = await getHandler();
    const r = await call(h, { in_reply_to: "task_does_not_exist_1085", text: "x", from_session: AGENT_ALIAS });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("reply_target_unresolved");
  });
});
