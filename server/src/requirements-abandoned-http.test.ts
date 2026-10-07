// 任务状态「废弃」(abandoned)—— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 废弃是关闭态(同 done):不算开着、不逾期、不发到期提醒、不记完成时间;改进 / 改出都记动态;能改回 pool / doing。
// 旧 App(desktop ≤ 0.2.220)把不认识的状态当 pool —— 所以没声明 `X-Anet-Accept-Columns: abandoned`
// (或 `accept_columns=abandoned`)的调用者看到的是 done;MCP 总是声明,看到真值。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-abandoned-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
for (const k of ["COMMHUB_DUE_REMINDER_TZ", "COMMHUB_DUE_OVERDUE_MAX_DAYS", "COMMHUB_DUE_REMINDER_NETWORKS", "COMMHUB_DUE_REMINDERS", "COMMHUB_DUE_REMINDERS_NETWORKS", "COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS", "COMMHUB_DUE_REMINDERS_OWNERS"]) delete process.env[k];
const PW = "AbandonedPassw0rd!x";
const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const DAY = 86_400_000;
const AWARE = { "X-Anet-Accept-Columns": "abandoned" };

let BASE = "";
let hub: any = null;
let NET = "";
let TOKEN = "";
let OWNER = "";
let db: any;
let due: typeof import("./requirement-due-reminders.js");

