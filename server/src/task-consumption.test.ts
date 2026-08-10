import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_task_consumption";
const USER = "user_task_consumption";
const NODE_A = "node_consumption_a";
const NODE_B = "node_consumption_b";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const table of ["tasks", "inbox", "task_events", "sessions", "nodes"]) {
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
  for (const alias of [NODE_A, NODE_B]) {
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', datetime('now'), datetime('now'), 'active')",
      [`id_${alias}`, alias, NET],
    );
    db.run(
      "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))",
      [`resume_${alias}`, alias, `id_${alias}`, NET],
    );
  }
}

function toolsFor(opts: { alias?: string; nodeToken?: boolean } = {}) {
  const server = new McpServer({ name: "task-consumption-test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return original(name, description, schema, handler);
  };
  registerTools(
    server,
    undefined,
    NET,
    USER,
    opts.alias ?? USER,
    opts.nodeToken ?? false,
    opts.nodeToken ? `token_${opts.alias}` : null,
  );
  return tools;
}

async function call(handler: ToolHandler, args: any) {
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

async function createTask(content: string, target = NODE_A): Promise<string> {
  // The test calls the registered handler directly, bypassing MCP/Zod's
  // default-value application, so spell out the production default.
  const sent = await call(toolsFor()["send_task"], {
    alias: target,
    task: content,
    priority: "normal",
  });
  expect(sent.ok).toBe(true);
  return sent.task_id ?? sent.message_id;
}

function consumedAt(taskId: string): string | null {
  return db.get<{ consumed_at: string | null }>(
    "SELECT consumed_at FROM tasks WHERE task_id = ?1",
    taskId,
  )?.consumed_at ?? null;
}

function runtimeSubmittedAt(taskId: string): string | null {
  return db.get<{ runtime_submitted_at: string | null }>(
    "SELECT runtime_submitted_at FROM tasks WHERE task_id = ?1",
    taskId,
  )?.runtime_submitted_at ?? null;
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("task consumed_at identity and lifecycle", () => {
  test("enqueue and process-level ack keep consumed_at null", async () => {
    const content = "connected process has not started a model turn";
    const before = db.get<{ last_seen_at: string; task: string | null }>(
      "SELECT last_seen_at, task FROM sessions WHERE network_id = ?1 AND alias = ?2",
      NET,
      NODE_A,
    );
    const taskId = await createTask(content);
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(consumedAt(taskId)).toBeNull();
    const queued = db.get<{ last_seen_at: string; task: string | null }>(
      "SELECT last_seen_at, task FROM sessions WHERE network_id = ?1 AND alias = ?2",
      NET,
      NODE_A,
    );
    // Preserve the issue's witnessed-red shape: dispatch echoes the sender's
    // own text into the legacy session.task field while the receiver's
    // heartbeat remains frozen. consumed_at must not inherit that false cue.
    expect(queued?.task).toBe(content);
    expect(queued?.last_seen_at).toBe(before?.last_seen_at);

    const nodeTools = toolsFor({ alias: NODE_A, nodeToken: true });
    expect((await call(nodeTools.ack_inbox, { alias: NODE_A, message_id: taskId })).ok).toBe(true);
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(consumedAt(taskId)).toBeNull();
  });

  test("runtime submission is visible without claiming authoritative consumption", async () => {
    const taskId = await createTask("vendor request accepted but no turn event yet");
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_runtime_submitted;
    expect((await call(handler, { task_ids: [taskId] })).ok).toBe(true);
    expect(typeof runtimeSubmittedAt(taskId)).toBe("string");
    expect(consumedAt(taskId)).toBeNull();
  });

  test("token-bound target marks exact task idempotently", async () => {
    const taskId = await createTask("runtime emitted an attributable event");
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed;

    const first = await call(handler, { task_ids: [taskId] });
    expect(first.ok).toBe(true);
    expect(first.tasks).toHaveLength(1);
    expect(typeof runtimeSubmittedAt(taskId)).toBe("string");
    expect(typeof consumedAt(taskId)).toBe("string");
    const timestamp = consumedAt(taskId);

    const replay = await call(handler, { task_ids: [taskId] });
    expect(replay.ok).toBe(true);
    expect(consumedAt(taskId)).toBe(timestamp);

    const listed = await call(toolsFor().list_tasks, { alias: NODE_A, limit: 20 });
    const listedTask = listed.tasks.find((task: any) => task.task_id === taskId);
    expect(listedTask?.runtime_submitted_at).toBe(runtimeSubmittedAt(taskId));
    expect(listedTask?.consumed_at).toBe(timestamp);
  });

  test("one runtime wake can mark an exact batch of owned tasks", async () => {
    const firstTask = await createTask("batched wake first");
    const secondTask = await createTask("batched wake second");
    const result = await call(
      toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed,
      { task_ids: [firstTask, secondTask] },
    );
    expect(result.ok).toBe(true);
    expect(new Set(result.tasks.map((row: any) => row.task_id)))
      .toEqual(new Set([firstTask, secondTask]));
    expect(typeof consumedAt(firstTask)).toBe("string");
    expect(typeof consumedAt(secondTask)).toBe("string");
  });

  test("foreign or missing row rejects the whole batch with zero partial writes", async () => {
    const ownTask = await createTask("owned", NODE_A);
    const foreignTask = await createTask("foreign", NODE_B);
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed;

    expect(await call(handler, { task_ids: [ownTask, foreignTask] })).toEqual({
      ok: false,
      error: "task_not_owned",
      task_id: foreignTask,
    });
    expect(consumedAt(ownTask)).toBeNull();
    expect(consumedAt(foreignTask)).toBeNull();
    expect(runtimeSubmittedAt(ownTask)).toBeNull();
    expect(runtimeSubmittedAt(foreignTask)).toBeNull();
  });

  test("user token cannot forge runtime consumption", async () => {
    const taskId = await createTask("user token must not stamp node evidence");
    const result = await call(toolsFor().mark_tasks_consumed, { task_ids: [taskId] });
    expect(result).toEqual({ ok: false, error: "node_token_required" });
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(consumedAt(taskId)).toBeNull();
  });

  test("retry and reassign clear evidence from the previous delivery attempt", async () => {
    const taskId = await createTask("attempt-scoped evidence");
    const nodeTools = toolsFor({ alias: NODE_A, nodeToken: true });
    expect((await call(nodeTools.mark_tasks_consumed, { task_ids: [taskId] })).ok).toBe(true);
    expect(typeof consumedAt(taskId)).toBe("string");

    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [taskId]);
    expect((await call(toolsFor().retry_task, { task_id: taskId })).ok).toBe(true);
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(consumedAt(taskId)).toBeNull();

    expect((await call(nodeTools.mark_tasks_consumed, { task_ids: [taskId] })).ok).toBe(true);
    expect(typeof consumedAt(taskId)).toBe("string");
    expect((await call(toolsFor().reassign_task, { task_id: taskId, new_alias: NODE_B })).ok).toBe(true);
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(consumedAt(taskId)).toBeNull();
  });
});
