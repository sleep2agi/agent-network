// Agent 分组的性能守卫(RFC-038 §8):visibleAgents() 每个请求多做一次「组授权 → 组成员」展开,
// 这里量它的额外开销,并用 EXPLAIN QUERY PLAN 钉住展开查询走索引(不是全表扫)。
//
// 场景:NET 里 300 个节点;50 个组,每组 6 个节点(合起来覆盖全部 300 个)。
//   baseline —— bob 直接授权这 300 个节点(没有组);
//   groups   —— alice 授权这 50 个组(没有直接授权),可见集合与 bob 完全相同。
// 两人看到的 Agent 一样多,差值就是「按组展开」本身的代价(交替量 15 轮,取每轮差值的中位数)。团队要求 ≈2 ms 以内(本机实测 −0.5~+1.9 ms);
// 断言放宽到 max(5 ms, 基线的 15%)—— CI 容器比本机慢时两边一起变慢,绝对差也跟着放大。数字打印出来。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { visibleAgents } from "./agent-access.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-groups-perf-"));
let BASE = "";
let hub: any = null;
const PW = "GroupPerfPassw0rd!x";
let NET = "";
let adminToken = "";
let adminId = "";
let alice = { token: "", id: "" };
let bob = { token: "", id: "" };
const NODES = 300;
const GROUPS = 50;
const PER_GROUP = NODES / GROUPS;
const BOUND_MS = 5;
const bound = (base: number) => Math.max(BOUND_MS, base * 0.15);
// CI 容器里一次 visibleAgents() 约 65 ms(本机约 28 ms):原来 40 次 × 两边再加预热,顶破了 bun 默认的 5 s 单测超时(#2131 CI 实测)。
// 15 次取中位数足够稳;性能用例另给显式超时。
const WARMUP = 3;
const ITER = 15;
const PERF_TIMEOUT_MS = 60_000;

const json = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: json(token), body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
/**
 * 交替计时:每一轮先量 A 再量 B,取「B − A」的中位数(再附上两边各自的中位数给人看)。
 * 不能 A 连量 N 次再 B 连量 N 次:test638 在同一台机器上并发跑两份 aggregate,负载随时间变,
 * 两段分开量时差值被负载漂移主导(--cpus=1 实测差出 26–33 ms,真实差值 < 1 ms)。
 */
