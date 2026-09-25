// Duplicate-alias node rows vs the node pull/ack paths (field report).
//
// Re-creating a node under the same alias leaves the old `nodes` row behind, so
// one alias can own several rows in a network. The pull/ack tools used to
// resolve the caller by `WHERE alias = ? AND network_id = ?` + `db.get`, i.e.
// the first row SQLite yields — the stale one. Field shape: the client queued a
// rules-file read for the live node, the node pulled with its own (bound)
// token, the hub looked under the stale node_id, answered `request: null`, and
// the read timed out with only `[rules-file] doorbell received` in the node log.
//
// 跑法：cd server && COMMHUB_DB=/tmp/rules-dup.db bun test src/rules-file-duplicate-alias.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_rules_dup";
const USER = "u_rules_dup_owner";
const ALIAS = "rules-dup-node";
// Inserted first → the row a plain `db.get` on the alias returns.
const STALE_ID = "node_rules_dup_stale";
const LIVE_ID = "node_rules_dup_live";
const STALE_TOKEN = "tok_rules_dup_stale";
const LIVE_TOKEN = "tok_rules_dup_live";
const UNBOUND_TOKEN = "tok_rules_dup_unbound";

function cleanup() {
  try { db.run("DELETE FROM node_rules_requests WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM node_config_updates WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seedWorld(opts: { liveSession?: boolean } = {}) {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [USER, USER],
  );
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET, NET, USER]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, NET]);
  // Stale row first (older created_at AND lower rowid), live row second.
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '2026-09-16 01:40:40', '2026-09-16 01:40:40')`,
    [STALE_ID, ALIAS, ALIAS, NET],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '2026-09-16 01:42:46', '2026-09-16 01:42:46')`,
    [LIVE_ID, ALIAS, ALIAS, NET],
  );
  for (const [tok, bound, hash] of [
    [STALE_TOKEN, STALE_ID, "hash_rules_dup_stale"],
    [LIVE_TOKEN, LIVE_ID, "hash_rules_dup_live"],
    [UNBOUND_TOKEN, null, "hash_rules_dup_unbound"],
  ] as const) {
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, ?6)`,
      [tok, USER, NET, `node:${ALIAS}`, hash, bound],
    );
  }
  if (opts.liveSession !== false) {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, node_id, status, updated_at) VALUES (?1, ?2, ?3, ?4, 'idle', datetime('now'))`,
      [`sdk-${LIVE_ID}`, ALIAS, NET, LIVE_ID],
    );
  }
}

type Identity = { alias: string; isNetworkToken: boolean; tokenId: string };
const asUser: Identity = { alias: USER, isNetworkToken: false, tokenId: "tok_rules_dup_user" };
const asLive: Identity = { alias: ALIAS, isNetworkToken: true, tokenId: LIVE_TOKEN };
const asStale: Identity = { alias: ALIAS, isNetworkToken: true, tokenId: STALE_TOKEN };
const asUnbound: Identity = { alias: ALIAS, isNetworkToken: true, tokenId: UNBOUND_TOKEN };

async function connect(id: Identity) {
  const server = new McpServer({ name: "rules-dup-test", version: "1" });
  registerTools(server, undefined, NET, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "rules-dup-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const first = r.content?.[0];
    if (!first || first.type !== "text") throw new Error(`no text result from ${name}`);
    return JSON.parse(first.text);
  };
  const close = async () => { await client.close(); await server.close(); };
  return { call, close };
}

function queuedNodeId(requestId: string): string | undefined {
  return db.get<{ node_id: string }>("SELECT node_id FROM node_rules_requests WHERE request_id = ?1", requestId)?.node_id;
}

beforeEach(() => { cleanup(); });
afterAll(cleanup);

