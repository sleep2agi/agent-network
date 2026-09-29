import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { dispatchScheduledOccurrence, handleScheduledTaskRequest } from "./scheduled-tasks.js";

// A skip used to record only error_code=previous_run_active. The owner saw
// dozens of identical 「已跳过」 rows while the node sat idle, because the
// open task had never reached it. The skip record now names the blocking task
// and whether the node had picked it up.

const NET = "net_sched_skip_blocking";
const NODE = "n_sched_skip_blocking";
const ALIAS = "sched-skip-blocking";

function cleanup(): void {
  for (const table of ["task_events", "inbox", "scheduled_task_runs", "scheduled_tasks", "tasks", "sessions", "nodes"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
}

function seedSchedule(): any {
  const scheduleId = `sched_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, 'skip detail', ?3, ?4, 'scheduled task', 'normal', 'interval',
             '{"type":"interval","every_seconds":60}', 'UTC', 'active', datetime('now', '+1 minute'))`,
    [scheduleId, NET, NODE, ALIAS],
  );
  return db.get("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId);
}

function run(runId: string): any {
  return db.get(
    "SELECT status, error_code, error_message, blocked_by_task_id, blocked_by_state FROM scheduled_task_runs WHERE run_id = ?1",
    runId,
  );
}

beforeEach(() => {
  cleanup();
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, lifecycle_state)
     VALUES (?1, ?2, ?2, 'codex-sdk', ?3, 'active')`,
    [NODE, ALIAS, NET],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`r_${crypto.randomUUID()}`, ALIAS, NODE, NET],
  );
});

afterAll(cleanup);

describe("skipped run names the task that blocked it", () => {
  test("open task still unacked in the inbox → not_received", () => {
    const schedule = seedSchedule();
    const first = dispatchScheduledOccurrence(schedule, "2026-09-29T08:00:00.000Z", false);
    expect(first.status).toBe("delivered");

    const second = dispatchScheduledOccurrence(schedule, "2026-09-29T08:01:00.000Z", false);
    expect(second.status).toBe("skipped");
    const row = run(second.runId);
    expect(row.error_code).toBe("previous_run_active");
    expect(row.blocked_by_task_id).toBe(first.taskId);
    expect(row.blocked_by_state).toBe("not_received");
    expect(row.error_message).toContain(first.taskId!);
    expect(row.error_message).toContain("not been received");
  });

  test("open task whose inbox row the node acked → in_progress", () => {
    const schedule = seedSchedule();
    const first = dispatchScheduledOccurrence(schedule, "2026-09-29T09:00:00.000Z", false);
    db.run("UPDATE inbox SET acked = 1 WHERE task_id = ?1", [first.taskId]);

    const second = dispatchScheduledOccurrence(schedule, "2026-09-29T09:01:00.000Z", false);
    expect(second.status).toBe("skipped");
    const row = run(second.runId);
    expect(row.blocked_by_task_id).toBe(first.taskId);
    expect(row.blocked_by_state).toBe("in_progress");
    expect(row.error_message).toContain("still in progress");
  });

  test("task status running counts as received even without an acked inbox row", () => {
    const schedule = seedSchedule();
    const first = dispatchScheduledOccurrence(schedule, "2026-09-29T10:00:00.000Z", false);
    db.run("UPDATE tasks SET status = 'running' WHERE task_id = ?1", [first.taskId]);

    const second = dispatchScheduledOccurrence(schedule, "2026-09-29T10:01:00.000Z", false);
    expect(run(second.runId).blocked_by_state).toBe("in_progress");
  });

  test("GET /runs exposes the blocking task and state", async () => {
    const schedule = seedSchedule();
    const first = dispatchScheduledOccurrence(schedule, "2026-09-29T12:00:00.000Z", false);
    const second = dispatchScheduledOccurrence(schedule, "2026-09-29T12:01:00.000Z", false);
    const url = new URL(`http://hub.test/api/scheduled-tasks/${schedule.schedule_id}/runs`);
    const res = await handleScheduledTaskRequest({
      req: new Request(url, { method: "GET" }),
      url,
      auth: { userId: "u_skip_detail", networkId: NET, username: "skip-detail" },
      isAdmin: false,
      isNodeToken: false,
      scope: { networkId: NET, networkIds: [NET] },
    });
    const body = await res!.json() as any;
    const skipped = body.runs.find((r: any) => r.run_id === second.runId);
    expect(skipped.blocked_by_task_id).toBe(first.taskId);
    expect(skipped.blocked_by_state).toBe("not_received");
  });

  test("a delivered run carries no blocking fields", () => {
    const schedule = seedSchedule();
    const first = dispatchScheduledOccurrence(schedule, "2026-09-29T11:00:00.000Z", false);
    const row = run(first.runId);
    expect(row.blocked_by_task_id).toBeNull();
    expect(row.blocked_by_state).toBeNull();
  });
});
