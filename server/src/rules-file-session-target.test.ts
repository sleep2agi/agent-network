// app#225 follow-up — rules-file requests to a SESSION that has no `nodes` row
// (claude-code sessions launched by `anet node start` + the channel server).
//
// Hub-side contract verified here:
//   1. report_status { rules_file_capable: true } marks the session capable only
//      when the caller is a node token bound to that same alias (a user token or
//      another node's token cannot mark it); omitting the field later does not clear it.
//   2. read/write_node_rules_file { alias } reach such a session: the node pulls
//      with its own token (queue key `session:<alias>`), acks, the client polls done.
//   3. An alias that has neither a node row nor a capable session is refused up
//      front (no request row, no 60 s timeout for the user to sit through).
//   4. Network isolation: a same-named alias in another network neither sees nor
//      acks the request; a caller in the other network cannot enqueue to it.
//   5. The original node_id path is unchanged (node row wins when both exist).
//
// 跑法：cd server && COMMHUB_DB=/tmp/rules-session.db bun test src/rules-file-session-target.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_rules_session";
const OTHER_NET = "net_rules_session_other";
const USER = "u_rules_session_owner";
const SESSION_ALIAS = "rules-session-cc";
const SESSION_RESUME = "cc-rules-session-1";
const OTHER_ALIAS = "rules-session-peer";
const NODE_ROW_ALIAS = "rules-session-noderow";
const NODE_ROW_ID = "node_rules_session_noderow";
const T_SESSION = "tok_rules_session_cc";
const T_PEER = "tok_rules_session_peer";
const T_OTHER_NET_SAME_ALIAS = "tok_rules_session_other_net";
const T_NODE_ROW = "tok_rules_session_noderow";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    try { db.run("DELETE FROM node_rules_requests WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM sessions WHERE network_id = ?1", [net]); } catch {}
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
  const tok = (id: string, net: string, alias: string) => db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [id, USER, net, `node:${alias}`, `hash_${id}`],
  );
  tok(T_SESSION, NET, SESSION_ALIAS);
  tok(T_PEER, NET, OTHER_ALIAS);
  tok(T_OTHER_NET_SAME_ALIAS, OTHER_NET, SESSION_ALIAS);
  tok(T_NODE_ROW, NET, NODE_ROW_ALIAS);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [NODE_ROW_ID, NODE_ROW_ALIAS, NODE_ROW_ALIAS, NET],
  );
}

type Identity = { net: string; alias: string; isNetworkToken: boolean; tokenId: string };
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_rules_session_user" };
const asOtherNetUser: Identity = { net: OTHER_NET, alias: USER, isNetworkToken: false, tokenId: "tok_rules_session_user2" };
const asSession: Identity = { net: NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_SESSION };
const asPeer: Identity = { net: NET, alias: OTHER_ALIAS, isNetworkToken: true, tokenId: T_PEER };
const asOtherNetSameAlias: Identity = { net: OTHER_NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_OTHER_NET_SAME_ALIAS };
const asNodeRow: Identity = { net: NET, alias: NODE_ROW_ALIAS, isNetworkToken: true, tokenId: T_NODE_ROW };

