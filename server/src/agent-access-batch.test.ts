// visibleAgents() batched into one query. The old implementation (kept here verbatim as the
// reference) ran one nodes ∪ sessions lookup per node_id grant — ~300 queries per call for a
// restricted member with 300 grants, on every restricted /api/status poll. The new one must return
// IDENTICAL output (same members, same order) on randomized fixtures.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-agent-access-batch-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

let db: any;
let visibleAgents: (userId: string, networkId: string) => any;
let listAgentGrants: (networkId: string, userId: string) => any[];
let CHUNK = 0;

function visibleAgentsReference(userId: string, networkId: string) {
  const aliases = new Set<string>();
  const nodeIds = new Set<string>();
  const messageAliases = new Set<string>();
  const messageNodeIds = new Set<string>();
  // Group grants (#2131) expanded exactly as agent-access.ts groupGrantNodes() does, appended after
  // the direct grants — the order the old loop saw them in.
  const groupNodes = db.all(
    `SELECT m.node_id, g.can_message
       FROM network_member_group_grants g
       JOIN agent_groups ag ON ag.group_id = g.group_id AND ag.network_id = g.network_id
       JOIN agent_group_members m ON m.group_id = g.group_id
       JOIN nodes n ON n.node_id = m.node_id AND n.network_id = g.network_id
      WHERE g.network_id = ?1 AND g.user_id = ?2`,
    networkId, userId,
  ).map((row: any) => ({ node_id: row.node_id, alias: null, can_message: row.can_message === 1 }));
  for (const grant of [...listAgentGrants(networkId, userId), ...groupNodes]) {
    const grantAliases: string[] = [];
    if (grant.node_id) {
      nodeIds.add(grant.node_id);
      if (grant.can_message) messageNodeIds.add(grant.node_id);
      for (const row of db.all(
        `SELECT alias FROM nodes WHERE node_id = ?1 AND network_id = ?2
         UNION SELECT alias FROM sessions WHERE node_id = ?1 AND network_id = ?2`,
        grant.node_id, networkId,
      )) {
        if (row.alias) grantAliases.push(row.alias);
      }
    } else if (grant.alias) {
      grantAliases.push(grant.alias);
    }
    for (const alias of grantAliases) {
      aliases.add(alias);
      if (grant.can_message) messageAliases.add(alias);
    }
  }
  return { aliases: [...aliases], nodeIds: [...nodeIds], messageAliases: [...messageAliases], messageNodeIds: [...messageNodeIds] };
}

// Deterministic PRNG so a failure is reproducible from the printed seed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

