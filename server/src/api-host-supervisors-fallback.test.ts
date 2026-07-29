// #380 fix — REST /api/host-supervisors utok→default-network fallback.
//
// Before this patch the endpoint hard-4xxed when the client omitted the
// `network_id` query param. The dashboard's create-node wizard was
// reported as "hub 400" against a prod hub that had zero daemons AND was
// being polled without the query — the frontend read that as "no
// available servers" and blocked the wizard.
//
// Post-fix contract:
//   - ntok caller                                → uses bound network (existing)
//   - utok caller + `?network_id=...` verified   → uses that (existing)
//   - utok caller + NO query + 1 accessible net  → fallback to that net (200)
//   - utok caller + NO query + 2+ accessible net → 400, error=network_id_required_multi
//   - utok caller + NO query + 0 accessible net  → 400, error=missing_network_id
//
// The multi-network case is the authz boundary — we refuse to guess
// which network to list from (per 通信龙 spec "别 fallback 到错 network").
//
// Test pattern mirrors uploads-http.test.ts: bind the real Bun.serve
// server on an ephemeral port with a temp DB, hit it with fetch().

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, login, createNetwork } from "./auth.js";
import { db } from "./db.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-hs-fallback-db-")) + "/commhub.db";
// #438 corrective: private bootServer({ port: 0 }) instance (see
// uploads-http.test.ts for rationale).
let BASE = "";
let server: any = null;

// Three users:
//   soloUser    — single accessible network (fallback should work)
//   multiUser   — two accessible networks (fallback should refuse)
//   orphanUser  — zero networks (fallback has nothing to derive)
let soloToken = "", multiToken = "", orphanToken = "", adminToken = "";
let soloNetworkId = "";
let multiNetworkA = "", multiNetworkB = "";
let soloDaemonAlias = "";

beforeAll(async () => {
  process.env.COMMHUB_DB = SERVER_DB;
  process.env.HOST = "127.0.0.1";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "BootstrapPw123Aa!";

  // Pre-register a first user so subsequent test users are NOT auto-admin.
  // resolveRestNetworkScope's admin branch bypasses fallback (admin can
  // legitimately query any network), which would make solo's no-query
  // case a false-negative for our fix contract.
  const seed = register(`seed_admin_${suffix}`, password, undefined, "seed");
  if (!seed.ok || !seed.token) throw new Error("seed admin failed: " + JSON.stringify(seed));
  // "First registered user is auto-admin" only holds when this suite has
  // the DB to itself. In an aggregate run another suite registers first,
  // the seed lands as a plain user, and paths 7/8 silently test the
  // wrong role. Promote explicitly — resolveToken reads users.role at
  // request time, so promotion after token issuance is effective.
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`seed_admin_${suffix}`]);
  // Save the admin token so path 7 can hit /api/host-supervisors as an
  // admin directly (通信龙 review point 1: verify admin+no-query goes 400
  // explicitly, not only implicitly via seed_admin's shadow presence).
  adminToken = seed.token;

  // Solo user — register() auto-creates a default network; nothing to add.
  const solo = register(`solo_${suffix}`, password, undefined, "seed");
  if (!solo.ok || !solo.token) throw new Error("solo register failed: " + JSON.stringify(solo));
  soloToken = solo.token;
  soloNetworkId = solo.network_id ?? "";
  if (!soloNetworkId) throw new Error("solo default network missing");

  // Multi user — register + create a second owned network.
  const multi = register(`multi_${suffix}`, password, undefined, "seed");
  if (!multi.ok || !multi.token) throw new Error("multi register failed: " + JSON.stringify(multi));
  multiToken = multi.token;
  multiNetworkA = multi.network_id ?? "";
  if (!multiNetworkA) throw new Error("multi default network missing");
  const authCtx = login(`multi_${suffix}`, password);
  const secondNet: any = createNetwork(authCtx.user!.user_id, `multi_second_${suffix}`);
  if (!secondNet.ok || !secondNet.network_id) throw new Error("multi second-net create failed: " + JSON.stringify(secondNet));
  multiNetworkB = secondNet.network_id;

  // Orphan user — register then delete membership in the default net so
  // the user has zero networks. Direct DB manipulation is fine here;
  // we're modeling an edge case the production API would never let a
  // normal user hit (they'd always keep at least their default), but
  // the endpoint contract still needs to be locked.
  const orphan = register(`orphan_${suffix}`, password, undefined, "seed");
  if (!orphan.ok || !orphan.token) throw new Error("orphan register failed: " + JSON.stringify(orphan));
  orphanToken = orphan.token;
  const orphanUserId = login(`orphan_${suffix}`, password).user!.user_id;
  db.run("DELETE FROM network_members WHERE user_id = ?1", [orphanUserId]);

  // 通信龙 review point 2: path-2's fallback response must land the
  // daemon list *from soloNetworkId specifically*, not from the whole
  // sessions/nodes table. The original test-2 asserted daemons was an
  // array but a clean fixture (0 daemons in the DB) would trivially
  // satisfy that. Insert:
  //   (a) a host_supervisor daemon in soloNetworkId — should show up in
  //       fallback response
  //   (b) a host_supervisor daemon in multiNetworkA — should NOT show
  //       up in solo's fallback (cross-tenant isolation lock)
  soloDaemonAlias = `solo_daemon_${suffix}`;
  seedHostSupervisorDaemon({
    alias: soloDaemonAlias,
    networkId: soloNetworkId,
    userIdForToken: login(`solo_${suffix}`, password).user!.user_id,
  });
  seedHostSupervisorDaemon({
    alias: `other_daemon_${suffix}`,
    networkId: multiNetworkA,
    userIdForToken: login(`multi_${suffix}`, password).user!.user_id,
  });

  // server.ts is side-effect-free to import; boot a private instance.
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));
});

