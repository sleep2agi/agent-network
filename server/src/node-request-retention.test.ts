// node_rules_requests content retention — privacy purge of node file bytes.
//
// Real MCP in-process transport, same harness as rules-file-transport.test.ts.
// Covers:
//   1. read result is handed out on the first terminal read, still handed out to
//      a second reader inside the grace window (the desktop app's
//      request_in_flight → follow path), then purged: status + metadata stay,
//      `content_purged: true` replaces content.
//   2. a caller outside the row's network can neither read nor stamp/purge it.
//   3. TTL sweep: >24h content cleared (stale pending flipped to timeout first),
//      >30d rows deleted, fresh unread rows untouched.
//   4. write payload (`content` column) is cleared; skill_read name is kept.
//
// 跑法：cd server && COMMHUB_DB=/tmp/nrr.db bun test src/node-request-retention.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { CONTENT_GRACE_MS, CONTENT_TTL_MS, ROW_TTL_MS, sweepNodeRequestContent } from "./node-request-retention.js";
import { sweepRetention } from "./retention.js";

const NET = "net_nrr";
const OTHER_NET = "net_nrr_other";
const USER = "u_nrr_owner";
const NODE_ID = "node_nrr_claude";
const NODE_ALIAS = "nrr-claude";
const NODE_TOKEN = "tok_nrr_node";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    try { db.run("DELETE FROM node_rules_requests WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM network_members WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [net]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seedWorld() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER, USER]);
  for (const net of [NET, OTHER_NET]) {
    db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [net, net, USER]);
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, net]);
  }
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [NODE_ID, NODE_ALIAS, NODE_ALIAS, NET],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [NODE_TOKEN, USER, NET, `node:${NODE_ALIAS}`, "hash_nrr_node"],
  );
}

type Identity = { net: string; alias: string; isNetworkToken: boolean; tokenId: string };
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_nrr_user" };
// Same human, scoped to the OTHER network: passes canWrite there, but the row
// lives in NET — SEC-1 must answer request_not_found and touch nothing.
const asUserOtherScope: Identity = { net: OTHER_NET, alias: USER, isNetworkToken: false, tokenId: "tok_nrr_user_other" };
const asNode: Identity = { net: NET, alias: NODE_ALIAS, isNetworkToken: true, tokenId: NODE_TOKEN };
// Same user, same network, a different login token: #1999 makes project-file
// results readable only by the token that asked.
const asUserOtherLogin: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_nrr_user_other_login" };

