// 负责人 / 负责 Agent 拆分的启动迁移:旧库里 owner 是节点的卡,节点挪到 agent_owner、owner 置空。
// 用 #2065 时代的表结构(没有 agent_owner_json 列)先建库、塞行,再 import db.ts 触发真实启动路径。
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-agent-owner-"));
const file = join(dir, "hub.db");
process.env.COMMHUB_DB = file;

const legacy = new Database(file);
legacy.exec(`CREATE TABLE requirements (
  requirement_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, title TEXT NOT NULL,
  column_name TEXT NOT NULL DEFAULT 'pool', priority TEXT NOT NULL DEFAULT 'normal', due_on TEXT, assignee TEXT,
  client_id TEXT, issues_json TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_json TEXT, participants_json TEXT NOT NULL DEFAULT '[]')`);
const rows: [string, string | null, string][] = [
  ["r_node_owner", JSON.stringify({ kind: "node", id: "node_x" }), JSON.stringify([{ kind: "user", id: "u1" }])],
  ["r_user_owner", JSON.stringify({ kind: "user", id: "u1" }), "[]"],
  ["r_no_owner", null, "[]"],
  ["r_bad_json", "{not json", "[]"],
  ["r_node_no_id", JSON.stringify({ kind: "node" }), "[]"],
  ["r_node_owner_2", JSON.stringify({ kind: "node", id: "node_y" }), "[]"],
];
for (const [id, owner, participants] of rows) {
  legacy.run("INSERT INTO requirements (requirement_id, network_id, title, due_on, assignee, owner_json, participants_json) VALUES (?1, 'net', ?2, '2026-10-01', 'legacy', ?3, ?4)", [id, `卡 ${id}`, owner, participants]);
}
legacy.close();

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const snapshot = (db: any) => db.all("SELECT requirement_id, network_id, title, due_on, assignee, participants_json, owner_json, agent_owner_json FROM requirements ORDER BY requirement_id") as any[];

test("startup migration moves node owners to agent_owner, keeps every row, and is idempotent", async () => {
  const { db } = await import("./db.js");
  const { migrateRequirementAgentOwners } = await import("./requirements-migrate.js");
  const after = snapshot(db);
  expect(after.length).toBe(rows.length);
  const by = Object.fromEntries(after.map(r => [r.requirement_id, r]));
  expect(by.r_node_owner.owner_json).toBeNull();
  expect(JSON.parse(by.r_node_owner.agent_owner_json)).toEqual({ kind: "node", id: "node_x" });
  expect(by.r_node_owner.participants_json).toBe(JSON.stringify([{ kind: "user", id: "u1" }]));
  expect(JSON.parse(by.r_node_owner_2.agent_owner_json)).toEqual({ kind: "node", id: "node_y" });
  expect(JSON.parse(by.r_user_owner.owner_json)).toEqual({ kind: "user", id: "u1" });
  expect(by.r_user_owner.agent_owner_json).toBeNull();
  expect(by.r_no_owner.owner_json).toBeNull();
  // 读不懂的旧值原样留着,不猜、不删
  expect(by.r_bad_json.owner_json).toBe("{not json");
  expect(by.r_node_no_id.owner_json).toBe(JSON.stringify({ kind: "node" }));
  for (const r of after) {
    expect(r.title).toBe(`卡 ${r.requirement_id}`);
    expect(r.network_id).toBe("net");
    expect(r.due_on).toBe("2026-10-01");
    expect(r.assignee).toBe("legacy");
  }
  // 再跑一次(= 下次启动):什么都不动
  expect(migrateRequirementAgentOwners(db).moved).toBe(0);
  expect(snapshot(db)).toEqual(after);
});
