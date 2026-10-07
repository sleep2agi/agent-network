// GET /api/requirements 省流(2026-09-30,App「连接较慢 · 数据可能稍有延迟」)—— HTTP 集成测试(真实 Bun.serve,临时库)。
//   view=summary      —— 不带 description / checklist,换成 has_description / checklist_count;不带 view = 与原来逐字相同。
//   changes=1         —— updated_since 之后改过的卡(含归档的)+ deleted 墓碑 + server_time;受限成员只收到他看得见的卡的删除。
//   列表缓存          —— 表没变时复用上一次的正文 / ETag;任何写入(REST、MCP、项目删除)之后都不会拿旧的。
//   /api/stats/routes —— 每个路由的耗时汇总,只给管理员。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const DIR = mkdtempSync(join(tmpdir(), "anet-requirements-slim-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "SlimListPassw0rd!x";
let BASE = "";
let hub: any = null;
let NET = "";
let admin = { token: "", id: "" };
let member = { token: "", id: "" };
let scoped = { token: "", id: "" };
let cache: { size: () => number; clear: () => void; generation: () => number };
let gzipStats: { hits: number; misses: number };

type R = { status: number; body: any; text: string; headers: Headers };
async function send(token: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text, headers: res.headers };
}
const list = (t: string, qs = "", headers: Record<string, string> = {}) => send(t, "GET", `/api/requirements?network_id=${NET}${qs}`, undefined, headers);
const create = async (t: string, card: Record<string, unknown>) => {
  const r = await send(t, "POST", "/api/requirements", { network_id: NET, ...card });
  expect(r.status).toBe(201);
  return r.body.requirement as { id: string; updatedAt: string };
};
const patch = (t: string, id: string, p: Record<string, unknown>) => send(t, "PATCH", `/api/requirements/${id}?network_id=${NET}`, p);
const del = (t: string, id: string) => send(t, "DELETE", `/api/requirements/${id}?network_id=${NET}`);
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}
const tick = () => new Promise(r => setTimeout(r, 5));

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register } = await import("./auth.js");
  const { db } = await import("./db.js");
  const a = register(`slim_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const mk = async (username: string) => {
    const r = await send(admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  member = await mk(`slim_member_${stamp}`);
  scoped = await mk(`slim_scoped_${stamp}`);
  // member:看全部任务、全部 Agent(可缓存);scoped:只看相关任务(不缓存,且只收到看得见的卡的删除)。
  db.run("UPDATE network_members SET task_access = 'all', agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
  db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, scoped.id]);
  cache = (await import("./requirements.js")).__requirementsListCacheForTest();
  gzipStats = (await import("./http-gzip.js")).gzipCacheStats;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("view=summary", () => {
  test("drops description and checklist bodies, keeps everything else, adds has_description / checklist_count", async () => {
    const card = await create(admin.token, {
      name: "slim-summary",
      description: "一段很长的描述 ".repeat(200),
      checklist: [{ text: "第一项", done: true }, { text: "第二项", done: false }, { text: "第三项", done: true }],
    });
    await create(admin.token, { name: "slim-empty" });
    const full = await list(admin.token);
    const summary = await list(admin.token, "&view=summary");
    expect(full.status).toBe(200);
    expect(summary.status).toBe(200);
    expect(summary.body.view).toBe("summary");
    expect(full.body.view).toBeUndefined();
    expect(summary.body.capabilities).toContain("list_summary");
    expect(summary.body.capabilities).toContain("changes");
    const f = full.body.requirements.find((r: any) => r.id === card.id);
    const s = summary.body.requirements.find((r: any) => r.id === card.id);
    expect(f.description.length).toBeGreaterThan(1000);
    expect(f.checklist).toHaveLength(3);
    expect("description" in s).toBe(false);
    expect("checklist" in s).toBe(false);
    expect(s.has_description).toBe(true);
    expect(s.checklist_count).toEqual({ total: 3, done: 2 });
    const { description: _d, checklist: _c, ...rest } = f;
    const { has_description: _h, checklist_count: _cc, ...sRest } = s;
    expect(sRest).toEqual(rest);
    const empty = summary.body.requirements.find((r: any) => r.name === "slim-empty");
    expect(empty.has_description).toBe(false);
    expect(empty.checklist_count).toEqual({ total: 0, done: 0 });
    // 同样的卡、同样的顺序;全文在单卡接口上照旧拿得到
    expect(summary.body.requirements.map((r: any) => r.id)).toEqual(full.body.requirements.map((r: any) => r.id));
    const one = await send(admin.token, "GET", `/api/requirements/${card.id}?network_id=${NET}`);
    expect(one.body.requirement.description).toBe(f.description);
    // 比的是 summary 省掉的那部分(正文 / 子任务):两边一样多的 last_event(#506,每行约 150 B)不算,
    // 否则这张只有几行的小表上,固定开销会把比例拉过一半。capabilities 同理:两边一样、每加一个能力就长一截。
    const bare = (body: any) => JSON.stringify({ ...body, capabilities: [], requirements: body.requirements.map(({ last_event: _l, ...r }: any) => r) }).length;
    expect(summary.body.requirements.every((r: any) => "last_event" in r)).toBe(true);
    expect(bare(summary.body)).toBeLessThan(bare(full.body) / 2);
  });

  test("view=full is the plain list; an unknown view is a 400", async () => {
    const plain = await list(admin.token);
    const explicit = await list(admin.token, "&view=full");
    expect(explicit.body.requirements).toEqual(plain.body.requirements);
    expect((await list(admin.token, "&view=tiny")).status).toBe(400);
    expect((await list(admin.token, "&view=tiny")).body.error).toBe("invalid_view");
  });
});

describe("changes=1", () => {
  test("requires updated_since", async () => {
    const r = await list(admin.token, "&changes=1");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("updated_since_required");
  });

  test("returns only cards changed since, archived ones included, plus deleted ids and a server_time to continue from", async () => {
    const keep = await create(admin.token, { name: "slim-keep" });
    const edit = await create(admin.token, { name: "slim-edit" });
    const arch = await create(admin.token, { name: "slim-arch" });
    const gone = await create(admin.token, { name: "slim-gone" });
    const first = await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    expect(first.status).toBe(200);
    const t0 = first.body.server_time as string;
    expect(Date.parse(t0)).toBeGreaterThan(0);
    expect(first.body.deleted).toEqual([]);
    await tick();

    expect((await patch(admin.token, edit.id, { name: "slim-edit-2" })).status).toBe(200);
    expect((await patch(admin.token, arch.id, { archived: true })).status).toBe(200);
    expect((await del(admin.token, gone.id)).status).toBe(200);

    const delta = await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(t0)}`);
    expect(delta.status).toBe(200);
    const ids = delta.body.requirements.map((r: any) => r.id).sort();
    expect(ids).toEqual([edit.id, arch.id].sort());
    expect(delta.body.requirements.find((r: any) => r.id === arch.id).archived).toBe(true);
    expect(delta.body.requirements.find((r: any) => r.id === edit.id).name).toBe("slim-edit-2");
    expect(delta.body.deleted).toEqual([gone.id]);
    expect(ids).not.toContain(keep.id);
    expect(Date.parse(delta.body.tombstones_since)).toBeLessThan(Date.parse(t0));

    // 接着读:什么都没变就是空的
    const again = await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(delta.body.server_time)}`);
    expect(again.body.requirements).toEqual([]);
    expect(again.body.deleted).toEqual([]);

    // 与 view=summary 组合
    const slim = await list(admin.token, `&changes=1&view=summary&updated_since=${encodeURIComponent(t0)}`);
    expect(slim.body.requirements.every((r: any) => !("description" in r) && "checklist_count" in r)).toBe(true);

    // 不带 changes 的 updated_since 与原来一样:归档的不回、没有 deleted
    const legacy = await list(admin.token, `&updated_since=${encodeURIComponent(t0)}`);
    expect(legacy.body.requirements.map((r: any) => r.id)).toEqual([edit.id]);
    expect(legacy.body.deleted).toBeUndefined();
    expect(legacy.body.server_time).toBeUndefined();
  });

  test("side effects that used to leave updated_at alone now show up: orphaned children, cleared project", async () => {
    const parent = await create(admin.token, { name: "slim-parent" });
    const child = await create(admin.token, { name: "slim-child", parent_id: parent.id });
    const proj = await send(admin.token, "POST", "/api/requirements/projects", { network_id: NET, name: "slim-proj" });
    expect(proj.status).toBe(201);
    const inProj = await create(admin.token, { name: "slim-in-proj", project_id: proj.body.project.id });
    await tick();
    const t0 = new Date().toISOString();
    await tick();
    expect((await del(admin.token, parent.id)).status).toBe(200);
    expect((await send(admin.token, "DELETE", `/api/requirements/projects/${proj.body.project.id}?network_id=${NET}`)).status).toBe(200);
    const delta = await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(t0)}`);
    const byId = new Map(delta.body.requirements.map((r: any) => [r.id, r]));
    expect((byId.get(child.id) as any)?.parent_id).toBeNull();
    expect((byId.get(inProj.id) as any)?.project_id).toBeNull();
    expect(delta.body.deleted).toEqual([parent.id]);
  });

  test("a scoped member only hears about deletions of cards they could see", async () => {
    const theirs = await create(admin.token, { name: "slim-theirs", owner: { kind: "user", id: scoped.id } });
    const hidden = await create(admin.token, { name: "slim-hidden" });
    const seen = await list(scoped.token);
    expect(seen.body.requirements.map((r: any) => r.id)).toContain(theirs.id);
    expect(seen.body.requirements.map((r: any) => r.id)).not.toContain(hidden.id);
    await tick();
    const t0 = new Date().toISOString();
    await tick();
    expect((await del(admin.token, theirs.id)).status).toBe(200);
    expect((await del(admin.token, hidden.id)).status).toBe(200);
    const mine = await list(scoped.token, `&changes=1&updated_since=${encodeURIComponent(t0)}`);
    expect(mine.body.deleted).toEqual([theirs.id]);
    const all = await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(t0)}`);
    expect(all.body.deleted.sort()).toEqual([theirs.id, hidden.id].sort());
  });
});

describe("list cache", () => {
  test("an unchanged table is served from the cache: same ETag, and If-None-Match still 304s", async () => {
    cache.clear();
    const a = await list(admin.token);
    expect(cache.size()).toBe(1);
    const b = await list(admin.token);
    expect(b.headers.get("etag")).toBe(a.headers.get("etag"));
    expect(b.text).toBe(a.text);
    expect((await list(admin.token, "", { "If-None-Match": a.headers.get("etag")! })).status).toBe(304);
  });

  test("every kind of write invalidates it: REST patch, MCP update, checklist tick, delete", async () => {
    const card = await create(admin.token, { name: "slim-cache", checklist: [{ text: "x", done: false }] });
    const seen = async () => (await list(admin.token)).body.requirements.find((r: any) => r.id === card.id);
    expect((await seen()).name).toBe("slim-cache");
    await patch(admin.token, card.id, { name: "slim-cache-rest" });
    expect((await seen()).name).toBe("slim-cache-rest");
    const viaMcp = await mcp(admin.token, "requirements_update", { id: card.id, network_id: NET, name: "slim-cache-mcp" });
    expect(viaMcp.ok).toBe(true);
    expect((await seen()).name).toBe("slim-cache-mcp");
    const item = (await seen()).checklist[0];
    expect((await send(admin.token, "PATCH", `/api/requirements/${card.id}/checklist/${item.id}?network_id=${NET}`, { done: true })).status).toBe(200);
    expect((await seen()).checklist[0].done).toBe(true);
    await del(admin.token, card.id);
    expect(await seen()).toBeUndefined();
  });

  test("a failed write still invalidates (the handler may have written before failing)", async () => {
    const g = cache.generation();
    await send(admin.token, "PATCH", `/api/requirements/does-not-exist?network_id=${NET}`, { name: "x" });
    expect(cache.generation()).toBe(g + 1);
    // 不是需求接口的写入不动代数
    await send(admin.token, "POST", "/api/task", { alias: "nobody", task: "x" });
    expect(cache.generation()).toBe(g + 1);
  });

  test("callers are cached separately; a member's access change is seen at once; scoped / agent-restricted members are never cached", async () => {
    cache.clear();
    await list(admin.token);
    await list(member.token);
    expect(cache.size()).toBe(2);
    await list(scoped.token);
    expect(cache.size()).toBe(2);
    const { db } = await import("./db.js");
    const before = await list(member.token);
    db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
    const after = await list(member.token);
    expect(after.body.requirements.length).toBeLessThan(before.body.requirements.length);
    db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
    expect((await list(member.token)).body.requirements.length).toBe(before.body.requirements.length);
    // Agent 受限(看得见哪些 Agent 取决于节点表)→ 不缓存
    cache.clear();
    db.run("UPDATE network_members SET agent_access = 'granted' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
    await list(member.token);
    expect(cache.size()).toBe(0);
    db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
  });

  test("changes=1 and search are not cached", async () => {
    cache.clear();
    await list(admin.token, `&changes=1&updated_since=${encodeURIComponent(new Date(0).toISOString())}`);
    await list(admin.token, "&q=slim");
    expect(cache.size()).toBe(0);
  });

  test("gzip of an unchanged list is computed once", async () => {
    const before = { ...gzipStats };
    const a = await fetch(`${BASE}/api/requirements?network_id=${NET}`, { headers: { Authorization: `Bearer ${admin.token}`, "Accept-Encoding": "gzip" }, decompress: false } as any);
    const b = await fetch(`${BASE}/api/requirements?network_id=${NET}`, { headers: { Authorization: `Bearer ${admin.token}`, "Accept-Encoding": "gzip" }, decompress: false } as any);
    expect(a.headers.get("content-encoding")).toBe("gzip");
    const ga = new Uint8Array(await a.arrayBuffer());
    const gb = new Uint8Array(await b.arrayBuffer());
    expect(Buffer.from(gunzipSync(gb)).toString()).toBe(Buffer.from(gunzipSync(ga)).toString());
    expect(gzipStats.hits).toBeGreaterThanOrEqual(before.hits + 1);
    expect(JSON.parse(Buffer.from(gunzipSync(gb)).toString()).ok).toBe(true);
  });
});

describe("GET /api/stats/routes", () => {
  test("admin sees per-route timings with ids collapsed; a member gets 403", async () => {
    await list(admin.token, "&view=summary");
    const r = await send(admin.token, "GET", "/api/stats/routes?minutes=5");
    expect(r.status).toBe(200);
    const routes = r.body.routes.map((x: any) => x.route);
    expect(routes).toContain("GET /api/requirements?view=summary");
    expect(routes.some((x: string) => x.startsWith("PATCH /api/requirements/:id"))).toBe(true);
    const row = r.body.routes.find((x: any) => x.route === "GET /api/requirements");
    expect(row.count).toBeGreaterThan(0);
    expect(row.max_ms).toBeGreaterThanOrEqual(row.avg_ms);
    expect((await send(member.token, "GET", "/api/stats/routes")).status).toBe(403);
  });
});
