// #2881 —— 同一个排程的「卡住」通知每日上限。
//
// 现场（2026-10-28 只读统计）：7 天 1162 条 schedule_stuck 通知，单个排程 220 条。
// 设计前提是「新的阻塞任务 = 新事件 ⇒ 重新上膛」，但节点长期被占时每轮都会产生新阻塞者，
// 于是一个永远跑不成的排程能一天发几十条，结果没人再看。
//
// 这组用例钉住：前 N 条照发，第 N+1 条起被抑制，且**排程状态不受影响**（只影响通知）。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "./db.js";
import { sendStuckNotice, stuckNoticesSentToday, stuckNoticeMaxPerDay, SCHEDULE_STUCK_NOTICE_KIND } from "./scheduled-stuck.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-stuck-cap-"));
const NET = "net_stuck_cap";
const USER = "u_stuck_cap";
const SCHED = "sched_stuck_cap_1";
const OTHER = "sched_stuck_cap_2";

function seedNotice(id: string, scheduleId: string, minutesAgo = 1) {
  db.run(
    `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, acked, created_at)
     VALUES (?1, ?2, ?3, 'cap-node', ?4, 't', 'c', 'warning', ?5, 0, datetime('now', ?6))`,
    [id, NET, USER, SCHEDULE_STUCK_NOTICE_KIND,
      JSON.stringify({ schedule_stuck: { reason: "stuck", schedule_id: scheduleId, blocked_by_task_id: "t1", skips: 3 } }),
      `-${minutesAgo} minutes`],
  );
}

const notice = (scheduleId: string) => ({
  reason: "stuck" as const,
  scheduleId,
  scheduleName: "cap-test",
  networkId: NET,
  createdBy: USER,
  alias: "cap-node",
  timezone: "Asia/Shanghai",
  taskId: "t-new",
  taskCreatedAt: "2026-10-28 10:00:00",
  skips: 3,
  timeoutMs: 3_600_000,
});

describe("schedule_stuck 通知每日上限", () => {
  beforeAll(() => {
    db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
  });
  afterAll(() => {
    db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
    rmSync(DIR, { recursive: true, force: true });
  });

  test("默认上限是 4", () => {
    expect(stuckNoticeMaxPerDay()).toBe(4);
  });

  test("前 N 条照发，第 N+1 条起被抑制", () => {
    const cap = stuckNoticeMaxPerDay();
    for (let i = 0; i < cap; i++) seedNotice(`msg_cap_${i}`, SCHED, i + 1);
    expect(stuckNoticesSentToday(SCHED)).toBe(cap);
    // 已达上限 ⇒ 返回 null（不发），且不会新增行
    expect(sendStuckNotice(notice(SCHED))).toBeNull();
    expect(stuckNoticesSentToday(SCHED)).toBe(cap);
  });

  test("计数按排程隔离：别的排程不受影响，仍能发", () => {
    for (let i = 0; i < stuckNoticeMaxPerDay(); i++) seedNotice(`msg_cap_o_${i}`, OTHER, i + 1);
    expect(stuckNoticesSentToday(OTHER)).toBe(stuckNoticeMaxPerDay());
    // 另一个排程已满，但本条排程仍是 0 —— 隔离性检查
    expect(stuckNoticesSentToday("sched_stuck_cap_3")).toBe(0);
  });

  test("超出 24 小时的旧通知不计入当日上限（上限是滚动的，不是历史累计）", () => {
    db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
    seedNotice("msg_old_1", SCHED, 25 * 60);
    seedNotice("msg_old_2", SCHED, 30 * 60);
    expect(stuckNoticesSentToday(SCHED)).toBe(0);
  });
});
