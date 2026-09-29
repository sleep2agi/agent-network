// Agent 分组的性能守卫(RFC-038 §8):visibleAgents() 每个请求多做一次「组授权 → 组成员」展开,
// 这里量它的额外开销,并用 EXPLAIN QUERY PLAN 钉住展开查询走索引(不是全表扫)。
//
// 场景:NET 里 300 个节点;50 个组,每组 6 个节点(合起来覆盖全部 300 个)。
//   baseline —— bob 直接授权这 300 个节点(没有组);
//   groups   —— alice 授权这 50 个组(没有直接授权),可见集合与 bob 完全相同。
// 两人看到的 Agent 一样多,差值就是「按组展开」本身的代价。团队要求 ≈2 ms 以内(本机实测 −0.5~+1.9 ms);
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

const json = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: json(token), body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function time(fn: () => void, n: number): number {
  for (let i = 0; i < 5; i++) fn(); // warm-up
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
  return median(xs);
}
async function timeAsync(fn: () => Promise<void>, n: number): Promise<number> {
  for (let i = 0; i < 5; i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); }
  return median(xs);
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
    const base = time(() => { visibleAgents(bob.id, NET); }, 40);
    const groups = time(() => { visibleAgents(alice.id, NET); }, 40);
    console.log(`[perf] visibleAgents median: direct-300=${base.toFixed(2)}ms groups-50x6=${groups.toFixed(2)}ms delta=${(groups - base).toFixed(2)}ms`);
    expect(groups - base).toBeLessThanOrEqual(bound(base));
  });

  test(`受限成员 GET /api/status:组授权比等量直接授权多出 ≤ max(${BOUND_MS} ms, 基线 15%)`, async () => {
    const hit = async (token: string) => {
      const r = await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: json(token) });
      const body = await r.json() as any;
      if ((body.sessions ?? []).length !== NODES) throw new Error(`expected ${NODES} sessions, got ${(body.sessions ?? []).length}`);
    };
    const base = await timeAsync(() => hit(bob.token), 20);
    const groups = await timeAsync(() => hit(alice.token), 20);
    console.log(`[perf] GET /api/status median: direct-300=${base.toFixed(2)}ms groups-50x6=${groups.toFixed(2)}ms delta=${(groups - base).toFixed(2)}ms bound=${bound(base).toFixed(2)}ms`);
    expect(groups - base).toBeLessThanOrEqual(bound(base));
  });

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
