// #431 —— GET /api/status 记忆化 + 强 ETag(status-read-cache.ts)。钉住:
//   - 正文逐字节不变:随机写序列(改 sessions、健康上报、健康过期、改名清理)之后,每种读法「可能命中缓存的那一份」
//     都等于「清空缓存当场重算的那一份」;而且确实命中过(不是全靠重算凑出来的绿);
//   - JSON.stringify 与原来的 Response.json 对这些正文逐字节一致;Content-Type 不变;
//   - 不同调用者(另一个网络的用户、节点令牌的别名解析读法)键不串;
//   - 全量投影里有健康报告(health_observed_ms_ago 随时间走)就不缓存;
//   - ETag / If-None-Match → 304;gzip 解开等于原文。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync } from "zlib";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";
import { clearNodeHealthStore, recordNodeHealth, NODE_HEALTH_TTL_MS } from "./node-health-store.js";
import { __resetStatusCacheForTest, __setStatusCacheBypassForTest, noteStatement, statusCacheStats, statusWriteGeneration } from "./status-read-cache.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-status-read-cache-"));
let BASE = "";
let hub: any = null;
const PW = "StatusReadCachePassw0rd!";
let userToken = "", userId = "", NET = "", nodeToken = "", otherToken = "", OTHER_NET = "";
const ROWS = 60;

