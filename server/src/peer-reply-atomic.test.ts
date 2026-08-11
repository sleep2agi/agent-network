import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_peer_reply_698";
const USER = "user_peer_reply_698";
const A = "peer-a-698";
const B = "peer-b-698";
const A_ID = "node-peer-a-698";
const B_ID = "node-peer-b-698";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  try { db.exec("DROP TRIGGER IF EXISTS test698_abort_terminal"); } catch {}
  for (const table of ["scheduled_task_runs", "scheduled_tasks", "tasks", "inbox", "task_events", "sessions", "nodes"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  for (const [alias, nodeId] of [[A, A_ID], [B, B_ID]] as const) {
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', datetime('now'), datetime('now'), 'active')",
      [nodeId, alias, NET],
    );
    db.run(
      "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))",
      [`resume-${alias}`, alias, nodeId, NET],
    );
  }
}

function toolsFor(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "peer-reply-698", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return original(name, description, schema, handler);
  };
  registerTools(server, undefined, NET, USER, alias, true, `token-${alias}`);
  return tools;
}

async function call(handler: ToolHandler, args: any) {
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

async function dispatch(from: string, to: string, content: string): Promise<string> {
  const sent = await call(toolsFor(from).send_task, { alias: to, task: content, priority: "normal" });
  expect(sent.ok).toBe(true);
  return sent.task_id ?? sent.message_id;
}

function task(taskId: string) {
  return db.get<any>("SELECT * FROM tasks WHERE task_id = ?1", taskId);
}

function replies(taskId: string) {
  return db.all<any>("SELECT * FROM inbox WHERE in_reply_to = ?1 ORDER BY rowid", taskId);
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("#698 atomic peer reply", () => {
  test("owner node terminalizes exact original and emits one no-response reply without a task row", async () => {
    const taskId = await dispatch(A, B, "do work");
    const result = await call(toolsFor(B).send_reply, {
      alias: A,
      text: "done exactly once",
      in_reply_to: taskId,
      status: "replied",
    });
    expect(result.ok).toBe(true);
    expect(task(taskId)).toEqual(expect.objectContaining({ status: "replied", result: "done exactly once" }));
    expect(task(taskId).completed_at).toBeTruthy();
    expect(replies(taskId)).toHaveLength(1);
    expect(replies(taskId)[0]).toEqual(expect.objectContaining({
      session_name: A,
      node_id: A_ID,
      type: "reply",
      requires_response: "none",
      content: "done exactly once",
    }));
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?1", taskId)?.n).toBe(0);
  });

  test("terminal replay is rejected and cannot deliver twice", async () => {
    const taskId = await dispatch(A, B, "idempotent work");
    const handler = toolsFor(B).send_reply;
    expect((await call(handler, { alias: A, text: "first", in_reply_to: taskId, status: "replied" })).ok).toBe(true);
    const replay = await call(handler, { alias: A, text: "second", in_reply_to: taskId, status: "replied" });
    expect(replay).toEqual(expect.objectContaining({ ok: false, error: "reply_task_terminal", reply_queued: false }));
    expect(task(taskId).result).toBe("first");
    expect(replies(taskId)).toHaveLength(1);
  });

  test("foreign node and wrong origin target are rejected with zero writes", async () => {
    const taskId = await dispatch(A, B, "owned by B");
    const foreign = await call(toolsFor(A).send_reply, { alias: A, text: "forge", in_reply_to: taskId, status: "replied" });
    expect(foreign).toEqual(expect.objectContaining({ ok: false, error: "reply_task_not_owned" }));
    const wrongTarget = await call(toolsFor(B).send_reply, { alias: B, text: "misroute", in_reply_to: taskId, status: "replied" });
    expect(wrongTarget).toEqual(expect.objectContaining({ ok: false, error: "reply_target_mismatch" }));
    expect(task(taskId).status).toBe("delivered");
    expect(replies(taskId)).toHaveLength(0);
  });

  test("task update failure rolls back the reply inbox insert", async () => {
    const taskId = await dispatch(A, B, "atomic failure");
    db.exec(`CREATE TRIGGER test698_abort_terminal BEFORE UPDATE OF status ON tasks
      WHEN OLD.task_id = '${taskId}' BEGIN SELECT RAISE(ABORT, 'test698 injected'); END`);
    await expect(call(toolsFor(B).send_reply, {
      alias: A,
      text: "must rollback",
      in_reply_to: taskId,
      status: "replied",
    })).rejects.toThrow("test698 injected");
    expect(task(taskId).status).toBe("delivered");
    expect(task(taskId).result).toBeNull();
    expect(replies(taskId)).toHaveLength(0);
  });

  test("three exchanges leave only dispatched work rows and no open tasks", async () => {
    for (let i = 0; i < 3; i++) {
      const taskId = await dispatch(A, B, `work-${i}`);
      expect((await call(toolsFor(B).send_reply, {
        alias: A,
        text: `result-${i}`,
        in_reply_to: taskId,
        status: "replied",
      })).ok).toBe(true);
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1", NET)?.n).toBe(3);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND status IN ('created','delivered','acked','running')", NET)?.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1 AND type = 'reply' AND requires_response = 'none'", NET)?.n).toBe(3);
  });
});