type R = { status: number; body: any };
async function send(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }, 60_000);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function mcp(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, 60_000);
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}
async function card(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await send("POST", "/api/requirements", { network_id: NET, name, owner: { kind: "user", id: OWNER }, ...extra });
  expect(r.status).toBe(201);
  return r.body.requirement.id as string;
}
const get = (id: string, headers: Record<string, string> = {}) => send("GET", `/api/requirements/${id}?network_id=${NET}`, undefined, headers);
const patch = (id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => send("PATCH", `/api/requirements/${id}?network_id=${NET}`, body, headers);
const list = (qs = "", headers: Record<string, string> = {}) => send("GET", `/api/requirements?network_id=${NET}${qs}`, undefined, headers);
const ids = (r: R) => (r.body.requirements as any[]).map(x => x.id);
const columnIn = (r: R, id: string) => (r.body.requirements as any[]).find(x => x.id === id)?.column;
const sentFor = (out: Array<{ requirement_id: string; kind: string }>, id: string) => out.filter(x => x.requirement_id === id).map(x => x.kind);
const columnEvents = async (id: string) => ((await send("GET", `/api/requirements/events?network_id=${NET}&requirement_id=${id}`)).body.events as any[])
  .filter(e => e.kind === "changed" && e.field === "column").map(e => [e.old, e.new]).reverse();

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const r = register(`ab_owner_${Date.now()}`, PW);
  expect(r.ok).toBe(true);
  TOKEN = r.token!;
  OWNER = r.user!.user_id;
  NET = r.network_id!;
  due = await import("./requirement-due-reminders.js");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  due.runDueReminders({ now: T0 - 30 * DAY }); // 到期提醒基线(同 requirement-due-reminders-http.test.ts)
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("abandoned column", () => {
  test("schema accepts abandoned; the legacy CHECK migration is idempotent (SQLite rebuild / PG constraint swap)", async () => {
    const { migrateRequirementColumnCheck } = await import("./requirements-migrate.js");
    if (db.dialect === "postgres") {
      // 模拟旧 PG 库:换回旧约束,迁移后 abandoned 能写,再跑一次照样不报错。
      db.exec("ALTER TABLE requirements DROP CONSTRAINT IF EXISTS requirements_column_name_check");
      db.exec("ALTER TABLE requirements ADD CONSTRAINT requirements_column_name_check CHECK(column_name IN ('pool', 'doing', 'done'))");
      migrateRequirementColumnCheck(db);
      migrateRequirementColumnCheck(db);
    } else {
      expect(migrateRequirementColumnCheck(db).rebuilt).toBe(false);
    }
    const id = await card("ab-schema");
    expect((await patch(id, { column: "abandoned" }, AWARE)).status).toBe(200);
    expect((await patch(id, { column: "cancelled" }, AWARE)).body.error).toBe("invalid_column");
    expect((await list()).body.capabilities).toContain("column_abandoned");
  }, 60_000);

  test("set and restore: events recorded each way, no completedAt, restorable to pool and doing", async () => {
    const id = await card("ab-set");
    const a = await patch(id, { column: "abandoned" }, AWARE);
    expect(a.status).toBe(200);
    expect(a.body.requirement.column).toBe("abandoned");
    expect(a.body.requirement.completedAt).toBeNull();
    expect((await patch(id, { column: "doing" }, AWARE)).body.requirement.column).toBe("doing");
    expect((await patch(id, { column: "abandoned" }, AWARE)).body.requirement.column).toBe("abandoned");
    expect((await patch(id, { column: "pool" }, AWARE)).body.requirement.column).toBe("pool");
    expect(await columnEvents(id)).toEqual([["pool", "abandoned"], ["abandoned", "doing"], ["doing", "abandoned"], ["abandoned", "pool"]]);
    // 直接建在废弃列(带声明)也行
    const created = await send("POST", "/api/requirements", { network_id: NET, name: "ab-born", column: "abandoned" }, AWARE);
    expect(created.body.requirement.column).toBe("abandoned");
  }, 60_000);

  test("closed like done: not overdue, no due reminder, not counted as open in stats; restoring reopens it", async () => {
    // id:到期提醒用假时钟 T0(10-10),到期 10-07 = 逾期 3 天;old:列表的 overdue 筛选用真时钟,到期给一个早就过了的日子。
    const id = await card("ab-overdue", { due: "2026-10-07", column: "doing" });
    const old = await card("ab-overdue-list", { due: "2020-01-01", column: "doing" });
    expect(ids(await list("&overdue=1"))).toContain(old);
    await patch(id, { column: "abandoned" }, AWARE);
    await patch(old, { column: "abandoned" }, AWARE);
    expect(ids(await list("&overdue=1"))).not.toContain(old);
    expect(ids(await list("&overdue=0"))).toContain(old);
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual([]);
    const stats = (await send("GET", `/api/requirements/stats?network_id=${NET}`)).body.totals;
    const raw = db.all("SELECT column_name FROM requirements WHERE network_id = ?1 AND COALESCE(archived, 0) = 0", NET) as any[];
    const n = (c: string) => raw.filter(r => r.column_name === c).length;
    expect(stats.doing).toBe(n("doing"));
    expect(stats.pool).toBe(n("pool"));
    expect(stats.abandoned).toBe(n("abandoned"));
    expect(n("abandoned")).toBeGreaterThan(0);
    // 子任务进度不把废弃的子任务算进去
    const parent = await card("ab-parent");
    const kid = await card("ab-kid", { parent_id: parent });
    await card("ab-kid2", { parent_id: parent });
    await patch(kid, { column: "abandoned" }, AWARE);
    expect((await get(parent)).body.requirement.children).toEqual({ total: 1, done: 0 });
    // 改回 doing:又逾期、又提醒
    await patch(id, { column: "doing" }, AWARE);
    await patch(old, { column: "doing" }, AWARE);
    expect(ids(await list("&overdue=1"))).toContain(old);
    expect(sentFor(due.runDueReminders({ now: T0 }), id)).toEqual(["overdue"]);
  }, 60_000);

  test("old clients (no declaration) see abandoned as done; their writes cannot un-abandon it by echo", async () => {
    const id = await card("ab-legacy");
    await patch(id, { column: "abandoned" }, AWARE);
    expect((await get(id)).body.requirement.column).toBe("done");
    expect((await get(id, AWARE)).body.requirement.column).toBe("abandoned");
    expect((await send("GET", `/api/requirements/${id}?network_id=${NET}&accept_columns=abandoned`)).body.requirement.column).toBe("abandoned");
    expect(columnIn(await list(), id)).toBe("done");
    expect(columnIn(await list("&view=summary"), id)).toBe("done");
    expect(columnIn(await list("", AWARE), id)).toBe("abandoned");
    // 列表缓存按声明分开:同一个查询串,先旧后新,不串值
    expect(columnIn(await list(), id)).toBe("done");
    expect(columnIn(await list("", AWARE), id)).toBe("abandoned");
    // 旧客户端按 done 筛:带上废弃的(它眼里就是 done)
    expect(ids(await list("&status=done"))).toContain(id);
    expect(ids(await list("&status=done", AWARE))).not.toContain(id);
    expect(ids(await list("&status=abandoned", AWARE))).toContain(id);
    // 旧客户端改别的字段 / 回传它看到的 done:仍是废弃;响应里仍是 done
    const p1 = await patch(id, { priority: "high" });
    expect(p1.body.requirement.column).toBe("done");
    const p2 = await patch(id, { column: "done" });
    expect(p2.body.requirement.column).toBe("done");
    expect((await get(id, AWARE)).body.requirement.column).toBe("abandoned");
    // 旧客户端明确改回 pool:照办
    expect((await patch(id, { column: "pool" })).body.requirement.column).toBe("pool");
    // 新客户端从 abandoned 改成 done:真的完成
    await patch(id, { column: "abandoned" }, AWARE);
    const done = await patch(id, { column: "done" }, AWARE);
    expect(done.body.requirement.column).toBe("done");
    expect(done.body.requirement.completedAt).not.toBeNull();
  }, 60_000);

  test("MCP declares support: requirements_update / get / list carry the real value", async () => {
    const id = await card("ab-mcp");
    const up = await mcp("requirements_update", { id, network_id: NET, status: "abandoned" });
    expect(up.requirement.column).toBe("abandoned");
    expect((await mcp("requirements_get", { id, network_id: NET })).requirement.column).toBe("abandoned");
    const l = await mcp("requirements_list", { network_id: NET, status: "abandoned" });
    expect(l.requirements.map((x: any) => x.id)).toContain(id);
    expect((await mcp("requirements_update", { id, network_id: NET, column: "doing" })).requirement.column).toBe("doing");
  }, 60_000);
});
