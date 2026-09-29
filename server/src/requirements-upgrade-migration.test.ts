// 负责人 / 负责 Agent 拆分的启动迁移:旧库里 owner 是节点的卡,节点挪到 agent_owner、owner 置空。
// 用 #2065 时代的表结构(没有 agent_owner_json 列)先建库、塞行,再 import db.ts + requirements.ts(真实启动路径)。
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

const snapshot = (db: any) => db.all("SELECT requirement_id, network_id, title, due_on, assignee, participants_json, owner_json, agent_owner_json, project_id FROM requirements ORDER BY requirement_id") as any[];

test("startup migration moves node owners to agent_owner, keeps every row, and is idempotent", async () => {
  const { db } = await import("./db.js");
  await import("./requirements.js"); // 真实启动路径:server.ts 载入 requirements.ts 时迁移
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
  // 加列只加不改:旧行的描述 / 子任务是空
  const cols = (db.all("PRAGMA table_info(requirements)") as { name: string }[]).map(c => c.name);
  expect(cols.includes("description") && cols.includes("checklist_json") && cols.includes("agent_owner_json")).toBe(true);
  const extra = db.all("SELECT description, checklist_json FROM requirements") as any[];
  expect(extra.every(r => r.description === null && r.checklist_json === null)).toBe(true);
  // 项目表:建了、是空的(不预置),重复执行不报错;卡片的 project_id 列只加不改
  expect(cols.includes("project_id")).toBe(true);
  // PR B:外部引用 / 归档 / 谁做的 —— 只加不改;旧行 archived = 0、其余 NULL;external_ref 的部分唯一索引建了
  for (const c of ["external_ref", "external_url", "archived", "created_by_json", "updated_by_json"]) expect(cols.includes(c)).toBe(true);
  expect((db.all("SELECT archived, external_ref FROM requirements") as any[]).every(r => r.archived === 0 && r.external_ref === null)).toBe(true);
  const idx = (db.all("PRAGMA index_list(requirements)") as { name: string; unique: number }[]).find(i => i.name === "idx_requirements_external_ref");
  expect(idx?.unique).toBe(1);
  const { ensureRequirementIndexes } = await import("./requirements-migrate.js");
  ensureRequirementIndexes(db);
  expect((db.all("SELECT project_id FROM requirements WHERE project_id IS NOT NULL") as any[]).length).toBe(0);
  expect((db.get("SELECT COUNT(*) AS n FROM requirement_projects") as any).n).toBe(0);
  const { ensureRequirementProjects } = await import("./requirements-migrate.js");
  ensureRequirementProjects(db);
  ensureRequirementProjects(db);
  expect((db.get("SELECT COUNT(*) AS n FROM requirement_projects") as any).n).toBe(0);
  // 再跑一次(= 下次启动):什么都不动
  expect(migrateRequirementAgentOwners(db).moved).toBe(0);
  expect(snapshot(db)).toEqual(after);
});
