// Board #757 — an offline scheduled target produces an auditable skip, not a
// doomed task; each offline episode warns its human/Agent creator once.
// Run: COMMHUB_DB=/tmp/board757.db bun test src/scheduled-offline.test.ts
// PG: registered in tests/test2123-hub-postgres-ladder/run.sh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { register } from "./auth.js";
import { db } from "./db.js";
import { dispatchScheduledOccurrence, getScheduleRow } from "./scheduled-tasks.js";
import { SCHEDULE_TARGET_OFFLINE_NOTICE_KIND, scheduledTargetOffline } from "./scheduled-offline.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("scheduled-offline requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const TARGET_ID = `n_offline_target_${stamp}`;
const TARGET = `offline-target-${stamp}`;
const CREATOR_ID = `n_offline_creator_${stamp}`;
const CREATOR = `offline-creator-${stamp}`;
let NET = "", USER = "", slot = 0;

function seedSchedule(createdByNodeId: string | null = null): any {
  const id = `sched_offline_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, created_by_node_id, name, target_node_id, target_alias,
        task_content, priority, schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, ?3, ?4, '离线巡检', ?5, ?6, 'ping', 'normal', 'interval',
             '{"type":"interval","every_seconds":60}', 'Asia/Shanghai', 'active', datetime('now', '+1 minute'))`,
    [id, NET, USER, createdByNodeId, TARGET_ID, TARGET],
  );
  return getScheduleRow(id)!;
}

function fire(schedule: any) {
  const at = new Date(Date.UTC(2026, 9, 8, 0, 0, 0) + (++slot) * 60_000).toISOString();
  return dispatchScheduledOccurrence(schedule, at, false, new Date());
}

function setTarget(status: "idle" | "offline", minutesAgo = 0) {
  const seen = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  db.run("UPDATE sessions SET status = ?1, updated_at = ?2, last_seen_at = ?2 WHERE node_id = ?3 AND network_id = ?4", [status, seen, TARGET_ID, NET]);
}

const taskCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND to_node_id = ?2", NET, TARGET_ID)!.n;
const humanNotices = (scheduleId: string) => db.all<{ meta_json: string; content: string }>(
  "SELECT meta_json, content FROM user_inbox WHERE network_id = ?1 AND user_id = ?2 AND kind = ?3 ORDER BY created_at, message_id",
  NET, USER, SCHEDULE_TARGET_OFFLINE_NOTICE_KIND,
).filter((row) => JSON.parse(row.meta_json).schedule_target_offline.schedule_id === scheduleId);
const agentNotices = (scheduleId: string) => db.all<{ meta_json: string; content: string }>(
  "SELECT meta_json, content FROM inbox WHERE network_id = ?1 AND node_id = ?2 AND from_session = 'hub' ORDER BY created_at, id",
  NET, CREATOR_ID,
).filter((row) => JSON.parse(row.meta_json).schedule_target_offline?.schedule_id === scheduleId);

beforeAll(() => {
  const owner = register(`offline_owner_${stamp}`, "OfflineOwner123!", undefined, "seed");
  expect(owner.ok).toBe(true);
  NET = owner.network_id!; USER = owner.user!.user_id;
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1, ?2, ?2, 'codex', ?3, ?4)", [TARGET_ID, TARGET, NET, USER]);
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1, ?2, ?2, 'codex', ?3, ?4)", [CREATOR_ID, CREATOR, NET, USER]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'))", [`r_target_${stamp}`, TARGET, TARGET_ID, NET]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'))", [`r_creator_${stamp}`, CREATOR, CREATOR_ID, NET]);
});

afterAll(() => {
  db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [NET, SCHEDULE_TARGET_OFFLINE_NOTICE_KIND]);
});

describe("#757 scheduled target offline", () => {
  test("offline skips without a task, warns a human once, and online recovery dispatches normally", () => {
    const schedule = seedSchedule();
    const online = fire(schedule);
    expect(online.status).toBe("delivered");
    db.run("UPDATE tasks SET status = 'replied' WHERE task_id = ?1", [online.taskId]);

    setTarget("offline");
    const before = taskCount();
    const first = fire(schedule), second = fire(schedule);
    expect([first.status, second.status]).toEqual(["skipped", "skipped"]);
    expect(taskCount()).toBe(before);
    for (const run of [first, second]) {
      expect(db.get("SELECT status, error_code, task_id FROM scheduled_task_runs WHERE run_id = ?1", run.runId))
        .toEqual({ status: "skipped", error_code: "target_offline", task_id: null });
    }
    expect(humanNotices(schedule.schedule_id)).toHaveLength(1);
    expect(humanNotices(schedule.schedule_id)[0].content).toContain("恢复在线后");

    setTarget("idle");
    const recovered = fire(schedule);
    expect(recovered.status).toBe("delivered");
    expect(recovered.taskId).toBeTruthy();
    db.run("UPDATE tasks SET status = 'replied' WHERE task_id = ?1", [recovered.taskId]);

    setTarget("offline");
    expect(fire(schedule).status).toBe("skipped");
    expect(humanNotices(schedule.schedule_id)).toHaveLength(2);
  });

  test("an Agent-created schedule warns the creator inbox, never the owner's user inbox", () => {
    const schedule = seedSchedule(CREATOR_ID);
    setTarget("offline");
    expect(fire(schedule).status).toBe("skipped");
    expect(fire(schedule).status).toBe("skipped");
    expect(agentNotices(schedule.schedule_id)).toHaveLength(1);
    expect(agentNotices(schedule.schedule_id)[0].content).toContain("不需要回复");
    expect(humanNotices(schedule.schedule_id)).toHaveLength(0);
  });

  test("an idle session older than the existing five-minute cutoff is offline", () => {
    const schedule = seedSchedule();
    setTarget("idle", 6);
    const before = taskCount();
    const run = fire(schedule);
    expect(run.status).toBe("skipped");
    expect(taskCount()).toBe(before);
    expect(db.get<{ error_code: string }>("SELECT error_code FROM scheduled_task_runs WHERE run_id = ?1", run.runId)?.error_code).toBe("target_offline");
  });

  test("recent SQLite and ISO timestamps all keep an idle target online", () => {
    const now = Date.now();
    const isoMs = new Date(now - 1_000).toISOString();
    const values = [
      isoMs.slice(0, 19).replace("T", " "),
      `${isoMs.slice(0, 19)}Z`,
      isoMs,
    ];
    for (const value of values) {
      db.run("UPDATE sessions SET status = 'idle', last_seen_at = ?1 WHERE node_id = ?2 AND network_id = ?3", [value, TARGET_ID, NET]);
      expect(scheduledTargetOffline(TARGET_ID, TARGET, NET, now)).toBe(false);
    }
  });
});
