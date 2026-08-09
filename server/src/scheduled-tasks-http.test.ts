import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { nextOccurrence, runDueScheduledTasks } from "./scheduled-tasks.js";

const dir = mkdtempSync(join(tmpdir(), "anet-scheduler-"));
let server: any;
let base = "";
let ownerToken = "";
let viewerToken = "";
let nodeToken = "";
let networkId = "";
let ownerId = "";
const nodeId = `n_sched_${Date.now()}`;

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  process.env.COMMHUB_DB = join(dir, "hub.db");
  const owner = register(`scheduler_owner_${Date.now()}`, "SchedulerOwner123!", undefined, "seed");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  networkId = owner.network_id!;
  ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id = ?1", networkId)!.owner_id;

  const viewer = register(`scheduler_viewer_${Date.now()}`, "SchedulerViewer123!", undefined, "seed");
  expect(viewer.ok).toBe(true);
  viewerToken = viewer.token!;
  const viewerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", viewer.user!.username)!.user_id;
  addNetworkMember(networkId, viewerId, "viewer", ownerId);
  const ntok = createNetworkTokenForNode(ownerId, networkId, "scheduler-node");
  expect(ntok.ok).toBe(true);
  nodeToken = ntok.token!;

  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, 'Scheduler Node', 'scheduler-node', 'codex-sdk', ?2)`,
    [nodeId, networkId],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, 'scheduler-node', 'idle', ?2, ?3)`,
    [`r_${Date.now()}`, nodeId, networkId],
  );
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("Hub scheduled task API and dispatcher", () => {
  let scheduleId = "";
  let revision = 0;

  test("schedule math supports timezone-aware daily and weekly forms", () => {
    const daily = nextOccurrence({ type: "daily", time: "09:30" }, "Asia/Shanghai", new Date("2026-08-09T02:00:00Z"));
    expect(daily?.toISOString()).toBe("2026-08-10T01:30:00.000Z");
    const weekly = nextOccurrence({ type: "weekly", time: "09:30", weekdays: [1] }, "Asia/Shanghai", new Date("2026-08-09T02:00:00Z"));
    expect(weekly?.toISOString()).toBe("2026-08-10T01:30:00.000Z");
  });

  test("owner creates; viewer and node token cannot mutate", async () => {
    const input = {
      network_id: networkId,
      name: "Daily briefing",
      target_node_id: nodeId,
      task: "Summarize the current release state",
      priority: "high",
      timezone: "Asia/Shanghai",
      schedule: { type: "interval", every_seconds: 60 },
    };
    const viewer = await api(viewerToken, "/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
    expect(viewer.status).toBe(403);
    const node = await api(nodeToken, "/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
    expect(node.status).toBe(403);
    expect(node.body.error).toBe("user_token_required");

    const created = await api(ownerToken, "/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
    expect(created.status).toBe(201);
    expect(created.body.schedule.target_node_id).toBe(nodeId);
    expect(created.body.schedule.target_alias).toBe("scheduler-node");
    expect(created.body.schedule.schedule.type).toBe("interval");
    expect(created.body.schedule.created_by).toBeUndefined();
    expect(created.body.schedule.schedule_json).toBeUndefined();
    scheduleId = created.body.schedule.schedule_id;
    revision = created.body.schedule.revision;
  });

  test("network scope hides schedules from foreign users and viewers may read", async () => {
    const visible = await api(viewerToken, `/api/scheduled-tasks?network_id=${encodeURIComponent(networkId)}`);
    expect(visible.status).toBe(200);
    expect(visible.body.schedules.map((x: any) => x.schedule_id)).toContain(scheduleId);

    const foreign = register(`scheduler_foreign_${Date.now()}`, "SchedulerForeign123!", undefined, "seed");
    expect(foreign.ok).toBe(true);
    const hidden = await api(foreign.token!, `/api/scheduled-tasks?network_id=${encodeURIComponent(networkId)}`);
    expect(hidden.status).toBe(403);
  });

  test("due occurrence creates ordinary inbox/task/run atomically and is idempotent", () => {
    const due = new Date(Date.now() - 120_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [due, scheduleId]);
    expect(runDueScheduledTasks().processed).toBe(1);
    const run = db.get<any>("SELECT * FROM scheduled_task_runs WHERE schedule_id = ?1 ORDER BY created_at DESC LIMIT 1", scheduleId)!;
    expect(["delivered", "queued"]).toContain(run.status);
    expect(run.task_id).toBeTruthy();
    const task = db.get<any>("SELECT * FROM tasks WHERE task_id = ?1", run.task_id)!;
    expect(task.to_node_id).toBe(nodeId);
    expect(task.to_name).toBe("scheduler-node");
    expect(task.from_name).toBe("scheduler");
    expect(JSON.parse(task.meta_json).scheduled_task_id).toBe(scheduleId);
    expect(db.get<any>("SELECT id FROM inbox WHERE id = ?1", run.task_id)).toBeTruthy();
    expect(runDueScheduledTasks().processed).toBe(0);
  });

  test("dispatch failure rolls back occurrence, inbox, task, and schedule advance as one unit", async () => {
    const created = await api(ownerToken, "/api/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        network_id: networkId,
        name: "Atomic rollback probe",
        target_node_id: nodeId,
        task: "This dispatch must be all-or-nothing",
        timezone: "UTC",
        schedule: { type: "interval", every_seconds: 60 },
      }),
    });
    expect(created.status).toBe(201);
    const atomicScheduleId = created.body.schedule.schedule_id as string;
    const due = new Date(Date.now() - 10_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [due, atomicScheduleId]);

    // Test-only fault injection at the second durable write. The inbox row has
    // already been attempted when this aborts, so any missing transaction
    // boundary leaves an observable half-state.
    db.run(`CREATE TRIGGER test601_abort_scheduled_task_insert
      BEFORE INSERT ON tasks
      WHEN NEW.meta_json LIKE '%${atomicScheduleId}%'
      BEGIN SELECT RAISE(ABORT, 'test601_injected_task_failure'); END`);
    const failed = runDueScheduledTasks();
    expect(failed.failed).toBe(1);
    expect(db.get("SELECT run_id FROM scheduled_task_runs WHERE schedule_id = ?1", atomicScheduleId)).toBeNull();
    expect(db.get("SELECT id FROM inbox WHERE meta_json LIKE '%' || ?1 || '%'", atomicScheduleId)).toBeNull();
    expect(db.get("SELECT task_id FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", atomicScheduleId)).toBeNull();
    expect(db.get<{ next_run_at: string }>("SELECT next_run_at FROM scheduled_tasks WHERE schedule_id = ?1", atomicScheduleId)!.next_run_at).toBe(due);

    db.run("DROP TRIGGER test601_abort_scheduled_task_insert");
    expect(runDueScheduledTasks().processed).toBe(1);
    expect(db.get("SELECT task_id FROM scheduled_task_runs WHERE schedule_id = ?1", atomicScheduleId)).toBeTruthy();
  });

  test("non-overlap skips while prior task is open; rename follows stable node_id", () => {
    const firstTask = db.get<{ task_id: string }>("SELECT task_id FROM scheduled_task_runs WHERE schedule_id = ?1 AND task_id IS NOT NULL LIMIT 1", scheduleId)!.task_id;
    const due2 = new Date(Date.now() - 60_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [due2, scheduleId]);
    expect(runDueScheduledTasks().processed).toBe(1);
    expect(db.get<any>("SELECT status FROM scheduled_task_runs WHERE schedule_id = ?1 AND scheduled_for = ?2", scheduleId, due2)!.status).toBe("skipped");

    db.run("UPDATE tasks SET status = 'replied', completed_at = datetime('now') WHERE task_id = ?1", [firstTask]);
    db.run("UPDATE nodes SET alias = 'scheduler-renamed' WHERE node_id = ?1 AND network_id = ?2", [nodeId, networkId]);
    db.run("UPDATE sessions SET alias = 'scheduler-renamed' WHERE node_id = ?1 AND network_id = ?2", [nodeId, networkId]);
    const due3 = new Date(Date.now() - 30_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [due3, scheduleId]);
    expect(runDueScheduledTasks().processed).toBe(1);
    const renamedTask = db.get<any>("SELECT t.* FROM tasks t JOIN scheduled_task_runs r ON r.task_id=t.task_id WHERE r.schedule_id=?1 AND r.scheduled_for=?2", scheduleId, due3)!;
    expect(renamedTask.to_name).toBe("scheduler-renamed");
  });

  test("optimistic revision, pause/resume, run-now and cancel preserve history", async () => {
    const latest = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`);
    revision = latest.body.schedule.revision;
    const stale = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, { method: "PATCH", body: JSON.stringify({ revision: revision - 1, status: "paused" }) });
    expect(stale.status).toBe(409);
    const paused = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, { method: "PATCH", body: JSON.stringify({ revision, status: "paused" }) });
    expect(paused.body.schedule.status).toBe("paused");
    expect(paused.body.schedule.next_run_at).toBeNull();
    const resumed = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, { method: "PATCH", body: JSON.stringify({ revision: paused.body.schedule.revision, status: "active" }) });
    expect(resumed.body.schedule.next_run_at).toBeTruthy();

    db.run("UPDATE tasks SET status='replied' WHERE task_id IN (SELECT task_id FROM scheduled_task_runs WHERE schedule_id=?1)", [scheduleId]);
    const manual = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}/run-now?network_id=${encodeURIComponent(networkId)}`, { method: "POST", body: "{}" });
    expect(manual.status).toBe(202);
    expect(manual.body.taskId).toBeTruthy();
    const cancelled = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, { method: "DELETE" });
    expect(cancelled.body.status).toBe("cancelled");
    const runs = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}/runs?network_id=${encodeURIComponent(networkId)}`);
    expect(runs.body.runs.length).toBeGreaterThanOrEqual(4);
  });
});