async function connect(id: Identity) {
  const server = new McpServer({ name: "nrr-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "nrr-client", version: "1" });
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

type Row = { status: string; content: string | null; result_content: string | null; file_name: string | null; first_read_at: number | null; content_purged_at: number | null; op: string };
const rowOf = (id: string) => db.get<Row>(
  "SELECT status, content, result_content, file_name, first_read_at, content_purged_at, op FROM node_rules_requests WHERE request_id = ?1", id,
);
const ageFirstRead = (id: string, ms: number) => db.run("UPDATE node_rules_requests SET first_read_at = first_read_at - ?1 WHERE request_id = ?2", [ms, id]);
const ageCreated = (id: string, ms: number) => db.run("UPDATE node_rules_requests SET created_at = created_at - ?1 WHERE request_id = ?2", [ms, id]);

async function readRoundTrip(u: Awaited<ReturnType<typeof connect>>, n: Awaited<ReturnType<typeof connect>>, body: string) {
  const enq = await u.call("read_node_rules_file", { node_id: NODE_ID });
  expect(enq.ok).toBe(true);
  await n.call("get_rules_file_request", {});
  await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "CLAUDE.md", exists: true, content: body });
  return enq.request_id as string;
}

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

describe("node_rules_requests — read once, purge after grace", () => {
  test("content returned on first terminal read and to a follower inside the grace window, then purged", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const body = "# secret rules\n";
      const rid = await readRoundTrip(u, n, body);
      expect(rowOf(rid)!.first_read_at).toBeNull();

      const first = await u.call("get_rules_file_result", { request_id: rid });
      expect(first).toMatchObject({ ok: true, status: "done", content: body, file_name: "CLAUDE.md", exists: true });
      expect(first.content_purged).toBeUndefined();
      const stamped = rowOf(rid)!.first_read_at;
      expect(stamped).not.toBeNull();

      // Second reader (app follow path) inside the grace window still gets it,
      // and the stamp is NOT pushed forward (a poller can't keep it alive).
      sweepNodeRequestContent();
      const follower = await u.call("get_rules_file_result", { request_id: rid });
      expect(follower.content).toBe(body);
      expect(rowOf(rid)!.first_read_at).toBe(stamped);

      ageFirstRead(rid, CONTENT_GRACE_MS + 1);
      // Any enqueue runs the opportunistic sweep.
      await u.call("list_node_skills", { node_id: NODE_ID });
      const row = rowOf(rid)!;
      expect(row.result_content).toBeNull();
      expect(row.content_purged_at).not.toBeNull();
      expect(row.status).toBe("done");
      expect(row.file_name).toBe("CLAUDE.md");

      const after = await u.call("get_rules_file_result", { request_id: rid });
      expect(after).toMatchObject({ ok: true, status: "done", file_name: "CLAUDE.md", exists: true, content_purged: true });
      expect("content" in after).toBe(false);
    } finally { await u.close(); await n.close(); }
  }, 20_000);

  test("non-terminal polls do not stamp; a never-read result keeps its content until TTL", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const enq = await u.call("read_node_rules_file", { node_id: NODE_ID });
      expect((await u.call("get_rules_file_result", { request_id: enq.request_id })).status).toBe("pending");
      expect(rowOf(enq.request_id)!.first_read_at).toBeNull();
      await n.call("get_rules_file_request", {});
      await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "CLAUDE.md", exists: true, content: "x" });
      sweepNodeRequestContent(Date.now() + CONTENT_GRACE_MS * 10);
      expect(rowOf(enq.request_id)!.result_content).toBe("x");
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});

describe("node_rules_requests — authorization", () => {
  test("a caller outside the row's network gets request_not_found and cannot stamp or purge it", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    const o = await connect(asUserOtherScope);
    try {
      const rid = await readRoundTrip(u, n, "# mine\n");
      for (let i = 0; i < 3; i++) {
        expect(await o.call("get_rules_file_result", { request_id: rid })).toMatchObject({ ok: false, error: "request_not_found" });
      }
      // Also pass the owner's network_id explicitly — scope is the token's, not the arg's.
      expect((await o.call("get_rules_file_result", { request_id: rid, network_id: NET })).content).toBeUndefined();
      expect(rowOf(rid)!.first_read_at).toBeNull();
      sweepNodeRequestContent(Date.now() + CONTENT_GRACE_MS * 10);
      expect(rowOf(rid)!.result_content).toBe("# mine\n");
      // The rightful requester still gets it.
      expect((await u.call("get_rules_file_result", { request_id: rid })).content).toBe("# mine\n");
    } finally { await u.close(); await n.close(); await o.close(); }
  }, 20_000);
});

describe("node_rules_requests — project files (#1999)", () => {
  test("another login token can't read or stamp a file_read row; the requester's read starts the grace clock; path is kept", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    const other = await connect(asUserOtherLogin);
    try {
      const enq = await u.call("read_node_file", { node_id: NODE_ID, path: "docs/plan.md" });
      expect(enq.ok).toBe(true);
      await n.call("get_rules_file_request", {});
      const body = JSON.stringify({ path: "docs/plan.md", kind: "text", content: "TOP SECRET PLAN" });
      await n.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: body });

      expect(await other.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      expect(rowOf(enq.request_id)!.first_read_at).toBeNull();

      expect((await u.call("get_rules_file_result", { request_id: enq.request_id })).content).toBe(body);
      ageFirstRead(enq.request_id, CONTENT_GRACE_MS + 1);
      sweepNodeRequestContent();
      const row = rowOf(enq.request_id)!;
      expect(row.result_content).toBeNull();
      expect(row.content).toBe("docs/plan.md");
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "done", content_purged: true });
    } finally { await u.close(); await n.close(); await other.close(); }
  }, 20_000);
});

