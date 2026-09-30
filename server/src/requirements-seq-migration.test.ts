// 任务短号 seq 的启动迁移:用没有 seq 列的旧表建库、塞行,再走真实启动路径(import db.ts + requirements.ts)。
// 补号按网络各自从 1 开始,按 created_at(新旧两种时间格式混在一起)排,同一时刻按 requirement_id。
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-seq-migrate-"));
const file = join(dir, "hub.db");
process.env.COMMHUB_DB = file;

const legacy = new Database(file);
legacy.exec(`CREATE TABLE requirements (
  requirement_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, title TEXT NOT NULL,
  column_name TEXT NOT NULL DEFAULT 'pool', priority TEXT NOT NULL DEFAULT 'normal', due_on TEXT, assignee TEXT,
  client_id TEXT, issues_json TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_json TEXT, participants_json TEXT NOT NULL DEFAULT '[]')`);
// 插入顺序故意打乱;期望的号写在第三列。
const rows: [string, string, string, number][] = [
  ["req_c", "net_a", "2026-09-02T00:00:00.000Z", 5],
  ["req_a", "net_a", "2026-09-01 08:00:00", 1],        // 旧默认格式(UTC,空格分隔)
  ["req_z", "net_b", "2026-08-01T00:00:00.000Z", 1],
  ["req_b2", "net_a", "2026-09-01T09:00:00.000Z", 3],  // 与 req_b1 同一时刻 → 按 id
  ["req_b1", "net_a", "2026-09-01T09:00:00.000Z", 2],
  ["req_y", "net_b", "2026-08-02 00:00:00", 2],
  ["req_d", "net_a", "2026-09-01 23:59:59", 4],        // 旧格式,晚于 09:00 的 ISO、早于 09-02
];
for (const [id, net, at] of rows) legacy.run("INSERT INTO requirements (requirement_id, network_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)", [id, net, `卡 ${id}`, at]);
legacy.close();

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("startup backfills seq per network in created_at order, then id; counters and unique index follow", async () => {
  const { db } = await import("./db.js");
  await import("./requirements.js"); // 真实启动路径
  const got = Object.fromEntries((db.all("SELECT requirement_id, network_id, seq FROM requirements") as any[]).map(r => [r.requirement_id, r.seq]));
  // net_a 按时间:req_a 09-01 08:00 → req_b1 / req_b2 09-01 09:00(按 id)→ req_d 09-01 23:59:59 → req_c 09-02
  expect(got).toEqual({ req_a: 1, req_b1: 2, req_b2: 3, req_d: 4, req_c: 5, req_z: 1, req_y: 2 });
  // 按字符串排会把「2026-09-01 23:59:59」排到所有 ISO 的 09-01 前面 —— 证明排序真的按时刻,不按字面
  expect("2026-09-01 23:59:59" < "2026-09-01T09:00:00.000Z").toBe(true);
  const counters = Object.fromEntries((db.all("SELECT network_id, last_seq FROM requirement_seq_counters") as any[]).map(r => [r.network_id, r.last_seq]));
  expect(counters).toEqual({ net_a: 5, net_b: 2 });
  const idx = (db.all("PRAGMA index_list(requirements)") as { name: string; unique: number }[]).find(i => i.name === "idx_requirements_network_seq");
  expect(idx?.unique).toBe(1);
  expect(() => db.run("UPDATE requirements SET seq = 1 WHERE requirement_id = 'req_c'")).toThrow();

  // 重复执行:已有号的行一个不动;回滚到旧 Hub 期间建的卡(seq 为空)接在后面补号
  const { ensureRequirementSeq, nextRequirementSeq } = await import("./requirements-migrate.js");
  expect(ensureRequirementSeq(db).backfilled).toBe(0);
  db.run("INSERT INTO requirements (requirement_id, network_id, title, created_at, updated_at) VALUES ('req_old_hub', 'net_a', 'x', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')");
  expect(ensureRequirementSeq(db).backfilled).toBe(1);
  expect((db.get("SELECT seq FROM requirements WHERE requirement_id = 'req_old_hub'") as any).seq).toBe(6);
  expect(got.req_a).toBe((db.get("SELECT seq FROM requirements WHERE requirement_id = 'req_a'") as any).seq);
  // 删掉最大号的卡,下一个号也不回收
  db.run("DELETE FROM requirements WHERE requirement_id = 'req_old_hub'");
  ensureRequirementSeq(db);
  expect(nextRequirementSeq(db, "net_a")).toBe(7);
  // 从没建过卡的网络从 1 开始
  expect(nextRequirementSeq(db, "net_new")).toBe(1);
  expect(nextRequirementSeq(db, "net_new")).toBe(2);
});
