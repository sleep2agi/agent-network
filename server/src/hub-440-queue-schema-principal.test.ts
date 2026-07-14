import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteAdapter } from "./db-adapter.js";
import { bindNodeConsumerToken, resolveNodeConsumerPrincipal, resolveQueueControlPrincipal } from "./hub-440-principal.js";
import { installH1QueueSchema } from "./hub-440-queue-schema.js";
import { createQueueTestHarness } from "./hub-440-queue-test-support.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe("#440 H1 additive schema", () => {
  test("creates strict delivery tables without plaintext lease or legacy authority backfill", () => {
    const raw = new Database(":memory:");
    const db = new SQLiteAdapter(raw);
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE api_tokens(token_id TEXT PRIMARY KEY, token_hash TEXT, user_id TEXT, network_id TEXT, name TEXT, scope TEXT, expires_at TEXT, revoked_at TEXT);
      CREATE TABLE inbox(id TEXT PRIMARY KEY, session_name TEXT, node_id TEXT, content TEXT);
      CREATE TABLE nodes(node_id TEXT PRIMARY KEY, alias TEXT, node_name TEXT, network_id TEXT, lifecycle_state TEXT);
      CREATE TABLE network_members(network_id TEXT, user_id TEXT, role TEXT);
      CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
      CREATE TABLE task_events(id INTEGER PRIMARY KEY, task_id TEXT, to_status TEXT, actor TEXT);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY, action TEXT);
    `);
    db.run("INSERT INTO api_tokens VALUES ('legacy', 'h', 'u', 'n', 'node:alias', 'network', NULL, NULL)");
    db.run("INSERT INTO inbox VALUES ('legacy-row', 'alias', 'historical-node', 'payload')");

    installH1QueueSchema(db);

    expect(raw.query("SELECT COUNT(*) AS n FROM h1_node_token_bindings").get() as { n: number }).toEqual({ n: 0 });
    expect(raw.query("SELECT COUNT(*) AS n FROM h1_queue_deliveries").get() as { n: number }).toEqual({ n: 0 });
    const columns = raw.query("PRAGMA table_info(h1_queue_deliveries)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("lease_hash");
    expect(columns.map((c) => c.name)).not.toContain("lease_id");
    expect(columns.map((c) => c.name)).not.toContain("lease_plaintext");
    expect(() => db.run(`INSERT INTO h1_queue_deliveries
      (delivery_id, resource_kind, resource_id, task_id, network_id, consumer_node_id, requires_response, state, epoch, assignment_generation, attempt_number, created_at_ms, updated_at_ms)
      VALUES ('bad', 'message', 'r', 'task-must-be-null', 'n', 'node', 0, 'pending', 0, 0, 0, 1, 1)`)).toThrow();
  });
});

describe("#440 H1 structured principals", () => {
  test("resolves only an immutable server-created token binding", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    expect(h.principalA).toEqual({
      kind: "node_consumer", userId: "user-a", networkId: "net-a",
      nodeId: "node-a", tokenId: "tok-a", aliasSnapshot: "alias-a",
    });
    expect(() => bindNodeConsumerToken(h.db, {
      kind: "verified_node_registration", tokenId: "tok-a", userId: "user-a",
      networkId: "net-a", nodeId: "node-b",
    })).toThrow("consumer_principal_invalid");
  });

  test("legacy alias token, revocation, membership loss, and node mismatch fail closed", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.db.run("INSERT INTO api_tokens(token_id, token_hash, user_id, network_id, name, scope) VALUES ('legacy-only', 'h', 'user-a', 'net-a', 'node:alias-a', 'network')");
    expect(() => resolveNodeConsumerPrincipal(h.db, "legacy-only")).toThrow("consumer_principal_invalid");
    h.db.run("UPDATE api_tokens SET revoked_at='2026-01-01' WHERE token_id='tok-a'");
    expect(() => resolveNodeConsumerPrincipal(h.db, "tok-a")).toThrow("consumer_principal_invalid");
    h.db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id='tok-a'");
    h.db.run("DELETE FROM network_members WHERE network_id='net-a' AND user_id='user-a'");
    expect(() => resolveNodeConsumerPrincipal(h.db, "tok-a")).toThrow("consumer_principal_invalid");
  });

  test("queue control requires server-resolved owner/admin and rejects node tokens", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    expect(h.control.kind).toBe("queue_control");
    expect(h.control.role).toBe("owner");
    expect(() => resolveQueueControlPrincipal(h.db, "tok-a", "net-a")).toThrow("queue_control_principal_invalid");
    h.db.run("UPDATE network_members SET role='viewer' WHERE network_id='net-a' AND user_id='user-a'");
    expect(() => resolveQueueControlPrincipal(h.db, "tok-control", "net-a")).toThrow("queue_control_principal_invalid");
  });
});