describe("node_rules_requests — write payload", () => {
  test("write body in `content` is cleared after the grace window; skill_read name is kept", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      const body = "# new rules with a secret\n";
      const w = await u.call("write_node_rules_file", { node_id: NODE_ID, content: body });
      await n.call("get_rules_file_request", {});
      await n.call("ack_rules_file_request", { request_id: w.request_id, status: "done", file_name: "CLAUDE.md", exists: true });
      expect(rowOf(w.request_id)!.content).toBe(body);

      const s = await u.call("read_node_skill", { node_id: NODE_ID, name: "my-skill" });
      await n.call("get_rules_file_request", {});
      await n.call("ack_rules_file_request", { request_id: s.request_id, status: "done", content: JSON.stringify({ name: "my-skill", content: "SKILL BODY" }) });

      const wr = await u.call("get_rules_file_result", { request_id: w.request_id });
      expect(wr).toMatchObject({ status: "done", op: "write" });
      expect(wr.content).toBeUndefined();
      expect((await u.call("get_rules_file_result", { request_id: s.request_id })).content).toContain("SKILL BODY");

      ageFirstRead(w.request_id, CONTENT_GRACE_MS + 1);
      ageFirstRead(s.request_id, CONTENT_GRACE_MS + 1);
      sweepNodeRequestContent();

      const wRow = rowOf(w.request_id)!;
      expect(wRow.content).toBeNull();
      expect(wRow.content_purged_at).not.toBeNull();
      expect(wRow.status).toBe("done");
      const sRow = rowOf(s.request_id)!;
      expect(sRow.result_content).toBeNull();
      expect(sRow.content).toBe("my-skill");
      expect(await u.call("get_rules_file_result", { request_id: w.request_id })).toMatchObject({ status: "done", op: "write", content_purged: true });
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});

describe("node_rules_requests — TTL sweep", () => {
  test(">24h content cleared (stale pending write expired first, so no node can pull an emptied write); >30d rows deleted; fresh rows kept", async () => {
    const u = await connect(asUser);
    const n = await connect(asNode);
    try {
      // Create everything first, age afterwards: every enqueue runs the sweep.
      const oldRead = await readRoundTrip(u, n, "# old, never fetched\n");
      const ancient = await readRoundTrip(u, n, "# ancient\n");
      const fresh = await readRoundTrip(u, n, "# fresh, never fetched\n");
      // A write the node never pulled (offline for a day). Enqueued last so
      // single-flight doesn't refuse it.
      const w = await u.call("write_node_rules_file", { node_id: NODE_ID, content: "# stale write body\n" });
      expect(w.ok).toBe(true);
      ageCreated(oldRead, CONTENT_TTL_MS + 60_000);
      ageCreated(ancient, ROW_TTL_MS + 60_000);
      ageCreated(w.request_id, CONTENT_TTL_MS + 60_000);

      const r = sweepRetention();
      expect(r.nodeRequests.deleted).toBe(1);
      expect(r.nodeRequests.timedOut).toBe(1);
      expect(r.nodeRequests.purged).toBe(2);

      expect(rowOf(ancient)).toBeNull();
      const o = rowOf(oldRead)!;
      expect(o.result_content).toBeNull();
      expect(o.status).toBe("done");
      expect(o.file_name).toBe("CLAUDE.md");
      expect(rowOf(fresh)!.result_content).toBe("# fresh, never fetched\n");

      const wr = rowOf(w.request_id)!;
      expect(wr.status).toBe("timeout");
      expect(wr.content).toBeNull();
      // The node coming back must not receive the emptied write.
      expect(await n.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });

      expect(await u.call("get_rules_file_result", { request_id: oldRead })).toMatchObject({ status: "done", content_purged: true });

      // Idempotent.
      const again = sweepNodeRequestContent();
      expect(again).toEqual({ timedOut: 0, purged: 0, deleted: 0 });
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});
