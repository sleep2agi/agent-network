// #2880 —— 空转排程：默认只记录，开启开关才真暂停。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { db } from "./db.js";
import { isStarved, scanStarvedSchedules, autopauseEnabled } from "./schedule-starved.js";

const NET = "net_starved";
const USER = "u_starved";

function mkSchedule(id: string, name: string): void {
  db.run(
    `INSERT INTO scheduled_tasks (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority, schedule_type, schedule_json, timezone, overlap_policy, status, next_run_at)
     VALUES (?1, ?2, ?3, ?4, 'busy-node', 'busy-node', 'x', 'normal', 'interval', '{"type":"interval","every_seconds":180}', 'Asia/Shanghai', 'skip', 'active', datetime('now'))`,
    [id, NET, USER, name],
  );
}

function mkRuns(scheduleId: string, total: number, replied: number): void {
  for (let i = 0; i < total; i++) {
    const status = i < replied ? "replied" : "skipped";
    db.run(
      // scheduled_for 上有 UNIQUE(schedule_id, scheduled_for)：每行错开一分钟
      `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, status, error_code, created_at)
       VALUES (?1, ?2, ?3, datetime('now', ?5), ?4, 'previous_run_active', datetime('now'))`,
      [`run_${scheduleId}_${i}`, scheduleId, NET, status, `-${i} minutes`],
    );
  }
}

describe("空转排程判定与自动暂停", () => {
  beforeAll(() => {
    db.run("DELETE FROM scheduled_task_runs WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM scheduled_tasks WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
  });
  afterAll(() => {
    db.run("DELETE FROM scheduled_task_runs WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM scheduled_tasks WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
    delete process.env.COMMHUB_SCHEDULE_STARVED_AUTOPAUSE;
  });

  test("纯判定：次数够且 0 成功才算空转", () => {
    expect(isStarved({ total: 20, replied: 0 }, 20)).toBe(true);
    expect(isStarved({ total: 19, replied: 0 }, 20)).toBe(false); // 次数不够：一天一次的排程不会误伤
    expect(isStarved({ total: 129, replied: 1 }, 20)).toBe(false); // 只要成功过一次就不算
  });

  test("默认关闭：只报候选，不改排程状态", () => {
    delete process.env.COMMHUB_SCHEDULE_STARVED_AUTOPAUSE;
    mkSchedule("sched_starved_a", "空转A");
    mkRuns("sched_starved_a", 25, 0);
    expect(autopauseEnabled()).toBe(false);
    const r = scanStarvedSchedules();
    expect(r.enabled).toBe(false);
    expect(r.paused).toEqual([]);
    expect(r.candidates).toContain("sched_starved_a");
    const st = db.get<{ status: string }>("SELECT status FROM scheduled_tasks WHERE schedule_id = 'sched_starved_a'");
    expect(st?.status).toBe("active"); // 没有被动过
  });

  test("开启开关后才暂停，并且只停空转的那个", () => {
    process.env.COMMHUB_SCHEDULE_STARVED_AUTOPAUSE = "1";
    mkSchedule("sched_starved_b", "空转B");
    mkRuns("sched_starved_b", 30, 0);
    mkSchedule("sched_healthy_b", "健康B");
    mkRuns("sched_healthy_b", 30, 12);
    const r = scanStarvedSchedules();
    expect(r.enabled).toBe(true);
    expect(r.paused).toContain("sched_starved_b");
    expect(r.paused).not.toContain("sched_healthy_b");
    expect(db.get<{ status: string }>("SELECT status FROM scheduled_tasks WHERE schedule_id = 'sched_starved_b'")?.status).toBe("paused");
    expect(db.get<{ status: string }>("SELECT status FROM scheduled_tasks WHERE schedule_id = 'sched_healthy_b'")?.status).toBe("active");
  });

  test("已暂停的不会再被处理（重复扫描无副作用）", () => {
    process.env.COMMHUB_SCHEDULE_STARVED_AUTOPAUSE = "1";
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id = ?1", [NET])?.n ?? 0;
    const r = scanStarvedSchedules();
    expect(r.paused).not.toContain("sched_starved_b");
    const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id = ?1", [NET])?.n ?? 0;
    expect(after).toBe(before); // 不会补发第二条通知
  });
});
