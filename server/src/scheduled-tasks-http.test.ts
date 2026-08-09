import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { assertScheduledTaskBackendSupported, nextOccurrence, runDueScheduledTasks } from "./scheduled-tasks.js";

const dir = mkdtempSync(join(tmpdir(), "anet-scheduler-"));
const activeDbPath = process.env.COMMHUB_DB;
if (!activeDbPath) throw new Error("test601 requires COMMHUB_DB before module import");
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

    // America/New_York skips 02:30 on 2026-03-08, so the next valid wall
    // clock occurrence is the following day rather than an offset guess.
    const springGap = nextOccurrence({ type: "daily", time: "02:30" }, "America/New_York", new Date("2026-03-08T05:00:00Z"));
    expect(springGap?.toISOString()).toBe("2026-03-09T06:30:00.000Z");

    // 01:30 occurs twice on the fall-back day. Before the first occurrence we
    // select it; after it has run, the duplicate instant on the same local
    // date is skipped so a daily schedule remains once-per-day.
    const fallFirst = nextOccurrence({ type: "daily", time: "01:30" }, "America/New_York", new Date("2026-11-01T04:00:00Z"));
    expect(fallFirst?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const fallAfterFirst = nextOccurrence({ type: "daily", time: "01:30" }, "America/New_York", fallFirst!);
    expect(fallAfterFirst?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("scheduler startup rejects a backend without real transactions", () => {
    const original = db.dialect;
    try {
      (db as any).dialect = "postgres";
      expect(() => assertScheduledTaskBackendSupported()).toThrow("scheduled_tasks_require_transactional_sqlite_backend");
    } finally {
      (db as any).dialect = original;
    }
    expect(() => assertScheduledTaskBackendSupported()).not.toThrow();
    const misfireColumn = db.all<any>("PRAGMA table_info(scheduled_tasks)").find((column: any) => column.name === "misfire_policy");
    expect(misfireColumn?.dflt_value).toBe("'catch_up_once'");
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
    const nodeRead = await api(nodeToken, `/api/scheduled-tasks?network_id=${encodeURIComponent(networkId)}`);
    expect(nodeRead.status).toBe(403);
    expect(nodeRead.body.error).toBe("user_token_required");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE name = 'Daily briefing'")!.count).toBe(0);

    const created = await api(ownerToken, "/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
    expect(created.status).toBe(201);
    expect(created.body.schedule.target_node_id).toBe(nodeId);
    expect(created.body.schedule.target_alias).toBe("scheduler-node");
    expect(created.body.schedule.schedule.type).toBe("interval");
    expect(created.body.schedule.misfire_policy).toBe("catch_up_once");
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
    expect(JSON.parse(task.meta_json).created_by).toBeUndefined();
    expect(db.get<any>("SELECT id FROM inbox WHERE id = ?1", run.task_id)).toBeTruthy();
    expect(runDueScheduledTasks().processed).toBe(0);
  });

  test("misfire policy catches up once by default or skips an overdue occurrence", async () => {
    const make = async (name: string, misfirePolicy?: string) => api(ownerToken, "/api/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        network_id: networkId,
        name,
        target_node_id: nodeId,
        task: `misfire probe ${name}`,
        timezone: "UTC",
        schedule: { type: "interval", every_seconds: 60 },
        ...(misfirePolicy === undefined ? {} : { misfire_policy: misfirePolicy }),
      }),
    });

    const invalid = await make("invalid misfire", "run_everything");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_misfire_policy");

    const now = new Date();
    const overdue = new Date(now.getTime() - 5 * 60_000).toISOString();

    const catchUp = await make("catch up default");
    expect(catchUp.status).toBe(201);
    expect(catchUp.body.schedule.misfire_policy).toBe("catch_up_once");
    const catchUpId = catchUp.body.schedule.schedule_id as string;
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [overdue, catchUpId]);
    expect(runDueScheduledTasks(now).processed).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", catchUpId)!.count).toBe(1);
    expect(new Date(db.get<{ next_run_at: string }>("SELECT next_run_at FROM scheduled_tasks WHERE schedule_id = ?1", catchUpId)!.next_run_at).getTime()).toBeGreaterThan(now.getTime());

    const skipped = await make("skip overdue", "skip");
    expect(skipped.status).toBe(201);
    expect(skipped.body.schedule.misfire_policy).toBe("skip");
    const skippedId = skipped.body.schedule.schedule_id as string;
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [overdue, skippedId]);
    expect(runDueScheduledTasks(now).processed).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", skippedId)!.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE meta_json LIKE '%' || ?1 || '%'", skippedId)!.count).toBe(0);
    const skippedRun = db.get<any>("SELECT * FROM scheduled_task_runs WHERE schedule_id = ?1", skippedId)!;
    expect(skippedRun.status).toBe("skipped");
    expect(skippedRun.error_code).toBe("misfire_skipped");
    const skippedRow = db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", skippedId)!;
    expect(skippedRow.last_run_at).toBeNull();
    expect(new Date(skippedRow.next_run_at).getTime()).toBeGreaterThan(now.getTime());

    const withinGrace = await make("skip within grace", "skip");
    const withinGraceId = withinGrace.body.schedule.schedule_id as string;
    const recent = new Date(now.getTime() - 10_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [recent, withinGraceId]);
    expect(runDueScheduledTasks(now).processed).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", withinGraceId)!.count).toBe(1);

    const once = await api(ownerToken, "/api/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        network_id: networkId,
        name: "skip missed once",
        target_node_id: nodeId,
        task: "this missed one-time task must never run",
        timezone: "UTC",
        misfire_policy: "skip",
        schedule: { type: "once", run_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
    });
    const onceId = once.body.schedule.schedule_id as string;
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [overdue, onceId]);
    expect(runDueScheduledTasks(now).processed).toBe(1);
    const onceRow = db.get<any>("SELECT status, next_run_at, last_run_at FROM scheduled_tasks WHERE schedule_id = ?1", onceId)!;
    expect(onceRow).toEqual({ status: "completed", next_run_at: null, last_run_at: null });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", onceId)!.count).toBe(0);
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

  test("two real Hub processes claim one occurrence exactly once", async () => {
    const created = await api(ownerToken, "/api/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        network_id: networkId,
        name: "Cross-process claim probe",
        target_node_id: nodeId,
        task: "Only one worker may create this task",
        timezone: "UTC",
        schedule: { type: "interval", every_seconds: 60 },
      }),
    });
    expect(created.status).toBe(201);
    const raceScheduleId = created.body.schedule.schedule_id as string;
    const due = new Date(Date.now() - 5_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [due, raceScheduleId]);

    const raceDir = mkdtempSync(join(dir, "race-"));
    const gate = join(raceDir, "go");
    const workerPath = "tests/test601-hub-scheduled-tasks/race-worker.ts";
    const dbPath = activeDbPath;
    const spawnWorker = (id: string) => Bun.spawn(
      ["bun", workerPath, dbPath, raceScheduleId, due, join(raceDir, `ready-${id}`), gate],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, COMMHUB_DB: dbPath } },
    );
    const waitReady = async (id: string) => {
      const readyPath = join(raceDir, `ready-${id}`);
      const deadline = Date.now() + 8_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(10);
      return existsSync(readyPath);
    };

    // Start both DB connections before opening the claim gate. Initializing
    // them sequentially isolates the occurrence race from the repository's
    // pre-existing simultaneous-cold-start PRAGMA journal_mode=WAL race.
    const workers = [spawnWorker("a")];
    const readyA = await waitReady("a");
    if (readyA) workers.push(spawnWorker("b"));
    const readyB = readyA && await waitReady("b");
    if (!readyA || !readyB) {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited));
      const diagnostics = await Promise.all(workers.map(async (worker) => ({
        stdout: await new Response(worker.stdout).text(),
        stderr: await new Response(worker.stderr).text(),
      })));
      throw new Error(`race_workers_not_ready: ${JSON.stringify(diagnostics)}`);
    }
    writeFileSync(gate, "go\n", { mode: 0o600 });
    const exits = (await Promise.all(workers.map((worker) => worker.exited))).sort((a, b) => a - b);
    expect(exits).toEqual([0, 3]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE schedule_id = ?1", raceScheduleId)!.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE meta_json LIKE '%' || ?1 || '%'", raceScheduleId)!.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE meta_json LIKE '%' || ?1 || '%'", raceScheduleId)!.count).toBe(1);
  }, 20_000);

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

  test("full edit validates target and policy, preserves cadence, and recomputes through DST-safe schedule math", async () => {
    // Pin a recognizable future occurrence so a metadata-only edit can prove
    // that it does not silently reset the interval cadence.
    const pinnedNext = new Date(Date.now() + 45 * 60_000).toISOString();
    db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [pinnedNext, scheduleId]);
    let current = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    const metadataOnly = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        revision: current.revision,
        name: "Edited briefing",
        task: "Summarize only verified release changes",
        priority: "low",
        misfire_policy: "skip",
        // Dashboard/mobile submit a complete form. Identical scheduling
        // values still count as a metadata-only edit and must preserve cadence.
        schedule: current.schedule,
        timezone: current.timezone,
      }),
    });
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body.schedule.name).toBe("Edited briefing");
    expect(metadataOnly.body.schedule.task_content).toBe("Summarize only verified release changes");
    expect(metadataOnly.body.schedule.priority).toBe("low");
    expect(metadataOnly.body.schedule.misfire_policy).toBe("skip");
    expect(metadataOnly.body.schedule.next_run_at).toBe(pinnedNext);

    // A schedule/timezone edit must reuse nextOccurrence's IANA/DST behavior.
    const beforeEdit = new Date();
    const dstEdit = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        revision: metadataOnly.body.schedule.revision,
        schedule: { type: "daily", time: "01:30" },
        timezone: "America/New_York",
      }),
    });
    expect(dstEdit.status).toBe(200);
    expect(dstEdit.body.schedule.schedule).toEqual({ type: "daily", time: "01:30" });
    expect(dstEdit.body.schedule.timezone).toBe("America/New_York");
    const expectedFloor = nextOccurrence({ type: "daily", time: "01:30" }, "America/New_York", beforeEdit)!;
    expect(new Date(dstEdit.body.schedule.next_run_at).getTime()).toBe(expectedFloor.getTime());

    const invalidPolicy = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
      method: "PATCH",
      body: JSON.stringify({ revision: dstEdit.body.schedule.revision, misfire_policy: "run_everything" }),
    });
    expect(invalidPolicy.status).toBe(400);
    expect(invalidPolicy.body.error).toBe("invalid_misfire_policy");

    const foreign = register(`scheduler_edit_foreign_${Date.now()}`, "SchedulerEditForeign123!", undefined, "seed");
    expect(foreign.ok).toBe(true);
    const foreignNetworkId = foreign.network_id!;
    const foreignNodeId = `n_foreign_edit_${Date.now()}`;
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, 'Foreign Edit Node', 'foreign-edit-node', 'codex-sdk', ?2)",
      [foreignNodeId, foreignNetworkId],
    );
    const crossNetwork = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
      method: "PATCH",
      body: JSON.stringify({ revision: dstEdit.body.schedule.revision, target_node_id: foreignNodeId }),
    });
    expect(crossNetwork.status).toBe(404);
    expect(crossNetwork.body.error).toBe("target_node_not_found");
    current = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    expect(current.target_node_id).toBe(nodeId);
    expect(current.revision).toBe(dstEdit.body.schedule.revision);
  });

  test("two editors with one revision produce one winner and one refreshable conflict", async () => {
    const current = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    const [a, b] = await Promise.all([
      api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: current.revision, name: "Concurrent editor A" }),
      }),
      api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: current.revision, name: "Concurrent editor B" }),
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.error).toBe("revision_conflict");
    const latest = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    expect(latest.revision).toBe(current.revision + 1);
    expect(["Concurrent editor A", "Concurrent editor B"]).toContain(latest.name);
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
    const cancelledRow = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    const resurrect = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`, {
      method: "PATCH",
      body: JSON.stringify({ revision: cancelledRow.revision, status: "active", name: "must not revive" }),
    });
    expect(resurrect.status).toBe(409);
    expect(resurrect.body.error).toBe("schedule_cancelled");
    const stillCancelled = (await api(ownerToken, `/api/scheduled-tasks/${scheduleId}?network_id=${encodeURIComponent(networkId)}`)).body.schedule;
    expect(stillCancelled.status).toBe("cancelled");
    expect(stillCancelled.revision).toBe(cancelledRow.revision);
    const runs = await api(ownerToken, `/api/scheduled-tasks/${scheduleId}/runs?network_id=${encodeURIComponent(networkId)}`);
    expect(runs.body.runs.length).toBeGreaterThanOrEqual(4);
  });
});
