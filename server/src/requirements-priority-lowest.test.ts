// P0–P3 优先级:lowest(P3 极低)。生产库的 requirements 表建于旧 db.ts,带 CHECK(priority IN ('high', 'normal', 'low')),
// 光放开校验集合写进去也会被 SQLite 拒掉。这里先用旧建表语句建库、塞行,再走真实启动路径(db.ts + server.ts),
// 看:表重建一次、存量行 / 索引原样、lowest 在 POST / PATCH / upsert 都能写、坏值仍被拒、再启动不再重建。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-priority-"));
const file = join(dir, "hub.db");
process.env.COMMHUB_DB = file;

const legacy = new Database(file);
legacy.exec(`
  CREATE TABLE IF NOT EXISTS requirements (
    requirement_id TEXT PRIMARY KEY,
    network_id     TEXT NOT NULL,
    title          TEXT NOT NULL,
    column_name    TEXT NOT NULL DEFAULT 'pool' CHECK(column_name IN ('pool', 'doing', 'done')),
    priority       TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high', 'normal', 'low')),
    due_on         TEXT,
    assignee       TEXT,
    client_id      TEXT,
    issues_json    TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_requirements_network ON requirements(network_id, created_at DESC);
`);
legacy.exec("ALTER TABLE requirements ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
legacy.exec("ALTER TABLE requirements ADD COLUMN description TEXT");
const seeded = [["r_high", "high"], ["r_normal", "normal"], ["r_low", "low"]] as const;
for (const [id, p] of seeded) {
  legacy.run("INSERT INTO requirements (requirement_id, network_id, title, priority, client_id, description, tags_json) VALUES (?1, 'net_legacy', ?2, ?3, ?4, ?5, '[\"旧\"]')", [id, `卡 ${id}`, p, `c_${id}`, `desc ${id}`]);
}
// 旧库确实拒 lowest:这就是光改 PRIORITIES 不够的原因
expect(() => legacy.run("INSERT INTO requirements (requirement_id, network_id, title, priority) VALUES ('x', 'n', 't', 'lowest')")).toThrow(/CHECK/);
legacy.close();

let base = "";
let token = "";
let server: { port: number; stop?: (force?: boolean) => void };
let db: any;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const owner = register(`prio_owner_${Date.now()}`, "PriorityOwner123!", undefined, "seed");
  token = owner.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("P3 lowest priority", () => {
  test("startup rebuilds the legacy CHECK once and keeps every row and index", async () => {
    const sql = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'requirements'").sql as string;
    expect(sql).toContain("'lowest'");
    expect(sql).toContain("CHECK(column_name IN ('pool', 'doing', 'done', 'abandoned'))");
    const rows = db.all("SELECT requirement_id, network_id, title, priority, client_id, description, tags_json FROM requirements WHERE network_id = 'net_legacy' ORDER BY requirement_id") as any[];
    expect(rows.map(r => [r.requirement_id, r.priority])).toEqual([["r_high", "high"], ["r_low", "low"], ["r_normal", "normal"]]);
    for (const r of rows) {
      expect(r.title).toBe(`卡 ${r.requirement_id}`);
      expect(r.client_id).toBe(`c_${r.requirement_id}`);
      expect(r.description).toBe(`desc ${r.requirement_id}`);
      expect(r.tags_json).toBe('["旧"]');
    }
    const indexes = (db.all("PRAGMA index_list(requirements)") as { name: string; unique: number }[]).map(i => i.name);
    for (const name of ["idx_requirements_network", "idx_requirements_client", "idx_requirements_external_ref", "idx_requirements_network_updated", "idx_requirements_parent"]) expect(indexes).toContain(name);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'requirements_migrated'")).toBeNull();
    // 坏值仍被数据库拒
    expect(() => db.run("INSERT INTO requirements (requirement_id, network_id, title, priority) VALUES ('bad', 'n', 't', 'urgent')")).toThrow(/CHECK/);
    // 下次启动:已经放开,不再重建
    const { migrateRequirementPriorityCheck } = await import("./requirements-migrate.js");
    expect(migrateRequirementPriorityCheck(db).rebuilt).toBe(false);
  });

  test("lowest is accepted on create, PATCH and upsert; unknown values stay 400", async () => {
    const created = await api("/api/requirements", { method: "POST", body: JSON.stringify({ name: "极低的活", priority: "lowest" }) });
    expect(created.status).toBe(201);
    expect(created.body.requirement.priority).toBe("lowest");
    const id = created.body.requirement.id;
    const patched = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ priority: "low" }) });
    expect(patched.body.requirement.priority).toBe("low");
    const back = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ priority: "lowest" }) });
    expect(back.status).toBe(200);
    expect(back.body.requirement.priority).toBe("lowest");
    const up = await api("/api/requirements/upsert", { method: "POST", body: JSON.stringify({ name: "同步来的", external_ref: "github:t/p#1", priority: "lowest" }) });
    expect(up.status).toBe(201);
    expect(up.body.requirement.priority).toBe("lowest");
    const upAgain = await api("/api/requirements/upsert", { method: "POST", body: JSON.stringify({ external_ref: "github:t/p#1", priority: "high" }) });
    expect(upAgain.body.requirement.priority).toBe("high");
    for (const [path, method] of [["/api/requirements", "POST"], [`/api/requirements/${id}`, "PATCH"]] as const) {
      const bad = await api(path, { method, body: JSON.stringify({ name: "x", priority: "urgent" }) });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_priority");
    }
    const listed = await api("/api/requirements");
    expect(listed.body.capabilities).toContain("priority_lowest");
    expect(listed.body.requirements.find((r: any) => r.id === id).priority).toBe("lowest");
  });
});