// 时间戳在 JS 里算好再绑定(SQLite 的 datetime('now', …) 拼接在 PostgreSQL 上没有,这份测试两种库都跑)。
const ts = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19);
function seed(i: number) {
  const node = `node_src_${i}`, alias = i % 2 ? `示例-${i}` : `src-${i}`;
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [node, alias, NET, userId]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, task, output, project_dir, hostname, server, agent, version,
       cpu_load_1min, mem_total_gb, process_rss_bytes, external_schedules, updated_at, last_seen_at, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, '2.5.0-preview.88', '1.5', '61.4', 121868288, ?11,
       ?12, ?13, '2026-09-01 00:00:00')`,
    [`r_${node}`, alias, node, i % 3 ? "idle" : "offline", NET, `示例任务 ${i}:\n  "引号" \\ 反斜杠   `.repeat(1 + (i % 5)),
      i % 4 ? null : `示例输出 ${i}`, `/home/user/project-${i}`, `sample-host-${i % 4}`,
      i % 2 ? "agent-node:codex-app-server" : "claude-code", i % 3 ? null : JSON.stringify([{ id: `s${i}`, every: 60 }]), ts(-i), ts(0)],
  );
}

async function get(path: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);

type Variant = { name: string; path: () => string; headers: () => Record<string, string> };
const VARIANTS: Variant[] = [
  { name: "user full", path: () => `/api/status?network_id=${NET}`, headers: () => ({ Authorization: `Bearer ${userToken}` }) },
  { name: "user light", path: () => `/api/status?network_id=${NET}&light=1`, headers: () => ({ Authorization: `Bearer ${userToken}` }) },
  { name: "user alias", path: () => `/api/status?network_id=${NET}&alias=${encodeURIComponent("示例-7")}`, headers: () => ({ Authorization: `Bearer ${userToken}` }) },
  { name: "node light node_id", path: () => `/api/status?network_id=${NET}&light=1&node_id=node_src_9`, headers: () => ({ Authorization: `Bearer ${nodeToken}` }) },
  { name: "old alias resolver", path: () => `/api/status?network_id=${NET}`, headers: () => ({ Authorization: `Bearer ${nodeToken}`, Accept: "application/json" }) },
  { name: "node full=1", path: () => `/api/status?network_id=${NET}&full=1`, headers: () => ({ Authorization: `Bearer ${nodeToken}`, Accept: "application/json" }) },
  { name: "other network user", path: () => `/api/status?network_id=${OTHER_NET}`, headers: () => ({ Authorization: `Bearer ${otherToken}` }) },
];

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`src_owner_${Date.now()}`, PW);
  userToken = a.token!; userId = a.user!.user_id; NET = a.network_id!;
  for (let i = 0; i < ROWS; i++) seed(i);
  nodeToken = createNetworkTokenForNode(userId, NET, "src-8", "node_src_8").token!;
  const b = register(`src_other_${Date.now()}`, PW);
  otherToken = b.token!; OTHER_NET = b.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("write detection", () => {
  test("writes that name sessions bump the generation; reads and other tables do not", () => {
    const g = statusWriteGeneration();
    noteStatement("SELECT * FROM sessions");
    noteStatement("UPDATE tasks SET status = 'x'");
    noteStatement("INSERT INTO inbox (id) VALUES (1)");
    expect(statusWriteGeneration()).toBe(g);
    noteStatement("  update sessions set status='idle'");
    noteStatement("INSERT INTO sessions (resume_id) VALUES ('x') RETURNING resume_id");
    noteStatement("DELETE FROM sessions WHERE alias = 'x'");
    noteStatement("WITH t AS (SELECT 1) UPDATE sessions SET task = NULL");
    expect(statusWriteGeneration()).toBe(g + 4);
  });

  test("the hook sits on the shared db adapter (every module's writes go through it)", () => {
    const g = statusWriteGeneration();
    db.run("UPDATE sessions SET progress = progress WHERE 1=0");
    expect(statusWriteGeneration()).toBe(g + 1);
  });

  test("no foreign key / trigger can change sessions without naming it", () => {
    if (db.dialect === "postgres") {
      const fks = db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM information_schema.referential_constraints rc
        JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.unique_constraint_name WHERE tc.table_name = 'sessions'`);
      expect(Number(fks[0]?.c ?? 0)).toBe(0);
      const trg = db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM information_schema.triggers WHERE action_statement ILIKE '%sessions%' OR event_object_table = 'sessions'`);
      expect(Number(trg[0]?.c ?? 0)).toBe(0);
      return;
    }
    const fks = db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").map(r => r.sql);
    expect(fks.filter(s => /references\s+sessions\b/i.test(s))).toEqual([]);
    expect(fks.filter(s => /create\s+trigger/i.test(s) && /\bsessions\b/i.test(s))).toEqual([]);
  });
});

describe("GET /api/status bodies are byte-identical with the cache", () => {
  test("random writes / health reports / expiry: cached == recomputed, and the cache is really used", async () => {
    __resetStatusCacheForTest();
    let rnd = 461;
    const r = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
    let compared = 0, hits = 0;
    for (let step = 0; step < 60; step++) {
      const op = Math.floor(r() * 6);
      const i = Math.floor(r() * ROWS);
      const alias = i % 2 ? `示例-${i}` : `src-${i}`;
      if (op === 0) db.run(`UPDATE sessions SET status = ?1, updated_at = ?2 WHERE node_id = ?3`, [r() < 0.5 ? "idle" : "working", ts(step), `node_src_${i}`]);
      if (op === 1) db.run(`UPDATE sessions SET task = ?1 WHERE node_id = ?2`, [`新任务 ${step}`, `node_src_${i}`]);
      if (op === 2) recordNodeHealth(NET, alias, { bridge: "ok", app_server: { ok: r() < 0.5, rtt_ms: 3, last_error: null }, model_auth: "ok" });
      if (op === 3) {
        // A report that expires a few ms from now: the degraded field must disappear on time.
        recordNodeHealth(NET, alias, { bridge: "ok", app_server: { ok: false, rtt_ms: null, last_error: "closed (code=1006)" }, model_auth: "ok" }, Date.now() - NODE_HEALTH_TTL_MS + 30);
        await Bun.sleep(40);
      }
      if (op === 4) db.run(`UPDATE sessions SET alias = ?1 WHERE node_id = ?2`, [`${alias}-改`, `node_src_${i}`]);
      // op 5: no write at all — the next reads must be cache hits for the cacheable variants.
      for (const v of VARIANTS) {
        const first = await get(v.path(), v.headers());
        const before = statusCacheStats.hits;
        const again = await get(v.path(), v.headers());
        hits += statusCacheStats.hits - before;
        // Fresh = recomputed right now, without dropping what the cache holds (stale entries must stay in play
        // across steps — clearing here would hide a missed invalidation).
        __setStatusCacheBypassForTest(true);
        const fresh = await get(v.path(), v.headers()).finally(() => __setStatusCacheBypassForTest(false));
        expect(first.status).toBe(200);
        const norm = (b: Uint8Array) => text(b).replace(/"health_observed_ms_ago":\d+/g, '"health_observed_ms_ago":0');
        expect(norm(first.buf)).toBe(norm(fresh.buf));
        expect(norm(again.buf)).toBe(norm(fresh.buf));
        if (!text(fresh.buf).includes('"health_observed_ms_ago":')) expect(text(again.buf)).toBe(text(fresh.buf));
        compared++;
      }
    }
    expect(compared).toBe(60 * VARIANTS.length);
    // Cacheable variants (everything except a full body carrying a health report) read twice in a row must hit.
    expect(hits).toBeGreaterThan(60 * 4);
  }, 120_000);

  test("JSON.stringify == Response.json for these bodies; headers keep Content-Type, add ETag", async () => {
    for (const v of VARIANTS) {
      const res = await get(v.path(), v.headers());
      const body = text(res.buf);
      expect(await Response.json(JSON.parse(body)).text()).toBe(body);
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      expect(res.headers.get("etag")).toMatch(/^"s-[0-9a-z]+-[0-9a-z]+"$/);
    }
  });

  test("keys do not leak across callers", async () => {
    const owner = JSON.parse(text((await get(`/api/status?network_id=${NET}`, { Authorization: `Bearer ${userToken}` })).buf));
    const other = JSON.parse(text((await get(`/api/status?network_id=${OTHER_NET}`, { Authorization: `Bearer ${otherToken}` })).buf));
    expect(owner.sessions.length).toBe(ROWS);
    expect(other.sessions.length).toBe(0);
    const resolver = await get(`/api/status?network_id=${NET}`, { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" });
    expect(resolver.headers.get("x-status-projection")).toBe("alias-resolver");
    expect(Object.keys(JSON.parse(text(resolver.buf)).sessions[0])).not.toContain("host");
  });

  test("a health report expiring (no write at all) invalidates the cached body on time", async () => {
    __resetStatusCacheForTest();
    clearNodeHealthStore();
    const v = VARIANTS[1]; // user light: carries `degraded` for a fresh down app_server
    const [{ alias: target }] = db.all<{ alias: string }>("SELECT alias FROM sessions WHERE node_id = 'node_src_2'");
    recordNodeHealth(NET, target, { bridge: "ok", app_server: { ok: false, rtt_ms: null, last_error: "closed (code=1006)" }, model_auth: "ok" }, Date.now() - NODE_HEALTH_TTL_MS + 1_500);
    const during = text((await get(v.path(), v.headers())).buf);
    expect(during).toContain('"degraded":[{"layer":"app_server"');
    const hitsBefore = statusCacheStats.hits;
    expect(text((await get(v.path(), v.headers())).buf)).toBe(during);
    expect(statusCacheStats.hits).toBe(hitsBefore + 1); // it was cached
    await Bun.sleep(1_600);
    const after = text((await get(v.path(), v.headers())).buf);
    expect(after).not.toContain('"degraded"');
    __resetStatusCacheForTest();
    expect(text((await get(v.path(), v.headers())).buf)).toBe(after);
  });

  test("full projection with a health report is not cached (its body moves with time)", async () => {
    __resetStatusCacheForTest();
    recordNodeHealth(NET, "src-0", { bridge: "ok", model_auth: "ok" });
    const v = VARIANTS[0];
    const a = text((await get(v.path(), v.headers())).buf);
    await Bun.sleep(15);
    const b = text((await get(v.path(), v.headers())).buf);
    expect(statusCacheStats.uncacheable).toBeGreaterThanOrEqual(2);
    expect(a).not.toBe(b); // health_observed_ms_ago moved — a cached copy would have frozen it
  });
});

describe("ETag / 304 / gzip", () => {
  test("If-None-Match with the current ETag → 304 empty; after a write → 200 with a new ETag", async () => {
    const h = { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" };
    const first = await get(`/api/status?network_id=${NET}`, h);
    const etag = first.headers.get("etag")!;
    const not = await get(`/api/status?network_id=${NET}`, { ...h, "If-None-Match": etag });
    expect(not.status).toBe(304);
    expect(not.buf.byteLength).toBe(0);
    expect(not.headers.get("x-status-projection")).toBe("alias-resolver");
    db.run(`UPDATE sessions SET status = 'working', updated_at = ?1 WHERE node_id = 'node_src_3'`, [ts(120)]);
    const changed = await get(`/api/status?network_id=${NET}`, { ...h, "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  test("gzip (the old node's Accept-Encoding: gzip, deflate) decodes to the same bytes", async () => {
    const h = { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" };
    const plain = await get(`/api/status?network_id=${NET}`, h);
    const res = await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: { ...h, "Accept-Encoding": "gzip, deflate" }, decompress: false } as any);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(text(gunzipSync(raw))).toBe(text(plain.buf));
  });
});
