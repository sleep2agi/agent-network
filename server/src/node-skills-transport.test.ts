// Node skills view — list_node_skills / read_node_skill ride the rules-file
// queue + doorbell (ops skills_list / skill_read).
//
// Hub-side contract verified here:
//   1. report_status { skills_capable: true } is sticky and set only by the
//      session's own bound node token.
//   2. list_node_skills / read_node_skill reach a session with no nodes row by
//      alias; the node pulls with its own token; read carries the skill NAME
//      (never a path) in the pulled request; results come back through
//      get_rules_file_result for both ops.
//   3. Bad skill names are refused before any request row exists.
//   4. A session that can serve rules files but did not report skills_capable is
//      refused up front for skills ops (skills_target_not_found).
//   5. Separate single-flight lanes: a pending rules read does not block a skills
//      list and vice versa; a second skills request while one is pending is refused.
//   6. Network isolation and foreign acks are ignored.
//
// 跑法：cd server && COMMHUB_DB=/tmp/skills-session.db bun test src/node-skills-transport.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_skills_session";
const OTHER_NET = "net_skills_session_other";
const USER = "u_skills_session_owner";
const SESSION_ALIAS = "skills-session-cc";
const SESSION_RESUME = "cc-skills-session-1";
const OTHER_ALIAS = "skills-session-peer";
const NODE_ROW_ALIAS = "skills-session-noderow";
const NODE_ROW_ID = "node_skills_session_noderow";
const T_SESSION = "tok_skills_session_cc";
const T_PEER = "tok_skills_session_peer";
const T_OTHER_NET_SAME_ALIAS = "tok_skills_session_other_net";
const T_NODE_ROW = "tok_skills_session_noderow";

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
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_skills_session_user" };
const asOtherNetUser: Identity = { net: OTHER_NET, alias: USER, isNetworkToken: false, tokenId: "tok_skills_session_user2" };
const asSession: Identity = { net: NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_SESSION };
const asPeer: Identity = { net: NET, alias: OTHER_ALIAS, isNetworkToken: true, tokenId: T_PEER };
const asOtherNetSameAlias: Identity = { net: OTHER_NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_OTHER_NET_SAME_ALIAS };
const asNodeRow: Identity = { net: NET, alias: NODE_ROW_ALIAS, isNetworkToken: true, tokenId: T_NODE_ROW };

async function connect(id: Identity) {
  const server = new McpServer({ name: "skills-session-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "skills-session-client", version: "1" });
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
  db.get<{ c: number }>("SELECT skills_capable AS c FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, net)?.c;
const rowCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_rules_requests WHERE network_id = ?1", NET)!.n;

async function registerSession(id: Identity, alias: string, resume: string, flag: boolean) {
  const c = await connect(id);
  try {
    return await c.call("report_status", { resume_id: resume, alias, status: "idle", agent: "claude-code", ...(flag ? { rules_file_capable: true, skills_capable: true } : {}) });
  } finally { await c.close(); }
}

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

async function reportRulesOnly(id: Identity, alias: string, resume: string) {
  const c = await connect(id);
  try { return await c.call("report_status", { resume_id: resume, alias, status: "idle", agent: "claude-code", rules_file_capable: true }); }
  finally { await c.close(); }
}

describe("skills_capable is set only by the session's own node token", () => {
  test("bound token sets it; a report without it does not clear it; a peer cannot set it", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    expect(capable(SESSION_ALIAS)).toBe(1);
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, false);
    expect(capable(SESSION_ALIAS)).toBe(1);
    const r = await registerSession(asPeer, SESSION_ALIAS, SESSION_RESUME, true);
    expect(r).toMatchObject({ ok: false });
  }, 20_000);
});

describe("list / read by alias reach a session with no nodes row", () => {
  test("list round trip: enqueue → pull (no content) → ack JSON → result carries it", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("list_node_skills", { alias: SESSION_ALIAS });
      expect(enq).toMatchObject({ ok: true, op: "skills_list" });
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "skills_list" });
      const payload = JSON.stringify({ skills: [{ name: "ship", scope: "project", path_rel: ".claude/skills/ship/SKILL.md", description: "d" }] });
      expect(await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "skills", exists: true, content: payload })).toMatchObject({ ok: true, status: "done" });
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ ok: true, op: "skills_list", status: "done", content: payload });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("read round trip: the pulled request carries the skill name only", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("read_node_skill", { alias: SESSION_ALIAS, name: "ship" });
      expect(enq).toMatchObject({ ok: true, op: "skill_read" });
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "skill_read", content: "ship" });
      const payload = JSON.stringify({ name: "ship", scope: "project", path_rel: ".claude/skills/ship/SKILL.md", description: "d", content: "# ship" });
      await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "ship", exists: true, content: payload });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "done", content: payload });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("bad names are refused before any row is written", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    try {
      for (const name of ["..", ".", "../CLAUDE.md", "a/b", "a b"]) {
        expect(await u.call("read_node_skill", { alias: SESSION_ALIAS, name })).toMatchObject({ ok: false, error: "invalid_skill_name" });
      }
      expect(rowCount()).toBe(0);
    } finally { await u.close(); }
  }, 20_000);

  test("rules-capable but not skills-capable → skills_target_not_found, no row", async () => {
    await reportRulesOnly(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    try {
      expect(await u.call("list_node_skills", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "skills_target_not_found" });
      expect(rowCount()).toBe(0);
      expect(await u.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: true });
    } finally { await u.close(); }
  }, 20_000);
});

describe("single-flight lanes", () => {
  test("a pending rules read does not block a skills list; a second skills request is refused", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    try {
      expect(await u.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: true });
      const list = await u.call("list_node_skills", { alias: SESSION_ALIAS });
      expect(list).toMatchObject({ ok: true });
      expect(await u.call("read_node_skill", { alias: SESSION_ALIAS, name: "ship" })).toMatchObject({ ok: false, error: "request_in_flight", existing_request_id: list.request_id });
      expect(await u.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "request_in_flight" });
    } finally { await u.close(); }
  }, 20_000);
});

describe("isolation", () => {
  test("same alias in another network neither pulls nor acks; a peer's ack is ignored", async () => {
    await registerSession(asSession, SESSION_ALIAS, SESSION_RESUME, true);
    const u = await connect(asUser);
    const other = await connect(asOtherNetSameAlias);
    const peer = await connect(asPeer);
    try {
      const enq = await u.call("list_node_skills", { alias: SESSION_ALIAS });
      expect((await other.call("get_rules_file_request", {})).request).toBeNull();
      expect(await other.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(await peer.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "pending" });
    } finally { await u.close(); await other.close(); await peer.close(); }
  }, 20_000);
});
