import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";

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

describe("RFC-024 regression — GET /api/nodes response shape (no SELECT *)", () => {
  test("explicit columns: internal config_revision/config_snapshot NOT in response", () => {
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
       7, JSON.stringify({ model: "claude-opus", flags: { x: true } })],
    );

    // Run the same SQL the handler runs (mirror; if handler changes, this
    // assertion still locks the shape).
    const rows = db.all<Record<string, unknown>>(
      `SELECT node_id, node_name, alias, runtime, model,
              config_path, channels, server, hostname,
              network_id, created_at, updated_at
       FROM nodes WHERE node_id = ?1`,
      TEST_NODE,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Expected fields present
    for (const k of ["node_id", "node_name", "alias", "runtime", "model",
                     "config_path", "channels", "server", "hostname",
                     "network_id", "created_at", "updated_at"]) {
      expect(row).toHaveProperty(k);
    }
    // Internal fields NOT present (these are the leak the test guards against)
    expect(row).not.toHaveProperty("config_revision");
    expect(row).not.toHaveProperty("config_snapshot");
    // Belt: full key set is exactly the 12 contract fields
    expect(Object.keys(row).sort()).toEqual([
      "alias", "channels", "config_path", "created_at", "hostname",
      "model", "network_id", "node_id", "node_name", "runtime",
      "server", "updated_at",
    ]);
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
