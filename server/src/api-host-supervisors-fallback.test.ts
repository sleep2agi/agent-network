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
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

// Three users:
//   soloUser    — single accessible network (fallback should work)
//   multiUser   — two accessible networks (fallback should refuse)
//   orphanUser  — zero networks (fallback has nothing to derive)
let soloToken = "", multiToken = "", orphanToken = "";
let soloNetworkId = "";
let multiNetworkA = "", multiNetworkB = "";

beforeAll(async () => {
  process.env.COMMHUB_DB = SERVER_DB;
  process.env.PORT = String(PORT);
  process.env.HOST = "127.0.0.1";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "BootstrapPw123Aa!";

  // Pre-register a first user so subsequent test users are NOT auto-admin.
  // resolveRestNetworkScope's admin branch bypasses fallback (admin can
  // legitimately query any network), which would make solo's no-query
  // case a false-negative for our fix contract.
  const seed = register(`seed_admin_${suffix}`, password, undefined, "seed");
  if (!seed.ok) throw new Error("seed admin failed: " + JSON.stringify(seed));

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

  // Import triggers Bun.serve at module load — this IS the server start.
  await import("./index.js");
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
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

  test("path 2 — utok with 1 network, NO ?network_id → 200 (fallback lands)", async () => {
    // This is the core #380 fix: dashboard forgot the query but the user
    // only has one network anyway, so we can safely fall back to it.
    const r = await get(`/api/host-supervisors`, soloToken);
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    expect(Array.isArray(r.body?.daemons)).toBe(true);
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

  test("path 6 — utok with 0 networks, NO ?network_id → 400 missing_network_id (memberships=0)", async () => {
    const r = await get(`/api/host-supervisors`, orphanToken);
    expect(r.status).toBe(400);
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error).toBe("missing_network_id");
    expect(r.body?.memberships).toBe(0);
  });
});
