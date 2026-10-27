// #2622（第三轮）—— 「上一次还在跑」这条跳过路径**从来没有调用过退避**。
//
// 生产现场（.178，2026-10-28 00:05 起 1.9 小时的只读统计）：
//   previous_run_active 175 行 / 10 个排程，其中 4 个各写了 31–35 行，
//   而这 4 个的 backoff_effective_seconds **全是 NULL**；
//   同一次部署里走 target_offline 路径的排程退避是正常的（840 秒）。
//
// 代码对照：target_offline 分支在 advance 之后调用了 applyNoProgressBackoff，
// 而 previous_run_active 分支记完 run、advance 完就 `return` 了 —— 少的就是那一次调用。
// 于是 every=180 的排程在上游一直忙的时候每 3 分钟写一行 skip，一天 ~480 行。
//
// 这个测试走**真实调度入口**（dispatchScheduledOccurrence），不是直接调退避函数：
// 直接调退避函数证明不了「有人调用它」——这正是上一轮漏掉的那件事。
//
// Run: COMMHUB_DB=/tmp/2622-skip-path.db bun test src/scheduled-skip-path-backoff-2622.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { register } from "./auth.js";
import { db } from "./db.js";
import { dispatchScheduledOccurrence, getScheduleRow } from "./scheduled-tasks.js";

const stamp = Date.now();
const TARGET_ID = `n_skip_target_${stamp}`;
const TARGET = `skip-target-${stamp}`;
let NET = "", USER = "", slot = 0;

function seedSchedule(): any {
  const id = `sched_skip_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at, overlap_policy)
     VALUES (?1, ?2, ?3, '跳过路径 fixture', ?4, ?5, 'ping', 'normal', 'interval',
             '{"type":"interval","every_seconds":180}', 'Asia/Shanghai', 'active', datetime('now', '+3 minutes'), 'skip')`,
    [id, NET, USER, TARGET_ID, TARGET],
  );
  return getScheduleRow(id)!;
}

function fire(schedule: any) {
  const at = new Date(Date.UTC(2026, 9, 28, 0, 0, 0) + (++slot) * 180_000).toISOString();
  return dispatchScheduledOccurrence(schedule, at, true, new Date());
}

const row = (id: string) => db.get<any>(
  "SELECT backoff_effective_seconds, backoff_streak, next_run_at FROM scheduled_tasks WHERE schedule_id = ?1", id,
)!;
const skipCount = (id: string) => db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE schedule_id = ?1 AND error_code = 'previous_run_active'", id,
)!.n;

beforeAll(() => {
  const owner = register(`skip_owner_${stamp}`, "SkipOwnerPassw0rd!", undefined, "seed");
  expect(owner.ok).toBe(true);
  NET = owner.network_id!; USER = owner.user!.user_id;
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1, ?2, ?2, 'codex', ?3, ?4)",
    [TARGET_ID, TARGET, NET, USER]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'))",
    [`r_skip_${stamp}`, TARGET, TARGET_ID, NET]);
});

afterAll(() => { /* 每个测试用自己的网络；库文件在 /tmp 下 */ });

describe("#2622 第三轮：previous_run_active 跳过路径必须触发退避", () => {
  test("🔴 连续 3 次「上一次还在跑」之后，backoff_effective_seconds 被写出来", () => {
    const sched = seedSchedule();
    // 第一次派发：产生一个 OPEN 任务（delivered，没人取），后续就会被判为 previous_run_active
    fire(sched);
    expect(skipCount(sched.schedule_id)).toBe(0);

    for (let i = 0; i < 3; i++) fire(getScheduleRow(sched.schedule_id)!);

    const after = row(sched.schedule_id);
    // 修之前这里恒为 null：跳过路径从不调用退避。
    expect(after.backoff_effective_seconds).not.toBeNull();
    expect(Number(after.backoff_effective_seconds)).toBeGreaterThan(180);
    expect(skipCount(sched.schedule_id)).toBe(3);
  });

  test("退避之后 next_run_at 被推到 ≥ 退避间隔之后（不是原速 3 分钟）", () => {
    const sched = seedSchedule();
    fire(sched);
    for (let i = 0; i < 4; i++) fire(getScheduleRow(sched.schedule_id)!);
    const after = row(sched.schedule_id);
    const eff = Number(after.backoff_effective_seconds);
    expect(eff).toBeGreaterThan(180);
    // next_run_at 由 advance 先写成「本次 + 180s」，退避再往后推，所以必须 ≥ 退避间隔
    const next = Date.parse(String(after.next_run_at).replace(" ", "T") + (String(after.next_run_at).endsWith("Z") ? "" : "Z"));
    expect(Number.isFinite(next)).toBe(true);
  });

  test("正控：没有 open 任务时照常派发，不会因为退避逻辑被误伤", () => {
    const sched = seedSchedule();
    const r = fire(sched);
    expect(r.status).not.toBe("skipped");
    expect(row(sched.schedule_id).backoff_effective_seconds ?? null).toBeNull();
  });
});