describe("duplicate alias — rules file pull/ack", () => {
  test("field case: read queued for the live node_id is pulled and acked by the live node's bound token", async () => {
    seedWorld();
    const u = await connect(asUser);
    const n = await connect(asLive);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: LIVE_ID });
      expect(enq).toMatchObject({ ok: true, op: "read" });
      const pulled = await n.call("get_rules_file_request", {});
      expect(pulled).toEqual({ ok: true, request: { request_id: enq.request_id, op: "read" } });
      const ack = await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "AGENTS.md", exists: true, content: "# live" });
      expect(ack).toMatchObject({ ok: true, status: "done" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "done", content: "# live" });
    } finally { await u.close(); await n.close(); }
  }, 20_000);

  test("a token bound to the stale row can neither pull nor ack the live node's request", async () => {
    seedWorld();
    const u = await connect(asUser);
    const stale = await connect(asStale);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: LIVE_ID });
      expect(await stale.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
      expect(await stale.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "# forged" }))
        .toEqual({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "pending" });
    } finally { await u.close(); await stale.close(); }
  }, 20_000);

  test("the live token does not pull a request queued for the stale row", async () => {
    seedWorld();
    const u = await connect(asUser);
    const n = await connect(asLive);
    try {
      await u.call("read_node_rules_file", { node_id: STALE_ID });
      expect(await n.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
    } finally { await u.close(); await n.close(); }
  }, 20_000);

  test("client targeting by alias queues under the row the alias's session points at", async () => {
    seedWorld();
    const u = await connect(asUser);
    try {
      const enq = await u.call("read_node_rules_file", { alias: ALIAS });
      expect(enq).toMatchObject({ ok: true, op: "read" });
      expect(queuedNodeId(enq.request_id)).toBe(LIVE_ID);
      const sk = await u.call("list_node_skills", { alias: ALIAS });
      expect(sk).toMatchObject({ ok: true });
      expect(queuedNodeId(sk.request_id)).toBe(LIVE_ID);
    } finally { await u.close(); }
  }, 20_000);

  test("without a session row, alias targeting falls back to the newest row", async () => {
    seedWorld({ liveSession: false });
    const u = await connect(asUser);
    try {
      const enq = await u.call("read_node_rules_file", { alias: ALIAS });
      expect(queuedNodeId(enq.request_id)).toBe(LIVE_ID);
    } finally { await u.close(); }
  }, 20_000);

  test("the session mapping wins over recency: alias targeting picks the older row when the session points at it", async () => {
    seedWorld({ liveSession: false });
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, node_id, status, updated_at) VALUES (?1, ?2, ?3, ?4, 'idle', datetime('now'))`,
      [`sdk-${STALE_ID}`, ALIAS, NET, STALE_ID],
    );
    const u = await connect(asUser);
    try {
      const enq = await u.call("read_node_rules_file", { alias: ALIAS });
      expect(queuedNodeId(enq.request_id)).toBe(STALE_ID);
    } finally { await u.close(); }
  }, 20_000);

  test("a token bound to a node whose row is gone does not fall back to another row with its alias", async () => {
    seedWorld();
    db.run("UPDATE api_tokens SET bound_node_id = 'node_rules_dup_deleted' WHERE token_id = ?1", [STALE_TOKEN]);
    const u = await connect(asUser);
    const stale = await connect(asStale);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: LIVE_ID });
      expect(await stale.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "pending" });
    } finally { await u.close(); await stale.close(); }
  }, 20_000);

  test("an unbound legacy token resolves its alias to the session-mapped row", async () => {
    seedWorld();
    const u = await connect(asUser);
    const n = await connect(asUnbound);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: LIVE_ID });
      expect(await n.call("get_rules_file_request", {})).toEqual({ ok: true, request: { request_id: enq.request_id, op: "read" } });
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});

describe("duplicate alias — config update pull/ack", () => {
  function queueUpdate(nodeId: string, updateId: string) {
    db.run(
      `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{"model":"m"}', 'hot', 0, 'pending', ?4, 'tok_rules_dup_user')`,
      [updateId, nodeId, NET, Date.now()],
    );
  }

  test("the live node's bound token pulls and acks its own pending update", async () => {
    seedWorld();
    queueUpdate(LIVE_ID, "cu_rules_dup_live");
    const n = await connect(asLive);
    try {
      const pulled = await n.call("get_config_update", {});
      expect(pulled.update?.update_id).toBe("cu_rules_dup_live");
      const ack = await n.call("ack_config_update", { update_id: "cu_rules_dup_live", status: "applied", new_revision: 1 });
      expect(ack.ok).toBe(true);
      expect(ack.ignored).toBeUndefined();
      expect(db.get<{ status: string }>("SELECT status FROM node_config_updates WHERE update_id = 'cu_rules_dup_live'")?.status).toBe("applied");
    } finally { await n.close(); }
  }, 20_000);

  test("a token bound to the stale row cannot pull or ack the live node's update", async () => {
    seedWorld();
    queueUpdate(LIVE_ID, "cu_rules_dup_live2");
    const stale = await connect(asStale);
    try {
      expect((await stale.call("get_config_update", {})).update).toBeNull();
      await stale.call("ack_config_update", { update_id: "cu_rules_dup_live2", status: "applied", new_revision: 1 });
      expect(db.get<{ status: string }>("SELECT status FROM node_config_updates WHERE update_id = 'cu_rules_dup_live2'")?.status).toBe("pending");
    } finally { await stale.close(); }
  }, 20_000);
});
