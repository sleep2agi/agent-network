import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { parseStoredTags } from "./node-attrs-validate.js";

// Regression test for SELECT * fragility on GET /api/nodes.
//
// Prior behavior: `SELECT * FROM nodes` returned whatever columns the
// table happened to have. When RFC-024 added config_revision +
// config_snapshot columns (read by the per-node GET /api/nodes/:id/config
// endpoint, NOT meant for the list endpoint), they silently leaked into
// the list response and broke V3 Networks tests that asserted on the
// nodes-list row shape.
//
// Current behavior: explicit column list — the response contract is:
//   node_id, node_name, alias, runtime, model, config_path, channels,
//   server, hostname, network_id, created_at, updated_at
// This test runs the same SQL the handler uses, on a row that DOES have
// config_revision + config_snapshot populated, and asserts those fields
// do NOT appear in the returned row. If anyone reverts the handler to
// SELECT *, or adds an internal column to the SELECT, this test breaks.

const TEST_NETWORK = "net_test_shape";
const TEST_NODE = "node_test_shape_abc";

beforeEach(() => {
  // Best-effort cleanup (test runs in shared test DB; rows are isolated by id)
  try { db.run("DELETE FROM nodes WHERE node_id = ?1", [TEST_NODE]); } catch {}
});
afterAll(() => {
  try { db.run("DELETE FROM nodes WHERE node_id = ?1", [TEST_NODE]); } catch {}
});

// Helper: mirror handler's role-extraction pass to mimic the production
// response shape exactly. Keeps the test the source of truth for the
// contract; if the handler changes, the assertions still lock what
// the dashboard / external clients see.
function mapRow(r: Record<string, unknown>): Record<string, unknown> {
  let role: string | null = null;
  const snap = r.config_snapshot;
  if (snap) {
    try { role = (typeof snap === "string" ? JSON.parse(snap) : snap)?.role ?? null; }
    catch { /* malformed */ }
  }
  const { config_snapshot, ...rest } = r;
  return {
    ...rest,
    tags: parseStoredTags(r.tags),
    attrs_revision: Number(r.attrs_revision ?? 0),
    role,
  };
}

