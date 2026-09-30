// 完成时间的启动迁移(requirements-migrate.ts ensureRequirementCompletedAt):用加完成时间之前的表结构建库、塞行,
// 再 import db.ts + requirements.ts(真实启动路径)。覆盖:两种旧时间形状、没有 updated_at 的行、
// 回滚到旧 Hub 期间「移出完成」留下的残值被清掉、「移进完成」的卡被补上,以及重复执行不再改任何东西。
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-completed-at-"));
const file = join(dir, "hub.db");
process.env.COMMHUB_DB = file;

const legacy = new Database(file);
legacy.exec(`CREATE TABLE requirements (
  requirement_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, title TEXT NOT NULL,
  column_name TEXT NOT NULL DEFAULT 'pool' CHECK(column_name IN ('pool', 'doing', 'done')), priority TEXT NOT NULL DEFAULT 'normal', due_on TEXT, assignee TEXT,
  client_id TEXT, issues_json TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_json TEXT, participants_json TEXT NOT NULL DEFAULT '[]', updated_by_json TEXT)`);
const seed: [string, string, string, string][] = [
  // id, column, created_at, updated_at
  ["r_done_sqlite_ts", "done", "2026-08-01 08:00:00", "2026-09-01 10:00:00"],
  ["r_done_iso", "done", "2026-08-02T00:00:00.000Z", "2026-09-02T03:04:05.678Z"],
  ["r_done_bad_updated", "done", "2026-08-03T00:00:00.000Z", "not a time"],
  ["r_doing", "doing", "2026-08-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
  ["r_pool", "pool", "2026-08-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z"],
];
for (const [id, column, createdAt, updatedAt] of seed) {
  legacy.run("INSERT INTO requirements (requirement_id, network_id, title, column_name, created_at, updated_at, updated_by_json) VALUES (?1, 'net', ?1, ?2, ?3, ?4, ?5)",
    [id, column, createdAt, updatedAt, JSON.stringify({ kind: "user", id: "u_last_editor" })]);
}
legacy.close();

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const read = (db: any) => Object.fromEntries((db.all("SELECT requirement_id, column_name, updated_at, completed_at, completed_by_json, completed_at_approx FROM requirements") as any[]).map(r => [r.requirement_id, r]));

test("backfill: done rows get an approximate ISO completed_at from updated_at; others stay empty; idempotent", async () => {
  const { db } = await import("./db.js");
  await import("./requirements.js");
  const { ensureRequirementCompletedAt } = await import("./requirements-migrate.js");
  const by = read(db);
  expect(by.r_done_sqlite_ts.completed_at).toBe("2026-09-01T10:00:00.000Z");
  expect(by.r_done_iso.completed_at).toBe("2026-09-02T03:04:05.678Z");
  // updated_at 读不懂 → 退到 created_at,而不是留空(留空的完成卡在仪表盘上就「没完成过」)
  expect(by.r_done_bad_updated.completed_at).toBe("2026-08-03T00:00:00.000Z");
  for (const id of ["r_done_sqlite_ts", "r_done_iso", "r_done_bad_updated"]) {
    expect(by[id].completed_at_approx).toBe(1);
    // 最后改的人不是「完成的人」:近似值不猜完成者
    expect(by[id].completed_by_json).toBeNull();
    // 补值不碰 updated_at
    expect(by[id].updated_at).toBe(seed.find(s => s[0] === id)![3]);
  }
  for (const id of ["r_doing", "r_pool"]) expect([by[id].completed_at, by[id].completed_by_json, by[id].completed_at_approx]).toEqual([null, null, 0]);

  // 下次启动:什么都不动
  expect(ensureRequirementCompletedAt(db)).toEqual({ backfilled: 0, cleared: 0 });
  expect(read(db)).toEqual(by);

  // 回滚到旧 Hub 期间:旧 Hub 不认识这三列 —— 把一张完成的卡移出(列留着旧值)、把一张卡移进完成(列是空的)。
  db.run("UPDATE requirements SET column_name = 'doing' WHERE requirement_id = 'r_done_iso'");
  db.run("UPDATE requirements SET column_name = 'done', updated_at = '2026-09-06T00:00:00.000Z' WHERE requirement_id = 'r_pool'");
  expect(ensureRequirementCompletedAt(db)).toEqual({ backfilled: 1, cleared: 1 });
  const after = read(db);
  expect([after.r_done_iso.completed_at, after.r_done_iso.completed_by_json, after.r_done_iso.completed_at_approx]).toEqual([null, null, 0]);
  expect([after.r_pool.completed_at, after.r_pool.completed_at_approx]).toEqual(["2026-09-06T00:00:00.000Z", 1]);
  expect(after.r_done_sqlite_ts).toEqual(by.r_done_sqlite_ts);
  expect(ensureRequirementCompletedAt(db)).toEqual({ backfilled: 0, cleared: 0 });
});
