// SEC-1 cross-tenant write防护带 for RFC-024 config-apply.
//
// Mirrors src/cross-tenant-injection.test.ts pattern from PR #275 — drives
// the SQL queries the tool handlers run, against a real in-process SQLite,
// to prove the network-scope guard rejects cross-tenant writes against
// persisted rows. Pure SQL-level regression guard; the MCP tool-handler
// layer is the same logic wrapped in JSON-RPC.
//
// What's gated here:
//   - update_node_config / restart_node: hub-side SELECT node.network_id
//     check before INSERT into node_config_updates
//   - get_config_update: caller-alias-to-node-network match
//   - ack_config_update: same match on ack path
//
// Run with: COMMHUB_DB=/tmp/sec1-test.db bun test src/config-apply-sec1.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import { db, uuidv4 } from "./db.js";
import { upsertNodeWithSec1Guard } from "./tools.js";

function insertNode(opts: { node_id?: string; alias: string; network_id: string | null }): string {
  const id = opts.node_id ?? uuidv4();
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_revision) VALUES (?1, ?2, ?3, ?4, 0)`,
    [id, opts.alias, opts.alias, opts.network_id],
  );
  return id;
}

function insertUpdate(opts: {
  update_id?: string;
  node_id: string;
  network_id: string;
  status?: string;
  patch?: any;
}): string {
  const id = opts.update_id ?? `cu_${uuidv4()}`;
  db.run(
    `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, ?4, 'hot', 0, ?5, ?6, 'test')`,
    [id, opts.node_id, opts.network_id, JSON.stringify(opts.patch ?? {}), opts.status ?? "pending", Date.now()],
  );
  return id;
}

beforeEach(() => {
  db.run("DELETE FROM node_config_updates");
  db.run("DELETE FROM nodes");
});

describe("SEC-1 — resolveTargetNode-equivalent SELECT respects network_id", () => {
  // This is the exact query update_node_config / restart_node run
  // to fetch the target node + check network match. Pinning the SQL
  // behaviour so a future "convenience" change can't drop the network
  // scope (the way the pre-#275 inferred-parent SELECT did).

  test("node in netA: SELECT by node_id returns network_id=netA", () => {
    const nid = insertNode({ alias: "test-node-A", network_id: "netA" });
    const row = db.get<any>(
      "SELECT node_id, alias, network_id, config_revision FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(row?.network_id).toBe("netA");
  });

  test("netB caller checking a netA node: handler decides cross_network_node", () => {
    const nid = insertNode({ alias: "node-A-only", network_id: "netA" });
    const row = db.get<any>(
      "SELECT node_id, network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const callerNet = "netB";
    const nodeNet = row.network_id || "default";
    const sec1Ok = nodeNet === (callerNet || "default");
    expect(sec1Ok).toBe(false);  // SEC-1 fires, cross-tenant write would reject
  });

  test("same-network caller (netA → netA node): SEC-1 passes", () => {
    const nid = insertNode({ alias: "node-A", network_id: "netA" });
    const row = db.get<any>("SELECT network_id FROM nodes WHERE node_id = ?1", nid);
    const callerNet = "netA";
    const sec1Ok = (row.network_id || "default") === (callerNet || "default");
    expect(sec1Ok).toBe(true);
  });

  test("default-network caller cannot touch named-network node", () => {
    const nid = insertNode({ alias: "node-net1", network_id: "net1" });
    const row = db.get<any>("SELECT network_id FROM nodes WHERE node_id = ?1", nid);
    const callerNet = null;  // default
    const sec1Ok = (row.network_id || "default") === (callerNet || "default");
    expect(sec1Ok).toBe(false);
  });

  test("named-network caller cannot touch default-network node", () => {
    const nid = insertNode({ alias: "node-default", network_id: null });
    const row = db.get<any>("SELECT network_id FROM nodes WHERE node_id = ?1", nid);
    const callerNet = "netZ";
    const sec1Ok = (row.network_id || "default") === (callerNet || "default");
    expect(sec1Ok).toBe(false);
  });
});

describe("SEC-1 — get_config_update / ack_config_update by-alias filter respects network_id", () => {
  // The node-pull path resolves the node by alias + network. Pinning
  // that the WHERE clause excludes other networks' nodes even if the
  // alias happens to collide (rare but possible — nodes table allows
  // same alias across networks per the V3 schema).

  test("two nodes with same alias in two networks → query with network_id returns only the matching one", () => {
    insertNode({ alias: "same-alias", network_id: "netA" });
    insertNode({ alias: "same-alias", network_id: "netB" });
    const rowA = db.get<any>(
      "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
      "same-alias", "netA",
    );
    const rowB = db.get<any>(
      "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
      "same-alias", "netB",
    );
    expect(rowA?.node_id).not.toBe(rowB?.node_id);
  });

  test("node-pull get_config_update: netA node ntok_ cannot fetch netB node's pending update", () => {
    const nodeA = insertNode({ alias: "puller-A", network_id: "netA" });
    const nodeB = insertNode({ alias: "puller-B", network_id: "netB" });
    insertUpdate({ node_id: nodeB, network_id: "netB", status: "pending", patch: { flags: { maxTurns: 100 } } });
    // Simulate: ntok_ resolved to callerAlias="puller-A", enforceNetworkId="netA"
    // get_config_update SELECTs node by (alias, network_id), then SELECTs update by node.node_id
    const callerNode = db.get<any>(
      "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
      "puller-A", "netA",
    );
    expect(callerNode?.node_id).toBe(nodeA);
    const update = db.get<any>(
      "SELECT update_id FROM node_config_updates WHERE node_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      callerNode.node_id,
    );
    // No update for nodeA (the one in netB is not visible)
    expect(update == null).toBe(true);
  });

  test("ack_config_update: netA node cannot ack netB node's update", () => {
    const nodeA = insertNode({ alias: "acker-A", network_id: "netA" });
    const nodeB = insertNode({ alias: "acker-B", network_id: "netB" });
    const updId = insertUpdate({ node_id: nodeB, network_id: "netB", status: "pending" });
    // Simulate netA node trying to ack updId. Handler resolves caller alias
    // -> node row by (alias, network_id), then verifies update.node_id matches.
    const callerNode = db.get<any>(
      "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
      "acker-A", "netA",
    );
    expect(callerNode?.node_id).toBe(nodeA);
    const update = db.get<any>(
      "SELECT update_id, node_id FROM node_config_updates WHERE update_id = ?1",
      updId,
    );
    const ownershipMatch = update?.node_id === callerNode?.node_id;
    expect(ownershipMatch).toBe(false);  // would surface as ignored "unknown_or_foreign_update"
  });

  test("ack: same-node ack passes ownership check", () => {
    const nid = insertNode({ alias: "self-ack", network_id: "netA" });
    const updId = insertUpdate({ node_id: nid, network_id: "netA", status: "pending" });
    const callerNode = db.get<any>(
      "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
      "self-ack", "netA",
    );
    const update = db.get<any>(
      "SELECT update_id, node_id FROM node_config_updates WHERE update_id = ?1",
      updId,
    );
    expect(update?.node_id).toBe(callerNode?.node_id);
  });
});

describe("F-B (stale-update reaper) — single-flight TTL prevents permanent lock-out", () => {
  // Pinning the stale-supersede semantics: an in-flight row older than
  // 60_000 ms (2× apply ceiling) is treated as stale and a new update
  // can supersede it (marks old as timeout). Without this, a crashed
  // node ack'd "restarting" would brick remote restart forever.

  test("fresh in-flight (< 60s old) → blocks new update (single-flight)", () => {
    const nid = insertNode({ alias: "fresh", network_id: "netA" });
    // Insert with a created_at recent (< 60s).
    const fresh = `cu_${uuidv4()}`;
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{}', 'restart_only', 0, 'restarting', ?4, 'test')`,
      [fresh, nid, "netA", Date.now() - 10_000],
    );
    const STALE = 60_000;
    const row = db.get<any>(
      "SELECT update_id, created_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
      nid,
    );
    const age = Date.now() - row.created_at;
    expect(age).toBeLessThan(STALE);
  });

  test("stale in-flight (> 60s old) → can be superseded (marked timeout)", () => {
    const nid = insertNode({ alias: "stale", network_id: "netA" });
    const stale = `cu_${uuidv4()}`;
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{}', 'restart_only', 0, 'restarting', ?4, 'test')`,
      [stale, nid, "netA", Date.now() - 120_000],  // 2 min ago
    );
    const STALE = 60_000;
    const row = db.get<any>(
      "SELECT update_id, created_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
      nid,
    );
    const age = Date.now() - row.created_at;
    expect(age).toBeGreaterThan(STALE);
    // Simulate the supersede operation done by the tool handler.
    db.run(
      "UPDATE node_config_updates SET status = 'timeout', acked_at = ?1, error = 'superseded' WHERE update_id = ?2",
      [Date.now(), stale],
    );
    // After supersede, no in-flight remains.
    const remaining = db.get<any>(
      "SELECT update_id FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting')",
      nid,
    );
    expect(remaining == null).toBe(true);
  });
});

