import { Database } from "bun:sqlite";
import { SQLiteAdapter } from "./db-adapter.js";
import { bindNodeConsumerToken, resolveNodeConsumerPrincipal, resolveQueueControlPrincipal } from "./hub-440-principal.js";
import { H1QueueService } from "./hub-440-queue-service.js";
import { installH1QueueSchema } from "./hub-440-queue-schema.js";
import type { NodeConsumerPrincipal, QueueControlPrincipal, QueueFaultStage } from "./hub-440-queue-types.js";

export type QueueTestHarness = ReturnType<typeof createQueueTestHarness>;

export function createQueueTestHarness(options: { nowMs?: number; faultStage?: QueueFaultStage } = {}) {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys=ON");
  const db = new SQLiteAdapter(raw);
  db.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE networks (
      network_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE network_members (
      network_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY(network_id, user_id)
    );
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      node_name TEXT NOT NULL,
      alias TEXT,
      network_id TEXT,
      lifecycle_state TEXT DEFAULT 'active'
    );
    CREATE TABLE api_tokens (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      network_id TEXT,
      name TEXT NOT NULL,
      scope TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      from_node_id TEXT,
      from_name TEXT NOT NULL,
      to_node_id TEXT,
      to_name TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      result TEXT,
      requires_response TEXT,
      network_id TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      parent_task_id TEXT
    );
    CREATE TABLE inbox (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      node_id TEXT,
      type TEXT,
      priority TEXT,
      content TEXT NOT NULL,
      from_session TEXT,
      acked INTEGER DEFAULT 0,
      requires_response TEXT,
      network_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT,
      network_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      network_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  installH1QueueSchema(db);

  db.run("INSERT INTO users(user_id, username, role) VALUES (?1, ?2, ?3)", ["user-a", "user-a", "admin"]);
  db.run("INSERT INTO networks(network_id, owner_id) VALUES (?1, ?2)", ["net-a", "user-a"]);
  db.run("INSERT INTO network_members(network_id, user_id, role) VALUES (?1, ?2, 'owner')", ["net-a", "user-a"]);
  for (const [nodeId, alias] of [["node-a", "alias-a"], ["node-b", "alias-b"], ["node-c", "alias-c"]] as const) {
    db.run("INSERT INTO nodes(node_id, node_name, alias, network_id, lifecycle_state) VALUES (?1, ?2, ?3, 'net-a', 'active')", [nodeId, alias, alias]);
  }
  for (const [tokenId, name] of [["tok-a", "node:alias-a"], ["tok-b", "node:alias-b"], ["tok-c", "node:alias-c"]] as const) {
    db.run("INSERT INTO api_tokens(token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, 'user-a', 'net-a', ?3, 'network')", [tokenId, `hash-${tokenId}`, name]);
  }
  db.run("INSERT INTO api_tokens(token_id, token_hash, user_id, network_id, name, scope) VALUES ('tok-control', 'hash-control', 'user-a', NULL, 'dashboard', 'user')");
  bindNodeConsumerToken(db, { kind: "verified_node_registration", tokenId: "tok-a", userId: "user-a", networkId: "net-a", nodeId: "node-a" });
  bindNodeConsumerToken(db, { kind: "verified_node_registration", tokenId: "tok-b", userId: "user-a", networkId: "net-a", nodeId: "node-b" });
  bindNodeConsumerToken(db, { kind: "verified_node_registration", tokenId: "tok-c", userId: "user-a", networkId: "net-a", nodeId: "node-c" });

  let now = options.nowMs ?? Date.parse("2026-07-14T08:00:00.000Z");
  let serial = 0;
  let leaseMints = 0;
  let faultStage = options.faultStage;
  const service = new H1QueueService(db, {
    nowMs: () => now,
    randomId: (prefix) => `${prefix}-${++serial}`,
    leaseSecret: () => { leaseMints++; return Buffer.alloc(32, ++serial).toString("base64url"); },
    faultAt: (stage) => {
      if (stage === faultStage) throw new Error(`fault:${stage}`);
    },
  });
  const principalA = resolveNodeConsumerPrincipal(db, "tok-a");
  const principalB = resolveNodeConsumerPrincipal(db, "tok-b");
  const principalC = resolveNodeConsumerPrincipal(db, "tok-c");
  const control = resolveQueueControlPrincipal(db, "tok-control", "net-a");

  return {
    raw,
    db,
    service,
    principalA,
    principalB,
    principalC,
    control,
    advance(ms: number) { now += ms; },
    setFault(stage?: QueueFaultStage) { faultStage = stage; },
    nowMs() { return now; },
    leaseMintCount() { return leaseMints; },
    close() { db.close(); },
  } satisfies {
    raw: Database;
    db: SQLiteAdapter;
    service: H1QueueService;
    principalA: NodeConsumerPrincipal;
    principalB: NodeConsumerPrincipal;
    principalC: NodeConsumerPrincipal;
    control: QueueControlPrincipal;
    advance(ms: number): void;
    setFault(stage?: QueueFaultStage): void;
    nowMs(): number;
    leaseMintCount(): number;
    close(): void;
  };
}

export function tableSnapshot(raw: Database, tables: readonly string[]): string {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables) {
    snapshot[table] = raw.query(`SELECT * FROM ${table} ORDER BY 1`).all();
  }
  return JSON.stringify(snapshot);
}
