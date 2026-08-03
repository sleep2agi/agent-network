import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { sharedSendDedup } from "./send_dedup.js";

const NET = "net_chat_idem";
const USER = "user_chat_idem";
const TARGET = "node_chat_idem";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const table of ["tasks", "inbox", "task_events"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
  sharedSendDedup.clear();
}

function seed() {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', datetime('now'), datetime('now'), 'active')", [`id_${TARGET}`, TARGET, NET]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))", [`resume_${TARGET}`, TARGET, `id_${TARGET}`, NET]);
}

function sendTaskHandler(auth?: { callerAlias: string; nodeToken: boolean }): ToolHandler {
  const server = new McpServer({ name: "idempotency-test", version: "0" }) as any;
  let handler: ToolHandler | undefined;
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, candidate: ToolHandler) => {
    if (name === "send_task") handler = candidate;
    return original(name, description, schema, candidate);
  };
  registerTools(
    server,
    undefined,
    NET,
    USER,
    auth?.callerAlias ?? USER,
    auth?.nodeToken ?? false,
    auth?.nodeToken ? "token_node_chat_idem" : null,
  );
  if (!handler) throw new Error("send_task handler missing");
  return handler;
}

async function call(handler: ToolHandler, args: any) {
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("send_task durable idempotency", () => {
  test("Hub stamps authenticated user origin and overrides client spoofing", async () => {
    const handler = sendTaskHandler();
    const sent = await call(handler, {
      alias: TARGET,
      task: "authenticated dashboard payload",
      priority: "normal",
      meta: {
        source: "dashboard-chat",
        client_request_id: "dreq_0123456789abcdef0123456789abcdef",
        auth_origin: "node",
      },
    });
    expect(sent.ok).toBe(true);
    const task = db.get<{ meta_json: string }>("SELECT meta_json FROM tasks WHERE task_id = ?1", [sent.message_id]);
    const inbox = db.get<{ meta_json: string }>("SELECT meta_json FROM inbox WHERE id = ?1", [sent.message_id]);
    expect(JSON.parse(task!.meta_json).auth_origin).toBe("user");
    expect(JSON.parse(inbox!.meta_json).auth_origin).toBe("user");
  });

  test("network-token caller cannot forge Dashboard user origin through MCP", async () => {
    const handler = sendTaskHandler({ callerAlias: "node-origin-sender", nodeToken: true });
    const sent = await call(handler, {
      alias: TARGET,
      task: "node attempts user-origin spoof",
      priority: "normal",
      meta: {
        source: "dashboard-chat",
        client_request_id: "dreq_fedcba9876543210fedcba9876543210",
        auth_origin: "user",
      },
    });
    expect(sent.ok).toBe(true);
    const inbox = db.get<{ meta_json: string }>("SELECT meta_json FROM inbox WHERE id = ?1", [sent.message_id]);
    expect(JSON.parse(inbox!.meta_json).auth_origin).toBe("node");
  });

  test("lost-response retry returns the original task and does not enqueue twice", async () => {
    const handler = sendTaskHandler();
    const args = {
      alias: TARGET,
      task: "chat idempotent payload",
      priority: "normal",
      meta: { client_request_id: "dreq_0123456789abcdef" },
    };
    const first = await call(handler, args);
    const replay = await call(handler, args);

    expect(first.ok).toBe(true);
    expect(replay).toEqual({
      ok: true,
      message_id: first.message_id,
      task_id: first.message_id,
      task_status: "delivered",
      idempotent_replay: true,
    });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE network_id = ?1", [NET])?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE network_id = ?1", [NET])?.count).toBe(1);
  });

  test("request-id reuse with changed content fails closed without a second row", async () => {
    const handler = sendTaskHandler();
    const base = {
      alias: TARGET,
      priority: "normal",
      meta: { client_request_id: "dreq_0123456789abcdef" },
    };
    expect((await call(handler, { ...base, task: "first payload" })).ok).toBe(true);
    expect(await call(handler, { ...base, task: "changed payload" })).toEqual({
      ok: false,
      error: "idempotency_conflict",
      message: "client_request_id was already used with a different task payload",
    });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE network_id = ?1", [NET])?.count).toBe(1);
  });
});