describe("SEC trust-root — report_status node upsert cannot re-home cross-tenant (#287 通信牛 catch)", () => {
  // 通信牛 catch on #287: report_status is a heartbeat called by every
  // ntok_'d node, and it upserts the nodes table with caller-supplied
  // node_id + caller's network_id. The old `ON CONFLICT DO UPDATE` blob
  // unconditionally set `network_id = COALESCE(?, nodes.network_id)`,
  // which would re-home an existing row if the caller's network differed.
  // Since resolveTargetNode (in config-apply tools) reads nodes.network_id
  // to authorize writes, that re-home would let a foreign network become
  // "authorized" to flip the row's config — defeating the cross-tenant
  // 防护带 from PR #275.
  //
  // Fix: SELECT-then-decide. If existing.network_id is set AND differs
  // from caller's effectiveNetId, skip the upsert entirely. These tests
  // pin the SELECT semantics at the SQL layer.

  test("netA caller checking a netB-owned node_id: SEC-1 verdict = NOT-OK (refuse upsert)", () => {
    const nid = insertNode({ alias: "victim-net-b", network_id: "netB" });
    const callerNet = "netA";
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);
    const sec1Ok = !existing
      || existing.network_id === null
      || existing.network_id === undefined
      || norm(existing.network_id) === norm(callerNet);
    expect(sec1Ok).toBe(false);
  });

  test("netB caller on its own node_id: SEC-1 verdict = OK", () => {
    const nid = insertNode({ alias: "owner-net-b", network_id: "netB" });
    const callerNet = "netB";
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);
    const sec1Ok = norm(existing?.network_id) === norm(callerNet);
    expect(sec1Ok).toBe(true);
  });

  test("legacy row (network_id NULL) — first network to claim it wins (bootstrap)", () => {
    const nid = insertNode({ alias: "legacy", network_id: null });
    const callerNet = "netA";
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    // Legacy row with NULL → caller's report_status would set it to netA.
    const sec1Ok = !existing
      || existing.network_id === null
      || existing.network_id === undefined;
    expect(sec1Ok).toBe(true);
  });

  test("default-network caller against named-network node_id → refused (no implicit promotion)", () => {
    const nid = insertNode({ alias: "named-only", network_id: "netA" });
    const callerNet: string | null = null;  // default
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);
    const sec1Ok = !existing
      || existing.network_id === null
      || norm(existing.network_id) === norm(callerNet);
    expect(sec1Ok).toBe(false);
  });

  test("named-network caller against default-network node_id → refused", () => {
    const nid = insertNode({ alias: "default-only", network_id: null });
    // After bootstrap (caller netA claimed), set the row to a third
    // network so this test isolates the refuse path.
    db.run("UPDATE nodes SET network_id = ?1 WHERE node_id = ?2", ["netZ", nid]);
    const callerNet = "netA";
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);
    const sec1Ok = norm(existing?.network_id) === norm(callerNet);
    expect(sec1Ok).toBe(false);
  });

  test("after cross-tenant attempt is refused, victim row's network_id is unchanged", () => {
    const nid = insertNode({ alias: "stable-net-b", network_id: "netB" });
    const callerNet = "netA";
    const existing = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);
    const sec1Ok = norm(existing?.network_id) === norm(callerNet);
    expect(sec1Ok).toBe(false);
    // Re-read to confirm no mutation happened (we never wrote in this
    // helper; the production guard would have refused the UPDATE).
    const after = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(after?.network_id).toBe("netB");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Real-driven regression test (per 通信龙 test-quality finding 2026-06-28):
// the 6 SEC trust-root tests above mirror the gate inline (cheap to write,
// zero protection against guard drift). This block calls the SAME helper
// that production report_status delegates to — if anyone weakens or
// deletes the gate, this fails.
// ─────────────────────────────────────────────────────────────────────
describe("SEC trust-root — REAL driver via upsertNodeWithSec1Guard (catches guard drift)", () => {
  test("netA caller cannot mutate netB-owned node row (production path)", () => {
    const nid = insertNode({ alias: "victim", network_id: "netB" });
    // Pre-state: row owned by netB.
    const pre = db.get<any>(
      "SELECT alias, network_id, config_snapshot FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(pre.network_id).toBe("netB");
    expect(pre.alias).toBe("victim");
    expect(pre.config_snapshot).toBeNull();

    // Attack: netA caller (effectiveNetId="netA") tries to upsert with
    // a different alias + a forged config snapshot.
    const outcome = upsertNodeWithSec1Guard({
      node_id: nid,
      callerNetworkId: "netA",
      alias: "attacker-alias",
      model: "attacker-model",
      config_snapshot: { model: "attacker", flags: { dangerouslySkipPermissions: true } },
    });

    // Production path returns refused (NOT inserted/updated).
    expect(outcome.result).toBe("refused");
    if (outcome.result === "refused") {
      expect(outcome.reason).toBe("cross_network");
      expect(outcome.existingNet).toBe("netB");
      expect(outcome.callerNet).toBe("netA");
    }

    // End-state: row IS UNCHANGED — same alias, same network, no
    // forged snapshot leaked in. If the gate were removed, alias would
    // be "attacker-alias", model would be "attacker-model", and
    // config_snapshot would be the forged payload. This is the
    // assertion that drift would break.
    const post = db.get<any>(
      "SELECT alias, network_id, model, config_snapshot FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(post.network_id).toBe("netB");
    expect(post.alias).toBe("victim");
    expect(post.model).toBeNull();
    expect(post.config_snapshot).toBeNull();
  });

  test("netB caller updating its own node row → production path returns updated", () => {
    const nid = insertNode({ alias: "owner-self", network_id: "netB" });
    const outcome = upsertNodeWithSec1Guard({
      node_id: nid,
      callerNetworkId: "netB",
      alias: "owner-self",
      model: "new-model",
      config_snapshot: { model: "new-model", flags: { maxTurns: 99 } },
    });
    expect(outcome.result).toBe("updated");
    const post = db.get<any>(
      "SELECT alias, network_id, model, config_snapshot FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(post.network_id).toBe("netB");
    expect(post.model).toBe("new-model");
    expect(post.config_snapshot).toContain("maxTurns");
  });

  test("legacy NULL row → first caller claims (bootstrap, production path)", () => {
    const nid = insertNode({ alias: "legacy-row", network_id: null });
    const outcome = upsertNodeWithSec1Guard({
      node_id: nid,
      callerNetworkId: "netA",
      alias: "legacy-row",
    });
    // sec1Ok is true (existing.network_id === null) → updated.
    expect(outcome.result).toBe("updated");
    const post = db.get<{ network_id: string | null }>(
      "SELECT network_id FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(post?.network_id).toBe("netA");
  });

  test("first write of a new node_id → inserted (callerNet becomes owner)", () => {
    const nid = `node_${uuidv4()}`;
    const outcome = upsertNodeWithSec1Guard({
      node_id: nid,
      callerNetworkId: "netC",
      alias: "freshman",
    });
    expect(outcome.result).toBe("inserted");
    const post = db.get<any>(
      "SELECT network_id, alias FROM nodes WHERE node_id = ?1",
      nid,
    );
    expect(post.network_id).toBe("netC");
    expect(post.alias).toBe("freshman");
  });

  test("default-network caller against named-network node → refused (no implicit promotion)", () => {
    const nid = insertNode({ alias: "named-only", network_id: "netA" });
    const outcome = upsertNodeWithSec1Guard({
      node_id: nid,
      callerNetworkId: null,  // default
      alias: "implicit-promote-attempt",
    });
    expect(outcome.result).toBe("refused");
    const post = db.get<any>("SELECT network_id, alias FROM nodes WHERE node_id = ?1", nid);
    expect(post.network_id).toBe("netA");
    expect(post.alias).toBe("named-only");
  });
});

describe("F-B polish — reaper anchors on COALESCE(acked_at, created_at), not created_at", () => {
  // 通信龙 catch: reaper threshold = 60s and drain hard-cap = 60s overlap.
  // A healthy-but-slow restart (drain 60s + respawn time) could exceed
  // the threshold if anchored on created_at alone. Anchoring on acked_at
  // means "node ack'd restarting → liveness clock refreshes" so an
  // in-progress restart isn't falsely reaped.

  test("row with old created_at + recent acked_at → fresh (age from acked_at)", () => {
    const nid = insertNode({ alias: "slow-restart", network_id: "netA" });
    const uid = `cu_${uuidv4()}`;
    const ancientCreatedAt = Date.now() - 120_000;  // 2 min ago
    const recentAckedAt = Date.now() - 30_000;       // 30s ago
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token, acked_at) VALUES (?1, ?2, ?3, '{}', 'restart_only', 0, 'restarting', ?4, 'test', ?5)`,
      [uid, nid, "netA", ancientCreatedAt, recentAckedAt],
    );
    const STALE = 60_000;
    const row = db.get<any>(
      "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
      nid,
    );
    const anchor = row.acked_at ?? row.created_at;
    const age = Date.now() - anchor;
    // age is from acked_at (~30s), NOT from created_at (~120s).
    expect(age).toBeLessThan(STALE);
    expect(age).toBeGreaterThan(20_000);  // sanity: roughly 30s
  });

  test("row with no acked_at + old created_at → stale (falls back to created_at)", () => {
    const nid = insertNode({ alias: "never-acked", network_id: "netA" });
    const uid = `cu_${uuidv4()}`;
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{}', 'restart_only', 0, 'pending', ?4, 'test')`,
      [uid, nid, "netA", Date.now() - 120_000],
    );
    const STALE = 60_000;
    const row = db.get<any>(
      "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
      nid,
    );
    const anchor = row.acked_at ?? row.created_at;
    const age = Date.now() - anchor;
    expect(age).toBeGreaterThan(STALE);  // no ack → falls back to created_at
  });

  test("row with old acked_at (node ack'd then crashed) → stale", () => {
    const nid = insertNode({ alias: "crashed-after-ack", network_id: "netA" });
    const uid = `cu_${uuidv4()}`;
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token, acked_at) VALUES (?1, ?2, ?3, '{}', 'restart_only', 0, 'restarting', ?4, 'test', ?5)`,
      [uid, nid, "netA", Date.now() - 200_000, Date.now() - 90_000],
    );
    const STALE = 60_000;
    const row = db.get<any>(
      "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
      nid,
    );
    const anchor = row.acked_at ?? row.created_at;
    const age = Date.now() - anchor;
    expect(age).toBeGreaterThan(STALE);  // ack'd 90s ago > 60s threshold
  });
});

describe("F-C (partial unique index) — DB-layer single-flight regardless of process count", () => {
  test("INSERT a second pending row for same node fails with UNIQUE constraint", () => {
    const nid = insertNode({ alias: "double", network_id: "netA" });
    insertUpdate({ node_id: nid, network_id: "netA", status: "pending" });
    let err: any = null;
    try {
      insertUpdate({ node_id: nid, network_id: "netA", status: "pending" });
    } catch (e: any) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err?.message || "")).toMatch(/UNIQUE|constraint/i);
  });

  test("INSERT a new pending after a TERMINAL one succeeds (partial index excludes terminal)", () => {
    const nid = insertNode({ alias: "after-applied", network_id: "netA" });
    insertUpdate({ node_id: nid, network_id: "netA", status: "applied" });
    // Should succeed — terminal rows don't occupy the partial index slot.
    expect(() => insertUpdate({ node_id: nid, network_id: "netA", status: "pending" })).not.toThrow();
  });
});

describe("SEC-1 — update lifecycle: single-flight + cross-network pending lookup", () => {
  test("netA pending update + netA query for same-node in-flight → finds it", () => {
    const nid = insertNode({ alias: "n1", network_id: "netA" });
    const uid = insertUpdate({ node_id: nid, network_id: "netA", status: "pending" });
    const inFlight = db.get<any>(
      "SELECT update_id FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting')",
      nid,
    );
    expect(inFlight?.update_id).toBe(uid);
  });

  test("two updates same node — terminal one does NOT block new one (single-flight only on non-terminal)", () => {
    const nid = insertNode({ alias: "n2", network_id: "netA" });
    insertUpdate({ node_id: nid, network_id: "netA", status: "applied" });
    const inFlight = db.get<any>(
      "SELECT update_id FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting')",
      nid,
    );
    expect(inFlight == null).toBe(true);  // no in-flight, write would be allowed
  });

  test("restarting status counts as in-flight (single-flight gate)", () => {
    const nid = insertNode({ alias: "n3", network_id: "netA" });
    insertUpdate({ node_id: nid, network_id: "netA", status: "restarting" });
    const inFlight = db.get<any>(
      "SELECT update_id FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting')",
      nid,
    );
    expect(inFlight).toBeDefined();
  });
});