function pairedDelta(a: () => void, b: () => void, n: number): { a: number; b: number; delta: number } {
  for (let i = 0; i < WARMUP; i++) { a(); b(); }
  const as: number[] = [], bs: number[] = [], ds: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = performance.now(); a(); const ta = performance.now() - t;
    t = performance.now(); b(); const tb = performance.now() - t;
    as.push(ta); bs.push(tb); ds.push(tb - ta);
  }
  return { a: median(as), b: median(bs), delta: median(ds) };
}
async function pairedDeltaAsync(a: () => Promise<void>, b: () => Promise<void>, n: number): Promise<{ a: number; b: number; delta: number }> {
  for (let i = 0; i < WARMUP; i++) { await a(); await b(); }
  const as: number[] = [], bs: number[] = [], ds: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = performance.now(); await a(); const ta = performance.now() - t;
    t = performance.now(); await b(); const tb = performance.now() - t;
    as.push(ta); bs.push(tb); ds.push(tb - ta);
  }
  return { a: median(as), b: median(bs), delta: median(ds) };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const admin = register(`perf_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminId = admin.user!.user_id;
  NET = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  db.transaction(() => {
    for (let i = 0; i < NODES; i++) {
      const node = `node_perf_${i}`;
      const alias = `perf-agent-${i}`;
      db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at) VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`, [node, alias, NET, adminId]);
      db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at) VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`, [`resume_${node}`, alias, node, NET]);
    }
  });
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const mk = async (username: string) => {
    const r = await send(adminToken, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  alice = await mk(`perf_alice_${Date.now()}`);
  bob = await mk(`perf_bob_${Date.now()}`);

  const groupIds: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    const nodeIds = Array.from({ length: PER_GROUP }, (_, k) => `node_perf_${g * PER_GROUP + k}`);
    const r = await send(adminToken, "POST", `/api/networks/${NET}/agent-groups`, { name: `perf-group-${g}`, node_ids: nodeIds });
    expect(r.status).toBe(200);
    groupIds.push(r.body.group.group_id);
  }
  expect((await send(adminToken, "PUT", `/api/networks/${NET}/members/${alice.id}/agent-grants`, { group_grants: groupIds })).status).toBe(200);
  expect((await send(adminToken, "PUT", `/api/networks/${NET}/members/${bob.id}/agent-grants`, { grants: Array.from({ length: NODES }, (_, i) => `node_perf_${i}`) })).status).toBe(200);
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("Agent 分组:性能守卫(50 组 × 300 节点)", () => {
  test("两人可见集合相同(比较才公平)", () => {
    const a = visibleAgents(alice.id, NET);
    const b = visibleAgents(bob.id, NET);
    expect(a.nodeIds.length).toBe(NODES);
    expect([...a.nodeIds].sort()).toEqual([...b.nodeIds].sort());
  });

  test(`visibleAgents():组展开的额外开销 ≤ max(${BOUND_MS} ms, 基线 15%)(目标 ≈2 ms)`, () => {
    const r = pairedDelta(() => { visibleAgents(bob.id, NET); }, () => { visibleAgents(alice.id, NET); }, ITER);
    console.log(`[perf] visibleAgents median: direct-300=${r.a.toFixed(2)}ms groups-50x6=${r.b.toFixed(2)}ms paired-delta=${r.delta.toFixed(2)}ms bound=${bound(r.a).toFixed(2)}ms`);
    expect(r.delta).toBeLessThanOrEqual(bound(r.a));
  }, PERF_TIMEOUT_MS);

  // #2133:visibleAgents() 以前每个授权节点查一次 alias(300 条 ≈ 28–43 ms)。这两条钉住它不再回到 N+1:
  // 查询条数(直接授权 1 + 组授权 1 + alias 1)是主判据,不受机器负载影响;绝对上限只兜底 ——
  // 本机实测 ≈2.6–3.7 ms(负载 ~5),15 ms 给 test638 那种 --cpus=1 双份并发留足余量,仍远低于 N+1 的 28 ms。
  const ABS_MS = 15;
  test(`visibleAgents() at 300 grants stays under ${ABS_MS} ms (direct and via groups)`, () => {
    const t = pairedDelta(() => { visibleAgents(bob.id, NET); }, () => { visibleAgents(alice.id, NET); }, 40);
    console.log(`[perf] visibleAgents absolute: direct-300=${t.a.toFixed(2)}ms groups-50x6=${t.b.toFixed(2)}ms bound=${ABS_MS}ms`);
    expect(t.a).toBeLessThan(ABS_MS);
    expect(t.b).toBeLessThan(ABS_MS);
  });

  test("visibleAgents() makes a fixed number of queries, not one per granted node (#2133)", () => {
    for (const who of [bob, alice]) {
      let queries = 0;
      const all = db.all.bind(db), get = db.get.bind(db);
      (db as any).all = (...a: any[]) => { queries++; return (all as any)(...a); };
      (db as any).get = (...a: any[]) => { queries++; return (get as any)(...a); };
      try { visibleAgents(who.id, NET); } finally { (db as any).all = all; (db as any).get = get; }
      console.log(`[perf] visibleAgents queries (${who === bob ? "direct-300" : "groups-50x6"}): ${queries}`);
      expect(queries).toBeLessThanOrEqual(3);
    }
  });

  test(`受限成员 GET /api/status:组授权比等量直接授权多出 ≤ max(${BOUND_MS} ms, 基线 15%)`, async () => {
    const hit = async (token: string) => {
      const r = await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: json(token) });
      const body = await r.json() as any;
      if ((body.sessions ?? []).length !== NODES) throw new Error(`expected ${NODES} sessions, got ${(body.sessions ?? []).length}`);
    };
    const r = await pairedDeltaAsync(() => hit(bob.token), () => hit(alice.token), ITER);
    console.log(`[perf] GET /api/status median: direct-300=${r.a.toFixed(2)}ms groups-50x6=${r.b.toFixed(2)}ms paired-delta=${r.delta.toFixed(2)}ms bound=${bound(r.a).toFixed(2)}ms`);
    expect(r.delta).toBeLessThanOrEqual(bound(r.a));
  }, PERF_TIMEOUT_MS);

  test("EXPLAIN QUERY PLAN:组展开走索引,不全表扫描", () => {
    const plan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT m.node_id, g.can_message
         FROM network_member_group_grants g
         JOIN agent_groups ag ON ag.group_id = g.group_id AND ag.network_id = g.network_id
         JOIN agent_group_members m ON m.group_id = g.group_id
         JOIN nodes n ON n.node_id = m.node_id AND n.network_id = g.network_id
        WHERE g.network_id = ?1 AND g.user_id = ?2`,
      NET, alice.id,
    ).map((r) => r.detail);
    console.log(`[perf] plan:\n  ${plan.join("\n  ")}`);
    // 四张表都是 SEARCH(按主键 / 索引定位),没有一张是 SCAN。
    expect(plan.length).toBeGreaterThanOrEqual(4);
    expect(plan.filter((d) => /^SCAN\b/.test(d))).toEqual([]);
    expect(plan.every((d) => /^SEARCH\b/.test(d) && /(PRIMARY KEY|INDEX)/.test(d))).toBe(true);
  });

  test("EXPLAIN QUERY PLAN:按组找被授权成员(改组成员时断流用)走 group_id 索引", () => {
    const plan = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT user_id FROM network_member_group_grants WHERE group_id = ?1", "x",
    ).map((r) => r.detail);
    console.log(`[perf] plan (usersGrantedGroup): ${plan.join(" | ")}`);
    expect(plan.some((d) => /SEARCH .*idx_group_grants_group/.test(d))).toBe(true);
  });
});