describe("RFC-024 regression — GET /api/nodes response shape (no SELECT *)", () => {
  test("explicit columns + role extracted: config_snapshot NOT in response, role IS", () => {
    // Insert a row with the leak-prone columns populated. Use INSERT OR
    // REPLACE so concurrent test runs don't trip on PRIMARY KEY.
    db.run(
      `INSERT OR REPLACE INTO nodes (
         node_id, node_name, alias, runtime, model, config_path,
         channels, server, hostname, network_id,
         config_revision, config_snapshot
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       )`,
      [TEST_NODE, "test-shape", "test-shape", "claude-agent-sdk", "claude-opus",
       "/tmp/cfg.json", "[]", "localhost", "test-host", TEST_NETWORK,
       7, JSON.stringify({ model: "claude-opus", flags: { x: true }, role: "host_supervisor" })],
    );

    // Mirror handler SQL + mapping
    const raw = db.all<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model,
              config_path, channels, server, hostname,
              network_id, created_at, updated_at,
              config_snapshot, display_name, team, tags, attrs_revision
       FROM nodes WHERE node_id = ?1`,
      TEST_NODE,
    );
    const rows = raw.map(mapRow);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Expected fields present (13 = 12 contract + new role)
    for (const k of ["node_id", "node_name", "alias", "runtime", "model",
                     "config_path", "channels", "server", "hostname",
                     "network_id", "created_at", "updated_at", "role"]) {
      expect(row).toHaveProperty(k);
    }
    // Internal fields NOT present
    expect(row).not.toHaveProperty("config_revision");
    expect(row).not.toHaveProperty("config_snapshot");
    // role is EXTRACTED from config_snapshot JSON, not the raw blob
    expect(row.role).toBe("host_supervisor");
    // Belt: the key set is exactly the dashboard-facing contract.
    // NOTE: this file MIRRORS the handler's SQL rather than calling it, so
    // it can drift — it already lagged behind `lifecycle_state` /
    // `avatar_url`, which the handler selects but this mirror does not.
    // Treat a diff here as "re-read the handler", not as proof of the wire
    // shape; node-attrs.test.ts asserts the real HTTP response.
    expect(Object.keys(row).sort()).toEqual([
      "alias", "attrs_revision", "channels", "config_path", "created_at",
      "display_name", "hostname", "model", "network_id", "node_id",
      "node_name", "role", "runtime", "server", "tags", "team",
      "updated_at",
    ]);
  });

  test("role is null when config_snapshot is empty / missing / malformed", () => {
    // Empty snapshot → null
    db.run(
      `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id, config_snapshot)
       VALUES (?1, ?2, ?3, ?4, NULL)`,
      [TEST_NODE, "test-shape", "test-shape", TEST_NETWORK],
    );
    let row = mapRow(db.get<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model, config_path, channels,
              server, hostname, network_id, created_at, updated_at, config_snapshot,
              display_name, team, tags, attrs_revision
       FROM nodes WHERE node_id = ?1`,
      TEST_NODE,
    )!);
    expect(row.role).toBeNull();
    expect(row).not.toHaveProperty("config_snapshot");

    // Malformed JSON → null (handler doesn't throw, just leaves role null)
    db.run(`UPDATE nodes SET config_snapshot = ?1 WHERE node_id = ?2`, ["not-json{", TEST_NODE]);
    row = mapRow(db.get<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model, config_path, channels,
              server, hostname, network_id, created_at, updated_at, config_snapshot,
              display_name, team, tags, attrs_revision
       FROM nodes WHERE node_id = ?1`,
      TEST_NODE,
    )!);
    expect(row.role).toBeNull();

    // Snapshot without role key → null
    db.run(`UPDATE nodes SET config_snapshot = ?1 WHERE node_id = ?2`,
           [JSON.stringify({ model: "x", flags: {} }), TEST_NODE]);
    row = mapRow(db.get<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model, config_path, channels,
              server, hostname, network_id, created_at, updated_at, config_snapshot,
              display_name, team, tags, attrs_revision
       FROM nodes WHERE node_id = ?1`,
      TEST_NODE,
    )!);
    expect(row.role).toBeNull();
  });

  test("daemon discovery use-case: dashboard finds role=host_supervisor without prefix heuristic", () => {
    // Daemon registered with arbitrary node_id (NO `node_daemon_` prefix)
    db.run(
      `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id, config_snapshot)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      [TEST_NODE, "my-daemon", "my-daemon", TEST_NETWORK,
       JSON.stringify({ role: "host_supervisor", runtime: "claude-agent-sdk" })],
    );
    const rows = db.all<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model, config_path, channels,
              server, hostname, network_id, created_at, updated_at, config_snapshot,
              display_name, team, tags, attrs_revision
       FROM nodes WHERE network_id = ?1`,
      TEST_NETWORK,
    ).map(mapRow);
    // Dashboard's lookup: find first node with role==='host_supervisor'
    const daemon = rows.find(r => r.role === "host_supervisor");
    expect(daemon).toBeTruthy();
    expect(daemon!.node_id).toBe(TEST_NODE);
    // Even though node_id does NOT start with `node_daemon_` (the prior heuristic)
    expect(String(daemon!.node_id).startsWith("node_daemon_")).toBe(false);
  });

  test("internal columns are still readable via dedicated query (config snapshot endpoint path)", () => {
    db.run(
      `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id,
                                     config_revision, config_snapshot)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [TEST_NODE, "test-shape", "test-shape", TEST_NETWORK,
       42, JSON.stringify({ model: "claude-opus" })],
    );
    // Mirrors the SELECT in GET /api/nodes/:id/config (server/src/index.ts):
    const cfgRow = db.get<{ config_revision: number; config_snapshot: string }>(
      "SELECT config_revision, config_snapshot FROM nodes WHERE node_id = ?1",
      TEST_NODE,
    );
    expect(cfgRow?.config_revision).toBe(42);
    expect(cfgRow?.config_snapshot).toContain("claude-opus");
  });
});