let seq = 0;
function seedFixture(seed: number, opts: { nodes: number; grants: number; groups?: number }) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const tag = `s${seed}_${seq++}`;
  db.exec("BEGIN");
  const net = `net_${tag}`, other = `net_${tag}_other`, user = `u_${tag}`;
  db.run(`INSERT INTO users (user_id, username, password_hash) VALUES (?1, ?1, 'x')`, [user]);
  const nodeIds: string[] = [];
  const legacyAliases: string[] = [];
  for (let i = 0; i < opts.nodes; i++) {
    const nodeId = `node_${tag}_${i}`;
    nodeIds.push(nodeId);
    const alias = `agent-${tag}-${i}`;
    const shape = r();
    // nodes row (sometimes missing, sometimes NULL alias)
    if (shape > 0.1) db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?2, ?3, ?4)`, [nodeId, alias, shape > 0.15 ? alias : null, net]);
    // sessions rows: same alias, a renamed alias (rename window), several, or none
    const sessions = r() < 0.2 ? 0 : 1 + Math.floor(r() * 3);
    for (let k = 0; k < sessions; k++) {
      const sAlias = k === 0 && r() < 0.6 ? alias : `${alias}-renamed-${k}`;
      db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id) VALUES (?1, ?2, ?3, 'idle', ?4)`, [`r_${tag}_${i}_${k}`, sAlias, nodeId, net]);
    }
    // same node_id in another network must never leak in
    if (r() < 0.3) db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id) VALUES (?1, ?2, ?3, 'idle', ?4)`, [`r_${tag}_${i}_x`, `${alias}-elsewhere`, nodeId, other]);
  }
  for (let i = 0; i < Math.ceil(opts.nodes / 5); i++) {
    const alias = `legacy-${tag}-${i}`;
    legacyAliases.push(alias);
    db.run(`INSERT INTO sessions (resume_id, alias, status, network_id) VALUES (?1, ?2, 'idle', ?3)`, [`rl_${tag}_${i}`, alias, net]);
  }
  const usedAliases = new Set<string>();
  // distinct nodes in a shuffled order (the grant table has one row per node per member)
  const order = nodeIds.map(n => [r(), n] as const).sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  for (let i = 0; i < opts.grants; i++) {
    const byNode = r() < 0.8;
    const can = r() < 0.5 ? 1 : 0;
    if (byNode) {
      const nodeId = r() < 0.05 ? `node_${tag}_ghost_${i}` : order.pop();
      if (!nodeId) continue;
      db.run(`INSERT INTO network_member_agent_grants (network_id, user_id, node_id, alias, can_message) VALUES (?1, ?2, ?3, NULL, ?4)`, [net, user, nodeId, can]);
    } else {
      const alias = pick(legacyAliases);
      if (usedAliases.has(alias)) continue;
      usedAliases.add(alias);
      db.run(`INSERT INTO network_member_agent_grants (network_id, user_id, node_id, alias, can_message) VALUES (?1, ?2, NULL, ?3, ?4)`, [net, user, alias, can]);
    }
  }
  // Groups (#2131): some granted, some not; members include nodes also granted directly (with a
  // different can_message), ghost nodes with no nodes row, and a node that lives in another network.
  const groups = opts.groups ?? 0;
  for (let gi = 0; gi < groups; gi++) {
    const groupId = `grp_${tag}_${gi}`;
    const groupNet = r() < 0.1 ? other : net;
    db.run(`INSERT INTO agent_groups (group_id, network_id, name) VALUES (?1, ?2, ?3)`, [groupId, groupNet, `group ${tag} ${gi}`]);
    const size = 1 + Math.floor(r() * 8);
    const members = new Set<string>();
    for (let k = 0; k < size; k++) members.add(r() < 0.05 ? `node_${tag}_ghostmember_${gi}_${k}` : pick(nodeIds));
    if (r() < 0.2) {
      const foreign = `node_${tag}_foreign_${gi}`;
      db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?1, ?2, ?3)`, [foreign, `foreign-${tag}-${gi}`, other]);
      members.add(foreign);
    }
    for (const m of members) db.run(`INSERT INTO agent_group_members (group_id, node_id) VALUES (?1, ?2)`, [groupId, m]);
    if (r() < 0.7) db.run(`INSERT INTO network_member_group_grants (network_id, user_id, group_id, can_message) VALUES (?1, ?2, ?3, ?4)`, [net, user, groupId, r() < 0.5 ? 1 : 0]);
  }
  db.exec("COMMIT");
  return { net, user };
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  ({ visibleAgents, listAgentGrants, VISIBLE_AGENTS_CHUNK: CHUNK } = await import("./agent-access.js") as any);
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("visibleAgents batched = reference, on randomized fixtures", () => {
  test("200 random fixtures: identical output (members and order)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { net, user } = seedFixture(seed, { nodes: 5 + (seed % 40), grants: seed % 7 === 0 ? 0 : 3 + (seed % 50), groups: seed % 3 === 0 ? 0 : 1 + (seed % 12) });
      const got = visibleAgents(user, net);
      const want = visibleAgentsReference(user, net);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`seed ${seed} differs:\nnew ${JSON.stringify(got)}\nold ${JSON.stringify(want)}`);
      }
    }
  }, 120_000);

  test("the fixtures exercise every shape (rename window, NULL alias, ghost node, legacy alias, other network, groups)", () => {
    const { net, user } = seedFixture(4242, { nodes: 60, grants: 80, groups: 15 });
    const groupNodes = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_member_group_grants WHERE network_id = ?1 AND user_id = ?2", net, user)!.n;
    expect(groupNodes).toBeGreaterThan(0);
    const got = visibleAgents(user, net);
    expect(got.aliases.some((a: string) => a.includes("-renamed-"))).toBe(true);
    expect(got.aliases.some((a: string) => a.startsWith("legacy-"))).toBe(true);
    expect(got.aliases.some((a: string) => a.endsWith("-elsewhere"))).toBe(false);
    expect(got.messageAliases.length).toBeLessThan(got.aliases.length);
    expect(JSON.stringify(got)).toBe(JSON.stringify(visibleAgentsReference(user, net)));
  });

  test("groups only (no direct grants): identical output, group nodes visible", () => {
    const { net, user } = seedFixture(9090, { nodes: 80, grants: 0, groups: 25 });
    const got = visibleAgents(user, net);
    expect(got.nodeIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(got)).toBe(JSON.stringify(visibleAgentsReference(user, net)));
  });

  test("no grants → all empty; unknown user → all empty", () => {
    const { net } = seedFixture(7, { nodes: 10, grants: 0 });
    expect(visibleAgents("nobody", net)).toEqual({ aliases: [], nodeIds: [], messageAliases: [], messageNodeIds: [] });
  });

  test("query-count guard: a fixed number of queries per call, not one per grant (#2133)", () => {
    const { net, user } = seedFixture(301, { nodes: 400, grants: 420, groups: 30 });
    const grants = listAgentGrants(net, user).length;
    expect(grants).toBeGreaterThanOrEqual(300);
    const calls = { all: 0, get: 0 };
    const all = db.all.bind(db), get = db.get.bind(db);
    db.all = (...a: any[]) => { calls.all++; return all(...a); };
    db.get = (...a: any[]) => { calls.get++; return get(...a); };
    try { visibleAgents(user, net); } finally { db.all = all; db.get = get; }
    // direct grants + group grants + ceil(nodes / chunk) alias reads
    expect(calls.all + calls.get).toBeLessThanOrEqual(2 + Math.ceil(grants / CHUNK));
    expect(calls.all + calls.get).toBeLessThanOrEqual(3);
  }, 60_000);

  test("more granted nodes than one chunk: same output across the chunk boundary", () => {
    const { net, user } = seedFixture(777, { nodes: CHUNK + 120, grants: CHUNK + 200 });
    expect(listAgentGrants(net, user).filter((g: any) => g.node_id).length).toBeGreaterThan(CHUNK);
    expect(JSON.stringify(visibleAgents(user, net))).toBe(JSON.stringify(visibleAgentsReference(user, net)));
  }, 120_000);

  test("timing at 300 grants (printed; new must be faster)", () => {
    const { net, user } = seedFixture(300, { nodes: 400, grants: 420 });
    const grants = listAgentGrants(net, user).length;
    expect(grants).toBeGreaterThanOrEqual(300);
    const time = (fn: () => unknown, n = 50) => { fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
    const oldMs = time(() => visibleAgentsReference(user, net));
    const newMs = time(() => visibleAgents(user, net));
    console.log(`visibleAgents @ ${grants} grants: old ${oldMs.toFixed(2)} ms/call, new ${newMs.toFixed(2)} ms/call (${(oldMs / newMs).toFixed(1)}x)`);
    expect(JSON.stringify(visibleAgents(user, net))).toBe(JSON.stringify(visibleAgentsReference(user, net)));
    expect(newMs).toBeLessThan(oldMs);
  }, 120_000);
});
