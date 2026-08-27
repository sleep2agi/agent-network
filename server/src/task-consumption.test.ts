import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { dispatchScheduledOccurrence } from "./scheduled-tasks.js";
import { registerTools } from "./tools.js";

const NET = "net_task_consumption";
const USER = "user_task_consumption";
const NODE_A = "node_consumption_a";
const NODE_B = "node_consumption_b";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const table of ["scheduled_task_runs", "scheduled_tasks", "tasks", "inbox", "task_events", "sessions", "nodes"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
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
      "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, bound_node_id) VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
      [`token_${alias}`, USER, NET, alias, `id_${alias}`],
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

function runtimeContext(taskId: string): { thread_id: string | null; turn_id: string | null } {
  return db.get<{ thread_id: string | null; turn_id: string | null }>(
    "SELECT thread_id, turn_id FROM tasks WHERE task_id = ?1",
    taskId,
  )!;
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("task consumed_at identity and lifecycle", () => {
  test("immutable node cursor paginates beyond 100 without alias or cross-node leakage", async () => {
    for (let i = 0; i < 125; i++) {
      db.run(
        `INSERT INTO tasks (task_id, from_node_id, from_name, to_name, status, content, network_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'replied', 'x', ?5, ?6)`,
        [`page-${String(i).padStart(3, "0")}`, `id_${NODE_A}`, i < 60 ? "old-alias" : NODE_A, NODE_B, NET, `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`],
      );
    }
    db.run(
      `INSERT INTO tasks (task_id, from_node_id, from_name, to_name, status, content, network_id)
       VALUES ('foreign-node-row', ?1, ?2, ?3, 'replied', 'x', ?4)`,
      [`id_${NODE_B}`, NODE_A, NODE_A, NET],
    );
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).list_tasks;
    const first = await call(handler, { from_node_id: `id_${NODE_A}`, durable_cursor: true, limit: 100 });
    expect(first.capability).toBe("list_tasks.immutable-node-cursor.v1");
    expect(first.tasks).toHaveLength(100);
    const second = await call(handler, { from_node_id: `id_${NODE_A}`, durable_cursor: true, limit: 100, ...first.next_cursor });
    expect(second.tasks).toHaveLength(25);
    expect(new Set([...first.tasks, ...second.tasks].map((task: any) => task.task_id)).size).toBe(125);
    expect([...first.tasks, ...second.tasks].some((task: any) => task.task_id === "foreign-node-row")).toBe(false);
    expect((await call(handler, { from_node_id: `id_${NODE_B}`, durable_cursor: true, limit: 100 })).error).toBe("from_node_id_identity_mismatch");
  });
  test("terminal sequence paginates beyond 2000 and admits late completion of an old task", async () => {
    db.run(
      `INSERT INTO tasks (task_id, from_node_id, from_name, to_name, status, content, network_id, created_at)
       VALUES ('old-open-task', ?1, 'renamed-sender', ?2, 'running', 'late', ?3, '2020-01-01 00:00:00')`,
      [`id_${NODE_A}`, NODE_B, NET],
    );
    for (let i = 0; i < 2_001; i++) {
      db.run(
        `INSERT INTO tasks (task_id, from_node_id, from_name, to_name, status, content, network_id, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, 'replied', 'x', ?5, ?6, datetime('now'))`,
        [`terminal-page-${String(i).padStart(4, "0")}`, `id_${NODE_A}`, i < 1_000 ? "old-alias" : NODE_A, NODE_B, NET, `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`],
      );
    }
    db.run(
      `INSERT INTO tasks (task_id, from_node_id, from_name, to_name, status, content, network_id)
       VALUES ('terminal-cross-network', ?1, ?2, ?3, 'replied', 'x', 'other-network')`,
      [`id_${NODE_A}`, NODE_A, NODE_B],
    );
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).list_tasks;
    let after = 0;
    const ids: string[] = [];
    for (let page = 0; page < 30; page++) {
      const response = await call(handler, {
        from_node_id: `id_${NODE_A}`, durable_cursor: true, durable_terminal_cursor: true,
        after_terminal_seq: after, limit: 100,
      });
      expect(response.capability).toBe("list_tasks.immutable-terminal-sequence.v2");
      ids.push(...response.tasks.map((task: any) => task.task_id));
      after = response.next_terminal_seq;
      if (!response.has_more) break;
    }
    expect(ids).toHaveLength(2_001);
    expect(new Set(ids).size).toBe(2_001);
    expect(ids).not.toContain("terminal-cross-network");
    db.run("UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE task_id = 'old-open-task'");
    const late = await call(handler, {
      from_node_id: `id_${NODE_A}`, durable_cursor: true, durable_terminal_cursor: true,
      after_terminal_seq: after, limit: 100,
    });
    expect(late.tasks.map((task: any) => task.task_id)).toEqual(["old-open-task"]);
  }, 20_000);
  test("enqueue and process-level ack keep consumed_at null", async () => {
    const content = "connected process has not started a model turn";
    const before = db.get<{ last_seen_at: string; task: string | null }>(
      "SELECT last_seen_at, task FROM sessions WHERE network_id = ?1 AND alias = ?2",
      NET,
      NODE_A,
    );
    const taskId = await createTask(content);
    const nodeTools = toolsFor({ alias: NODE_A, nodeToken: true });
    const pending = await call(nodeTools.get_inbox, { alias: NODE_A, limit: 20 });
    expect(pending.messages.find((row: any) => row.id === taskId)?.task_id).toBe(taskId);
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

  test("token-bound consumed evidence persists and exposes an exact BTW boundary", async () => {
    const taskId = await createTask("runtime emitted exact Codex context");
    const handler = toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed;
    const context = { task_id: taskId, thread_id: "thread_btw_exact", turn_id: "turn_btw_exact" };

    const first = await call(handler, { task_ids: [taskId], task_contexts: [context] });
    expect(first.ok).toBe(true);
    expect(first.tasks[0]).toMatchObject(context);
    expect(runtimeContext(taskId)).toEqual({
      thread_id: context.thread_id,
      turn_id: context.turn_id,
    });

    const listed = await call(toolsFor().list_tasks, { alias: NODE_A, limit: 20 });
    expect(listed.tasks.find((task: any) => task.task_id === taskId)).toMatchObject(context);

    const replay = await call(handler, { task_ids: [taskId], task_contexts: [context] });
    expect(replay.ok).toBe(true);
    const conflict = await call(handler, {
      task_ids: [taskId],
      task_contexts: [{ ...context, turn_id: "turn_sibling" }],
    });
    expect(conflict).toEqual({
      ok: false,
      error: "task_runtime_context_conflict",
      task_id: taskId,
    });
    expect(runtimeContext(taskId)).toEqual({
      thread_id: context.thread_id,
      turn_id: context.turn_id,
    });
  });

  test("runtime context rejects user tokens, foreign tasks, and unrequested ids without partial writes", async () => {
    const ownTask = await createTask("owned context", NODE_A);
    const foreignTask = await createTask("foreign context", NODE_B);
    const ownContext = { task_id: ownTask, thread_id: "thread_owned", turn_id: "turn_owned" };
    const foreignContext = { task_id: foreignTask, thread_id: "thread_foreign", turn_id: "turn_foreign" };

    expect(await call(toolsFor().mark_tasks_consumed, {
      task_ids: [ownTask], task_contexts: [ownContext],
    })).toEqual({ ok: false, error: "node_token_required" });
    expect(await call(toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed, {
      task_ids: [ownTask, foreignTask], task_contexts: [ownContext, foreignContext],
    })).toEqual({ ok: false, error: "task_not_owned", task_id: foreignTask });
    expect(await call(toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed, {
      task_ids: [ownTask], task_contexts: [foreignContext],
    })).toEqual({ ok: false, error: "task_context_not_requested", task_id: foreignTask });
    expect(runtimeContext(ownTask)).toEqual({ thread_id: null, turn_id: null });
    expect(runtimeContext(foreignTask)).toEqual({ thread_id: null, turn_id: null });
  });

  test("submitted evidence cannot smuggle a runtime context", async () => {
    const taskId = await createTask("submission has no authoritative turn yet");
    const result = await call(
      toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_runtime_submitted,
      {
        task_ids: [taskId],
        task_contexts: [{ task_id: taskId, thread_id: "thread_early", turn_id: "turn_early" }],
      },
    );
    expect(result).toEqual({ ok: false, error: "runtime_context_requires_consumed" });
    expect(runtimeSubmittedAt(taskId)).toBeNull();
    expect(runtimeContext(taskId)).toEqual({ thread_id: null, turn_id: null });
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

  test("token-bound canonical alias is the fail-closed fallback only for tasks without node_id", async () => {
    const taskId = await createTask("legacy direct session has no immutable node id");
    db.run("UPDATE tasks SET to_node_id = NULL WHERE task_id = ?1", [taskId]);
    db.run("UPDATE sessions SET node_id = NULL WHERE network_id = ?1 AND alias = ?2", [NET, NODE_A]);

    const ownerResult = await call(
      toolsFor({ alias: NODE_A, nodeToken: true }).mark_tasks_consumed,
      { task_ids: [taskId] },
    );
    expect(ownerResult.ok).toBe(true);
    expect(typeof consumedAt(taskId)).toBe("string");

    const foreignTask = await createTask("alias fallback must not cross target aliases", NODE_A);
    db.run("UPDATE tasks SET to_node_id = NULL WHERE task_id = ?1", [foreignTask]);
    const foreignResult = await call(
      toolsFor({ alias: NODE_B, nodeToken: true }).mark_tasks_consumed,
      { task_ids: [foreignTask] },
    );
    expect(foreignResult).toEqual({ ok: false, error: "task_not_owned", task_id: foreignTask });
    expect(consumedAt(foreignTask)).toBeNull();
  });

  test("retry keeps task-lifetime evidence and exposes the logical task id on the new inbox row", async () => {
    const taskId = await createTask("task-lifetime evidence");
    const nodeTools = toolsFor({ alias: NODE_A, nodeToken: true });
    expect((await call(nodeTools.ack_inbox, { alias: NODE_A, message_id: taskId })).ok).toBe(true);
    expect((await call(nodeTools.mark_tasks_consumed, { task_ids: [taskId] })).ok).toBe(true);
    const submitted = runtimeSubmittedAt(taskId);
    const consumed = consumedAt(taskId);
    expect(typeof submitted).toBe("string");
    expect(typeof consumed).toBe("string");

    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [taskId]);
    expect((await call(toolsFor().retry_task, { task_id: taskId })).ok).toBe(true);
    expect(runtimeSubmittedAt(taskId)).toBe(submitted);
    expect(consumedAt(taskId)).toBe(consumed);

    const retriedInbox = await call(nodeTools.get_inbox, { alias: NODE_A, limit: 20 });
    const retryRow = retriedInbox.messages.find((row: any) => row.id !== taskId && row.task_id === taskId);
    expect(retryRow).toBeDefined();
    expect((await call(nodeTools.ack_inbox, { alias: NODE_A, message_id: retryRow.task_id })).ok).toBe(true);
    expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", retryRow.id)?.acked).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", taskId)?.status).toBe("acked");
  });

  test("an unconsumed first attempt can report against the linked task after retry", async () => {
    const taskId = await createTask("retry must not lose logical task identity");
    const nodeTools = toolsFor({ alias: NODE_A, nodeToken: true });
    expect((await call(nodeTools.ack_inbox, { alias: NODE_A, message_id: taskId })).ok).toBe(true);
    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [taskId]);
    expect((await call(toolsFor().retry_task, { task_id: taskId })).ok).toBe(true);

    const retriedInbox = await call(nodeTools.get_inbox, { alias: NODE_A, limit: 20 });
    const retryRow = retriedInbox.messages.find((row: any) => row.id !== taskId && row.task_id === taskId);
    expect(retryRow).toBeDefined();
    // Backward compatibility: an older consumer may still ACK the transport
    // inbox.id even though all task lifecycle operations use logical task_id.
    expect((await call(nodeTools.ack_inbox, { alias: NODE_A, message_id: retryRow.id })).ok).toBe(true);
    expect((await call(nodeTools.mark_tasks_consumed, { task_ids: [retryRow.task_id] })).ok).toBe(true);
    expect(typeof runtimeSubmittedAt(taskId)).toBe("string");
    expect(typeof consumedAt(taskId)).toBe("string");
  });

  test("reassign preserves task-lifetime evidence and binds the new inbox row to the same task", async () => {
    const taskId = await createTask("reassign keeps logical task evidence");
    const oldOwnerTools = toolsFor({ alias: NODE_A, nodeToken: true });
    expect((await call(oldOwnerTools.ack_inbox, { alias: NODE_A, message_id: taskId })).ok).toBe(true);
    expect((await call(oldOwnerTools.mark_tasks_consumed, { task_ids: [taskId] })).ok).toBe(true);
    const submitted = runtimeSubmittedAt(taskId);
    const consumed = consumedAt(taskId);

    expect((await call(toolsFor().reassign_task, { task_id: taskId, new_alias: NODE_B })).ok).toBe(true);
    expect(runtimeSubmittedAt(taskId)).toBe(submitted);
    expect(consumedAt(taskId)).toBe(consumed);

    const newOwnerTools = toolsFor({ alias: NODE_B, nodeToken: true });
    const reassignedInbox = await call(newOwnerTools.get_inbox, { alias: NODE_B, limit: 20 });
    const row = reassignedInbox.messages.find((message: any) => message.task_id === taskId);
    expect(row).toBeDefined();
    expect(row.id).not.toBe(taskId);
    expect((await call(newOwnerTools.ack_inbox, { alias: NODE_B, message_id: row.task_id })).ok).toBe(true);
    expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", row.id)?.acked).toBe(1);
    expect(await call(oldOwnerTools.mark_tasks_consumed, { task_ids: [taskId] })).toEqual({
      ok: false,
      error: "task_not_owned",
      task_id: taskId,
    });
    expect((await call(newOwnerTools.mark_tasks_consumed, { task_ids: [taskId] })).ok).toBe(true);
  });

  test("scheduler delivery writes and exposes the same logical task id", async () => {
    const scheduleId = `sched_${crypto.randomUUID()}`;
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const row = {
      schedule_id: scheduleId,
      network_id: NET,
      created_by: USER,
      name: "task linkage schedule",
      target_node_id: `id_${NODE_A}`,
      target_alias: NODE_A,
      task_content: "scheduler must preserve logical task identity",
      priority: "normal",
      schedule_type: "once",
      schedule_json: JSON.stringify({ type: "once", run_at: scheduledFor }),
      timezone: "UTC",
      overlap_policy: "skip",
      misfire_policy: "catch_up_once",
      status: "active",
      next_run_at: scheduledFor,
      last_run_at: null,
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any;
    db.run(
      `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias,
        task_content, priority, schedule_type, schedule_json, timezone,
        overlap_policy, misfire_policy, status, next_run_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      [scheduleId, NET, USER, row.name, row.target_node_id, NODE_A, row.task_content,
       row.priority, row.schedule_type, row.schedule_json, row.timezone,
       row.overlap_policy, row.misfire_policy, row.status, row.next_run_at],
    );

    const dispatched = dispatchScheduledOccurrence(row, scheduledFor, false);
    expect(dispatched.taskId).toBeTruthy();
    const inbox = db.get<{ id: string; task_id: string }>(
      "SELECT id, task_id FROM inbox WHERE id = ?1",
      [dispatched.taskId],
    );
    expect(inbox).toEqual({ id: dispatched.taskId!, task_id: dispatched.taskId! });
    const pending = await call(
      toolsFor({ alias: NODE_A, nodeToken: true }).get_inbox,
      { alias: NODE_A, limit: 20 },
    );
    expect(pending.messages.find((message: any) => message.id === dispatched.taskId)?.task_id)
      .toBe(dispatched.taskId);
  });
});