async function connect(id: Identity) {
  const server = new McpServer({ name: "rules-session-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "rules-session-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const first = r.content?.[0];
    if (!first || first.type !== "text") throw new Error(`no text result from ${name}: ${JSON.stringify(r).slice(0, 300)}`);
    return JSON.parse(first.text);
  };
  const close = async () => { await client.close(); await server.close(); };
  return { call, close };
}

const capable = (alias: string, net = NET) =>
  db.get<{ c: number }>("SELECT rules_file_capable AS c FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, net)?.c;

async function registerSession(id: Identity, alias: string, resume: string, flag: boolean) {
  const c = await connect(id);
  try {
    return await c.call("report_status", { resume_id: resume, alias, status: "idle", agent: "claude-code", ...(flag ? { rules_file_capable: true } : {}) });
  } finally { await c.close(); }
}

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

describe("rules_file_capable is set only by the session's own node token", () => {
  test("bound node token sets it; a later report without the field does not clear it", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    expect(capable(SESSION_ALIAS)).toBe(1);
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, false);
    expect(capable(SESSION_ALIAS)).toBe(1);
  }, 20_000);

  // The hub already refuses these reports outright (network_token_required /
  // alias_identity_mismatch); the bound-token check on the UPDATE is defence in
  // depth. The real session row is registered first so "stays 0" is not vacuous.
  test("a user token reporting for the alias is refused and cannot mark it capable", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, false);
    expect(capable(SESSION_ALIAS)).toBe(0);
    const r = await registerSession(asUser, SESSION_ALIAS, SESSION_RESUME, true);
    expect(r).toMatchObject({ ok: false, error: "network_token_required" });
    expect(capable(SESSION_ALIAS)).toBe(0);
  }, 20_000);

  test("another node's token is refused and cannot mark someone else's session capable", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, false);
    const r = await registerSession(asPeer, SESSION_ALIAS, SESSION_RESUME, true);
    expect(r).toMatchObject({ ok: false, error: "alias_identity_mismatch" });
    expect(capable(SESSION_ALIAS)).toBe(0);
  }, 20_000);
});

describe("read/write by alias reach a session with no nodes row", () => {
  test("read round trip: enqueue by alias → session pulls with its own token → ack → done", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("read_node_rules_file", { alias: SESSION_ALIAS });
      expect(enq).toMatchObject({ ok: true, op: "read" });
      expect(db.get<{ node_id: string }>("SELECT node_id FROM node_rules_requests WHERE request_id = ?1", enq.request_id)?.node_id).toBe(`session:${SESSION_ALIAS}`);
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "read" });
      expect(await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "CLAUDE.md", exists: true, content: "# rules\n" })).toMatchObject({ ok: true, status: "done" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "done", file_name: "CLAUDE.md", exists: true, content: "# rules\n" });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("write carries content to the session", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("write_node_rules_file", { alias: SESSION_ALIAS, content: "new body\n" });
      expect(enq).toMatchObject({ ok: true, op: "write" });
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "write", content: "new body\n" });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("alias with neither a node row nor a capable session is refused before any row is written", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, false);
    const u = await connect(asUser);
    try {
      expect(await u.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "rules_file_target_not_found" });
      expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM node_rules_requests WHERE network_id = ?1", NET)?.c).toBe(0);
    } finally { await u.close(); }
  }, 20_000);

  test("network isolation: same alias in another network neither pulls nor acks; other-network user cannot enqueue", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const x = await connect(asOtherNetSameAlias);
    const ou = await connect(asOtherNetUser);
    try {
      const enq = await u.call("read_node_rules_file", { alias: SESSION_ALIAS });
      expect(enq.ok).toBe(true);
      expect(await x.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
      expect(await x.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "stolen" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(db.get<{ s: string }>("SELECT status AS s FROM node_rules_requests WHERE request_id = ?1", enq.request_id)?.s).toBe("pending");
      expect(await ou.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "rules_file_target_not_found" });
    } finally { await u.close(); await x.close(); await ou.close(); }
  }, 20_000);

  test("a peer node in the same network cannot pull or ack the session's request", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const p = await connect(asPeer);
    try {
      const enq = await u.call("read_node_rules_file", { alias: SESSION_ALIAS });
      expect(await p.call("get_rules_file_request", {})).toEqual({ ok: true, request: null });
      expect(await p.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "x" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
    } finally { await u.close(); await p.close(); }
  }, 20_000);

  test("alias that has a nodes row resolves to that node_id (original queue key)", async () => {
    const u = await connect(asUser);
    const n = await connect(asNodeRow);
    try {
      const enq = await u.call("read_node_rules_file", { alias: NODE_ROW_ALIAS });
      expect(enq.ok).toBe(true);
      expect(db.get<{ node_id: string }>("SELECT node_id FROM node_rules_requests WHERE request_id = ?1", enq.request_id)?.node_id).toBe(NODE_ROW_ID);
      expect((await n.call("get_rules_file_request", {})).request?.request_id).toBe(enq.request_id);
    } finally { await u.close(); await n.close(); }
  }, 20_000);
});
