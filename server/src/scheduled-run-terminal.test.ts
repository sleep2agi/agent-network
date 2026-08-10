import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, chainReplyToParent } from "./db.js";
import { dispatchScheduledOccurrence } from "./scheduled-tasks.js";
import { registerTools } from "./tools.js";
import { patrolExpiredTasks } from "./server.js";

const NET = "net_690_scheduler_terminal";
const USER = "u_690_owner";
const NODE = "n_690_grok";
const ALIAS = "A站GrokTUI-690";

type Handler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup(): void {
  for (const table of ["task_events", "inbox", "scheduled_task_runs", "scheduled_tasks", "tasks", "sessions", "nodes", "network_members", "networks", "users"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seedIdentity(): void {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [USER, USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, lifecycle_state)
     VALUES (?1, ?2, ?2, 'grok-build-acp', ?3, 'active')`,
    [NODE, ALIAS, NET],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES ('r_690', ?1, 'idle', ?2, ?3, datetime('now'), datetime('now'))`,
    [ALIAS, NODE, NET],
  );
}

function handlers(): Record<string, Handler> {
  const server = new McpServer({ name: "test690", version: "0" }) as any;
  const result: Record<string, Handler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, ...args: any[]) => {
    const handler = args.at(-1);
    if (typeof handler === "function") result[name] = handler;
    return original(name, ...args);
  };
  registerTools(server, undefined, NET, USER, USER, false, null);
  return result;
}

async function call(handler: Handler, args: any): Promise<any> {
  const reply = await handler(args);
  return JSON.parse(reply.content[0].text);
}

function seedScheduledTask(status = "delivered", suffix = crypto.randomUUID()): { taskId: string; runId: string; scheduleId: string } {
  const taskId = `task_${suffix}`;
  const runId = `srun_${suffix}`;
  const scheduleId = `sched_${suffix}`;
  const meta = JSON.stringify({ scheduled_task_id: scheduleId, scheduled_run_id: runId, auth_origin: "hub_scheduler" });
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, 'test690', ?3, ?4, 'test690 task', 'normal', 'interval',
             '{"type":"interval","every_seconds":3600}', 'UTC', 'active', datetime('now', '+1 hour'))`,
    [scheduleId, NET, NODE, ALIAS],
  );
  db.run(
    `INSERT INTO tasks
       (task_id, from_name, to_node_id, to_name, priority, status, content, requires_response,
        created_at, delivered_at, expires_at, network_id, meta_json)
     VALUES (?1, 'scheduler', ?2, ?3, 'normal', ?4, 'test690 task', 'reply',
             datetime('now'), datetime('now'), datetime('now', '+1 hour'), ?5, ?6)`,
    [taskId, NODE, ALIAS, status, NET, meta],
  );
  db.run(
    `INSERT INTO inbox (id, task_id, session_name, node_id, type, priority, content, from_session, requires_response, network_id, meta_json)
     VALUES (?1, ?1, ?2, ?3, 'task', 'normal', 'test690 task', 'scheduler', 'reply', ?4, ?5)`,
    [taskId, ALIAS, NODE, NET, meta],
  );
  db.run(
    `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, task_id, status, completed_at)
     VALUES (?1, ?2, ?3, datetime('now'), ?4, ?5, datetime('now'))`,
    [runId, scheduleId, NET, taskId, status],
  );
  return { taskId, runId, scheduleId };
}

const readRun = (runId: string) => db.get<any>(
  "SELECT run_id, task_id, network_id, status, error_code, completed_at FROM scheduled_task_runs WHERE run_id = ?1",
  runId,
);

beforeEach(() => { cleanup(); seedIdentity(); });
afterAll(cleanup);

describe("#690 scheduled run follows the real task lifecycle", () => {
  test("dispatch is open until the task reaches a terminal state", () => {
    const scheduleId = `sched_dispatch_${crypto.randomUUID()}`;
    const row: any = {
      schedule_id: scheduleId,
      network_id: NET,
      name: "dispatch open",
      target_node_id: NODE,
      target_alias: ALIAS,
      task_content: "dispatch open",
      priority: "normal",
      schedule_type: "interval",
      schedule_json: JSON.stringify({ type: "interval", every_seconds: 3600 }),
      timezone: "UTC",
      overlap_policy: "skip",
      misfire_policy: "catch_up_once",
      status: "active",
      next_run_at: new Date(Date.now() + 3600_000).toISOString(),
      last_run_at: null,
      revision: 1,
    };
    db.run(
      `INSERT INTO scheduled_tasks
         (schedule_id, network_id, name, target_node_id, target_alias, task_content, priority,
          schedule_type, schedule_json, timezone, overlap_policy, misfire_policy, status, next_run_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      [scheduleId, NET, row.name, NODE, ALIAS, row.task_content, row.priority, row.schedule_type,
       row.schedule_json, row.timezone, row.overlap_policy, row.misfire_policy, row.status, row.next_run_at],
    );
    const dispatched = dispatchScheduledOccurrence(row, new Date().toISOString(), false);
    const run = readRun(dispatched.runId);
    expect(["delivered", "queued"]).toContain(run.status);
    expect(run.completed_at).toBeNull();
  });

  test("send_reply terminalizes the exact bound run", async () => {
    const { taskId, runId } = seedScheduledTask();
    const reply = await call(handlers().send_reply, {
      alias: ALIAS,
      text: "verified",
      in_reply_to: taskId,
      status: "replied",
      network_id: NET,
      attachments: [{ type: "file", file_id: "file_690_reply", name: "evidence.json", size: 12, mime: "application/json" }],
    });
    expect(reply.ok).toBe(true);
    expect(readRun(runId).status).toBe("replied");
    expect(readRun(runId).completed_at).toBeTruthy();
  });

  test("task and run terminal transition roll back together on an injected run-write failure", async () => {
    const { taskId, runId } = seedScheduledTask();
    db.exec(
      `CREATE TRIGGER test690_fail_run_terminal
         BEFORE UPDATE OF status ON scheduled_task_runs
         WHEN NEW.run_id = '${runId}' AND NEW.status = 'replied'
       BEGIN
         SELECT RAISE(ABORT, 'test690_injected_run_failure');
       END`,
    );
    let threw = false;
    try {
      await call(handlers().send_reply, {
        alias: ALIAS,
        text: "must roll back",
        in_reply_to: taskId,
        status: "replied",
        network_id: NET,
      });
    } catch (error: any) {
      threw = /test690_injected_run_failure/.test(String(error?.message || error));
    } finally {
      db.exec("DROP TRIGGER IF EXISTS test690_fail_run_terminal");
    }
    expect(threw).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", taskId)?.status).toBe("delivered");
    expect(readRun(runId).status).toBe("delivered");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE in_reply_to = ?1", taskId)?.count).toBe(0);
  });

  test("cancel terminalizes, retry reopens, and the retry result closes the same run", async () => {
    const { taskId, runId } = seedScheduledTask();
    const tools = handlers();
    expect((await call(tools.cancel_task, { task_id: taskId, reason: "operator", network_id: NET })).ok).toBe(true);
    expect(readRun(runId).status).toBe("cancelled");
    expect(readRun(runId).completed_at).toBeTruthy();

    expect((await call(tools.retry_task, { task_id: taskId, network_id: NET })).ok).toBe(true);
    expect(readRun(runId).status).toBe("delivered");
    expect(readRun(runId).completed_at).toBeNull();

    expect((await call(tools.send_reply, {
      alias: ALIAS,
      text: "runtime failed",
      in_reply_to: taskId,
      status: "failed",
      network_id: NET,
    })).ok).toBe(true);
    expect(readRun(runId).status).toBe("failed");
    expect(readRun(runId).error_code).toBe("task_failed");
  });

  test("report_completion terminalizes a scheduler run", async () => {
    const { taskId, runId } = seedScheduledTask();
    const reply = await call(handlers().report_completion, {
      alias: ALIAS,
      task: taskId,
      result: "done",
      network_id: NET,
    });
    expect(reply.ok).toBe(true);
    expect(readRun(runId).status).toBe("replied");
  });

  test("expiration patrol closes the exact run in the same lifecycle pass", () => {
    const { taskId, runId } = seedScheduledTask();
    db.run("UPDATE tasks SET expires_at = datetime('now', '-1 minute') WHERE task_id = ?1", [taskId]);
    patrolExpiredTasks();
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", taskId)?.status).toBe("expired");
    expect(readRun(runId).status).toBe("expired");
    expect(readRun(runId).error_code).toBe("task_expired");
    expect(readRun(runId).completed_at).toBeTruthy();
  });

  test("child auto-chain terminalizes a scheduled parent", () => {
    const { taskId: parentId, runId } = seedScheduledTask();
    const childId = `child_${crypto.randomUUID()}`;
    db.run(
      `INSERT INTO tasks
         (task_id, parent_task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
       VALUES (?1, ?2, ?3, 'A站负责人', 'normal', 'replied', 'verify candidate', 'reply', datetime('now'), ?4)`,
      [childId, parentId, ALIAS, NET],
    );
    const result = chainReplyToParent(childId, "news_id=14519", "replied", 5, NET);
    expect(result.chained).toBe(true);
    expect(readRun(runId).status).toBe("replied");
  });

  test("forged metadata cannot cross-bind another task or network run", async () => {
    const victim = seedScheduledTask("delivered", "victim");
    const attackerTaskId = "task_attacker";
    const forgedMeta = JSON.stringify({ scheduled_task_id: victim.scheduleId, scheduled_run_id: victim.runId, auth_origin: "hub_scheduler" });
    db.run(
      `INSERT INTO tasks
         (task_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, network_id, meta_json)
       VALUES (?1, 'scheduler', ?2, ?3, 'normal', 'delivered', 'forged', 'reply', datetime('now'), ?4, ?5)`,
      [attackerTaskId, NODE, ALIAS, NET, forgedMeta],
    );
    await call(handlers().send_reply, {
      alias: ALIAS,
      text: "forged close",
      in_reply_to: attackerTaskId,
      status: "replied",
      network_id: NET,
    });
    expect(readRun(victim.runId).status).toBe("delivered");
  });

  test("a task cannot close a run whose persisted network binding differs", async () => {
    const victim = seedScheduledTask("delivered", "foreign_network");
    db.run("UPDATE scheduled_task_runs SET network_id = 'net_690_foreign' WHERE run_id = ?1", [victim.runId]);
    await call(handlers().send_reply, {
      alias: ALIAS,
      text: "must not cross network",
      in_reply_to: victim.taskId,
      status: "replied",
      network_id: NET,
    });
    expect(readRun(victim.runId).status).toBe("delivered");
  });
});