// Insert a minimal `nodes` row + `api_tokens` row so the daemon shows up
// in /api/host-supervisors' JOIN-then-role-filter query (index.ts
// GET /api/host-supervisors handler, at the SELECT ... FROM nodes n ...
// EXISTS (SELECT 1 FROM api_tokens ...) branch). The api_tokens row
// with name='node:<alias>' + revoked_at IS NULL is the "still active"
// witness — without it EXISTS drops the row.
function seedHostSupervisorDaemon(opts: {
  alias: string;
  networkId: string;
  userIdForToken: string;
}) {
  const nodeId = `n_test_${opts.alias}`;
  db.run(
    `INSERT OR REPLACE INTO nodes (
       node_id, node_name, alias, runtime, model, config_path,
       channels, server, hostname, network_id,
       config_revision, config_snapshot
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [nodeId, opts.alias, opts.alias, "claude-agent-sdk", "claude-sonnet-4-5",
     "/tmp/cfg.json", "[]", "test-host", "test-host", opts.networkId,
     0, JSON.stringify({ role: "host_supervisor", daemon_capabilities: {} })],
  );
  db.run(
    `INSERT OR REPLACE INTO api_tokens (
       token_id, token_hash, user_id, network_id, name, scope
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [`tok_test_${opts.alias}`, `hash_test_${opts.alias}`,
     opts.userIdForToken, opts.networkId, `node:${opts.alias}`, "network"],
  );
}

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

async function get(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe("#380 — /api/host-supervisors utok→default-network fallback", () => {
  test("path 1 — utok with 1 network, WITH ?network_id → 200 (existing behavior)", async () => {
    const r = await get(`/api/host-supervisors?network_id=${soloNetworkId}`, soloToken);
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    expect(Array.isArray(r.body?.daemons)).toBe(true);
    expect(typeof r.body?.count).toBe("number");
  });

  test("path 2 — utok with 1 network, NO ?network_id → 200 (fallback lands AND scopes correctly)", async () => {
    // This is the core #380 fix: dashboard forgot the query but the user
    // only has one network anyway, so we can safely fall back to it.
    //
    // 通信龙 review point 2: harden the assertion beyond "daemons is an
    // array". We seeded one daemon in soloNetworkId and one in
    // multiNetworkA (multi user); the fallback response MUST include the
    // solo one and NOT the multi one. Otherwise a future regression that
    // wired the fallback to "all networks the user knows about" would
    // slip through — cross-tenant leak.
    const r = await get(`/api/host-supervisors`, soloToken);
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    expect(Array.isArray(r.body?.daemons)).toBe(true);

    const aliases: string[] = r.body.daemons.map((d: any) => d.alias);
    expect(aliases).toContain(soloDaemonAlias);
    // Belt: nothing from the multi user's network snuck through.
    expect(aliases.every((a: string) => !a.startsWith("other_daemon_"))).toBe(true);
    // Every returned daemon's daemon_node_id should be one this user can
    // legitimately see — locking the shape end-to-end.
    for (const d of r.body.daemons) {
      expect(typeof d.daemon_node_id).toBe("string");
      expect(typeof d.alias).toBe("string");
    }
  });

  test("path 3 — utok with 2 networks, NO ?network_id → 400 network_id_required_multi", async () => {
    // Authz boundary: refuse to guess which network to list. Distinguishing
    // error field lets the client tell the user "pick a network" vs
    // "you're not in any networks".
    const r = await get(`/api/host-supervisors`, multiToken);
    expect(r.status).toBe(400);
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error).toBe("network_id_required_multi");
    expect(r.body?.memberships).toBe(2);
  });

  test("path 4 — utok with 2 networks, WITH ?network_id → 200 (explicit choice honored)", async () => {
    const r = await get(`/api/host-supervisors?network_id=${multiNetworkA}`, multiToken);
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    const r2 = await get(`/api/host-supervisors?network_id=${multiNetworkB}`, multiToken);
    expect(r2.status).toBe(200);
    expect(r2.body?.ok).toBe(true);
  });

  test("path 5 — utok with 2 networks, WITH ?network_id (not a member) → denied by scope layer", async () => {
    // Requesting a network the user isn't in must never leak — this is
    // enforced upstream at resolveRestNetworkScope, but re-lock here.
    const foreignNet = "net_absolutely_not_a_member";
    const r = await get(`/api/host-supervisors?network_id=${foreignNet}`, multiToken);
    expect(r.status).toBe(403);
  });

  test("path 7 — admin utok, NO ?network_id → 400 (admin can span every network; no cross-network guessing)", async () => {
    // 通信龙 review point 1: the previous suite only asserted admin
    // indirectly (seed_admin was created first so other test users
    // weren't auto-admin). This test hits /api/host-supervisors with
    // seed_admin's own utok — resolveRestNetworkScope's isAdmin branch
    // returns networkIds:null, singleNetworkId returns null, endpoint
    // 400s. The response distinguishes it from the multi-network case
    // via `memberships` being absent-or-0 (admin doesn't populate
    // scope.networkIds), so the client sees an explicit "you're admin,
    // pass network_id" affordance.
    const r = await get(`/api/host-supervisors`, adminToken);
    expect(r.status).toBe(400);
    expect(r.body?.ok).toBe(false);
    // Not the multi-network error — admin path goes through the "no
    // scope.networkIds" branch → memberships defaults to 0 (the ??
    // coalesce in the handler). This asymmetry lets the client
    // distinguish "you own too many" from "you can see all of them".
    expect(r.body?.error).toBe("missing_network_id");
  });

  test("path 8 — admin utok, WITH explicit ?network_id → 200 (admin can inspect any network)", async () => {
    // Complement to path 7: even without membership in a target network,
    // admin can query it. Locks resolveRestNetworkScope's isAdmin =>
    // {networkId: requested, networkIds: null} branch.
    const r = await get(`/api/host-supervisors?network_id=${multiNetworkA}`, adminToken);
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    // The daemon we seeded in multiNetworkA must be reachable.
    const aliases: string[] = r.body.daemons.map((d: any) => d.alias);
    expect(aliases.some(a => a.startsWith("other_daemon_"))).toBe(true);
  });

  test("path 6 — utok with 0 networks, NO ?network_id → 400 missing_network_id (memberships=0)", async () => {
    const r = await get(`/api/host-supervisors`, orphanToken);
    expect(r.status).toBe(400);
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error).toBe("missing_network_id");
    expect(r.body?.memberships).toBe(0);
  });
});
