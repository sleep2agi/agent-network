// 需求的可选开始字段(start,存 start_on):App 甘特图用。
// 先用「没有 start_on 列」的旧库形状建库、塞行,再走真实启动路径(db.ts + server.ts),看:
// 列被加上、存量行读出来 start = "" 且别的列原样;POST / PATCH / upsert 都能写;只 PATCH due 不动 start 和描述;
// 旧客户端(不带 start)的 PATCH 不清掉已有的 start;坏值 400 invalid_start;capabilities 带 start_date。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-start-"));
const file = join(dir, "hub.db");
process.env.COMMHUB_DB = file;

const legacy = new Database(file);
legacy.exec(`
  CREATE TABLE IF NOT EXISTS requirements (
    requirement_id TEXT PRIMARY KEY,
    network_id     TEXT NOT NULL,
    title          TEXT NOT NULL,
    column_name    TEXT NOT NULL DEFAULT 'pool' CHECK(column_name IN ('pool', 'doing', 'done')),
    priority       TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high', 'normal', 'low', 'lowest')),
    due_on         TEXT,
    assignee       TEXT,
    client_id      TEXT,
    issues_json    TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
legacy.exec("ALTER TABLE requirements ADD COLUMN description TEXT");
legacy.run("INSERT INTO requirements (requirement_id, network_id, title, due_on, description) VALUES ('r_old', 'net_legacy', '旧卡', '2026-10-01', '旧描述')");
expect(legacy.query("SELECT name FROM pragma_table_info('requirements') WHERE name = 'start_on'").all()).toEqual([]);
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
  const owner = register(`start_owner_${Date.now()}`, "StartOwner123!", undefined, "seed");
  token = owner.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("optional requirement start date", () => {
  test("startup adds start_on to an old table; existing rows keep every value and read start = ''", () => {
    const cols = (db.all("PRAGMA table_info(requirements)") as { name: string }[]).map(c => c.name);
    expect(cols).toContain("start_on");
    const row = db.get("SELECT title, due_on, description, start_on FROM requirements WHERE requirement_id = 'r_old'") as any;
    expect(row).toEqual({ title: "旧卡", due_on: "2026-10-01", description: "旧描述", start_on: null });
  });

  test("create / PATCH / upsert write start; due-only PATCH and start-less PATCH keep it", async () => {
    const created = await api("/api/requirements", { method: "POST", body: JSON.stringify({ name: "有开始的", start: "2026-09-20", due: "2026-10-01", description: "别动我" }) });
    expect(created.status).toBe(201);
    expect(created.body.requirement.start).toBe("2026-09-20");
    const id = created.body.requirement.id;

    // 甘特图拖动只发 due:start 和描述原样
    const dueOnly = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ due: "2026-10-05" }) });
    expect(dueOnly.status).toBe(200);
    expect(dueOnly.body.requirement.due).toBe("2026-10-05");
    expect(dueOnly.body.requirement.start).toBe("2026-09-20");
    expect(dueOnly.body.requirement.description).toBe("别动我");

    // 旧客户端不认识 start:它的 PATCH 不带这个字段,不能清掉
    const old = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ name: "改名了" }) });
    expect(old.body.requirement.start).toBe("2026-09-20");

    const instant = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ start: "2026-09-21T09:30:00+08:00" }) });
    expect(instant.body.requirement.start).toBe("2026-09-21T01:30:00Z");
    const cleared = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ start: "" }) });
    expect(cleared.status).toBe(200);
    expect(cleared.body.requirement.start).toBe("");
    // 只带 start 的 PATCH 不是 empty_patch
    const onlyStart = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ start: "2026-09-22" }) });
    expect(onlyStart.status).toBe(200);

    const up = await api("/api/requirements/upsert", { method: "POST", body: JSON.stringify({ name: "同步来的", external_ref: "github:t/p#9", start: "2026-09-01" }) });
    expect(up.status).toBe(201);
    expect(up.body.requirement.start).toBe("2026-09-01");
    const upAgain = await api("/api/requirements/upsert", { method: "POST", body: JSON.stringify({ external_ref: "github:t/p#9", start: "2026-09-02" }) });
    expect(upAgain.body.requirement.start).toBe("2026-09-02");

    const noStart = await api("/api/requirements", { method: "POST", body: JSON.stringify({ name: "没开始字段" }) });
    expect(noStart.body.requirement.start).toBe("");
  });

  test("bad start values are 400 invalid_start and change nothing", async () => {
    const created = await api("/api/requirements", { method: "POST", body: JSON.stringify({ name: "坏值", start: "2026-09-20" }) });
    const id = created.body.requirement.id;
    for (const bad of ["2026-02-30", "tomorrow", "2026-09-20T10:00:00", 20260920]) {
      const post = await api("/api/requirements", { method: "POST", body: JSON.stringify({ name: "x", start: bad }) });
      const patch = await api(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ start: bad }) });
      expect(patch.status).toBe(400);
      expect(patch.body.error).toBe("invalid_start");
      if (typeof bad === "string") {
        expect(post.status).toBe(400);
        expect(post.body.error).toBe("invalid_start");
      }
    }
    const listed = await api("/api/requirements");
    expect(listed.body.requirements.find((r: any) => r.id === id).start).toBe("2026-09-20");
    expect(listed.body.capabilities).toContain("start_date");
    // 旧卡在列表里 start = ""(不是缺字段:新 App 按 capabilities 判断支持与否)
    expect(listed.body.requirements.every((r: any) => typeof r.start === "string")).toBe(true);
  });
});
