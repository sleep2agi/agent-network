// #2571 —— delivered_stale 的**分流**：目标在跑别的任务时不再报“可能离线”。
//
// 生产数据（24h）：出现过 delivered_stale 的任务里 83% 最终成功，等待 p50 2.9 分钟、
// p90 27 分钟 ⇒ 事件事实成立，但把“目标正忙”写成“可能离线”会制造告警疲劳。
// 这里钉住三件事：
//   1. 目标 `working` ⇒ 写 `queued_behind_busy_<N>s`，**不写** `delivered_stale_<N>s`；
//   2. 目标 `idle`/`offline`/无 session ⇒ 写 `delivered_stale_<N>s`，**不写** busy 类；
//   3. 两类都仍然是 write-once（同一 task+阈值重复巡逻不重复写）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { recordDeliveredStaleEvents } from "./task-lifecycle-watcher.js";

const NOW = new Date("2026-08-10T00:01:01.000Z");
let networkId = "";

function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function insertTask(taskId: string, toName: string, deliveredAt: string) {
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, network_id)
     VALUES (?1, 'sender', ?2, 'delivered', 'busy-vs-stale fixture', ?3, ?4)`,
    [taskId, toName, deliveredAt, networkId],
  );
}

function insertSession(alias: string, status: string) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, network_id, registered_at)
     VALUES (?1, ?2, ?3, ?4, '2026-08-10 00:00:00')`,
    [`res_${alias}`, alias, status, networkId],
  );
}

function eventsFor(taskId: string): string[] {
  return db
    .all<{ event_type: string }>(`SELECT event_type FROM task_events WHERE task_id = ?1 ORDER BY event_type`, [taskId])
    .map((row) => row.event_type);
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`busy_watcher_${Date.now()}`, "BusyWatcher-Strong-1!", undefined, "watcher");
  expect(auth.ok).toBe(true);
  networkId = auth.network_id!;

  // 目标在跑别的任务
  insertSession("target-busy", "working");
  insertTask("busy-60", "target-busy", "2026-08-10 00:00:01");
  // 目标空闲却没开始（真异常）
  insertSession("target-idle", "idle");
  insertTask("idle-60", "target-idle", "2026-08-10 00:00:01");
  // 目标掉线
  insertSession("target-offline", "offline");
  insertTask("offline-60", "target-offline", "2026-08-10 00:00:01");
  // 完全没有 session 行（未知）
  insertTask("unknown-60", "target-without-session", "2026-08-10 00:00:01");
}, 30_000);

afterAll(() => {
  try {
    db.run(`DELETE FROM task_events WHERE network_id = ?1`, [networkId]);
    db.run(`DELETE FROM tasks WHERE network_id = ?1`, [networkId]);
    db.run(`DELETE FROM sessions WHERE network_id = ?1`, [networkId]);
  } catch {}
});

describe("#2571 stale vs queued-behind-busy", () => {
  test("目标 working ⇒ 只写 queued_behind_busy_*，不写 delivered_stale_*", () => {
    recordDeliveredStaleEvents(NOW);
    const events = eventsFor("busy-60");
    expect(events).toContain("task.warning.queued_behind_busy_60s");
    expect(events).not.toContain("task.warning.delivered_stale_60s");
  });

  test("目标 idle / offline / 无 session ⇒ 只写 delivered_stale_*", () => {
    recordDeliveredStaleEvents(NOW);
    for (const taskId of ["idle-60", "offline-60", "unknown-60"]) {
      const events = eventsFor(taskId);
      expect(events).toContain("task.warning.delivered_stale_60s");
      expect(events).not.toContain("task.warning.queued_behind_busy_60s");
    }
  });

  test("两类都仍然是 write-once（重复巡逻不重复写）", () => {
    const before = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM task_events WHERE network_id = ?1 AND event_type LIKE 'task.warning.%'`,
      [networkId],
    )!.n;
    const second = recordDeliveredStaleEvents(NOW);
    const after = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM task_events WHERE network_id = ?1 AND event_type LIKE 'task.warning.%'`,
      [networkId],
    )!.n;
    expect(second.inserted).toBe(0);
    expect(after).toBe(before);
  });

  test("detail 文案能区分“排队”和“没在跑”", () => {
    const busy = db.get<{ detail: string }>(
      `SELECT detail FROM task_events WHERE task_id='busy-60' AND event_type LIKE 'task.warning.queued_behind_busy_%'`,
    );
    const stale = db.get<{ detail: string }>(
      `SELECT detail FROM task_events WHERE task_id='idle-60' AND event_type LIKE 'task.warning.delivered_stale_%'`,
    );
    expect(busy!.detail).toContain("queued after");
    expect(stale!.detail).toContain("still delivered");
    // 两类文案必须一眼可分：忙的那条不能说成“没在跑”，反之亦然
    expect(busy!.detail).not.toContain("still delivered");
    expect(stale!.detail).not.toContain("queued after");
  });
});
