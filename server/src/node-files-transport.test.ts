// Project folder view — list_node_files / read_node_file ride the rules-file
// queue + doorbell (ops files_list / file_read).
//
// Hub-side contract verified here:
//   1. report_status { files_capable: true } is sticky and set only by the
//      session's own node token (bound or legacy-unbound, same rule as skills).
//   2. Both tools reach a session with no nodes row by alias; the pulled
//      request carries the normalized RELATIVE path; results come back through
//      get_rules_file_result.
//   3. Absolute paths, `..`, `~`, drive letters, backslashes and NUL are refused
//      before any request row exists (the node re-checks; this is the first wall).
//   4. A node token may not enqueue a files op (it would read another node's
//      disk), and only the token that asked may read a files result.
//   5. A token bound to node A never pulls or acks node B's files request; an
//      unbound legacy token falls back to its alias exactly as it does for skills.
//   6. Its own single-flight lane; rules-capable-only sessions are refused.
//   7. Files acks may carry up to 1 MiB (escaped JSON of a 256 KiB file); rules
//      acks keep their 256 KiB cap.
//
// 跑法：cd server && COMMHUB_DB=/tmp/files-transport.db bun test src/node-files-transport.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_files_session";
const OTHER_NET = "net_files_session_other";
const USER = "u_files_session_owner";
const SESSION_ALIAS = "files-session-cc";
const SESSION_RESUME = "cc-files-session-1";
const PEER_ALIAS = "files-session-peer";
const NODE_A = "files-node-a";
const NODE_B = "files-node-b";
const NODE_A_ID = "node_files_a";
const NODE_B_ID = "node_files_b";
const LEGACY_ALIAS = "files-node-legacy";
const LEGACY_ID = "node_files_legacy";
const T_SESSION = "tok_files_session_cc";
const T_PEER = "tok_files_session_peer";
const T_OTHER_NET_SAME_ALIAS = "tok_files_session_other_net";
const T_A = "tok_files_node_a";
const T_B = "tok_files_node_b";
const T_LEGACY = "tok_files_node_legacy";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    try { db.run("DELETE FROM node_rules_requests WHERE network_id = ?1", [net]); } catch {}
    try { db.run("DELETE FROM rename_txn WHERE network_id = ?1", [net]); } catch {}
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
  const tok = (id: string, net: string, alias: string, bound: string | null = null) => db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, ?6)`,
    [id, USER, net, `node:${alias}`, `hash_${id}`, bound],
  );
  const node = (id: string, alias: string) => db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [id, alias, alias, NET],
  );
  node(NODE_A_ID, NODE_A);
  node(NODE_B_ID, NODE_B);
  node(LEGACY_ID, LEGACY_ALIAS);
  tok(T_SESSION, NET, SESSION_ALIAS);
  tok(T_PEER, NET, PEER_ALIAS);
  tok(T_OTHER_NET_SAME_ALIAS, OTHER_NET, SESSION_ALIAS);
  tok(T_A, NET, NODE_A, NODE_A_ID);
  tok(T_B, NET, NODE_B, NODE_B_ID);
  tok(T_LEGACY, NET, LEGACY_ALIAS, null);
}

type Identity = { net: string; alias: string; isNetworkToken: boolean; tokenId: string };
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_files_session_user" };
const asUserOtherLogin: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_files_session_user_other_login" };
const asSession: Identity = { net: NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_SESSION };
const asPeer: Identity = { net: NET, alias: PEER_ALIAS, isNetworkToken: true, tokenId: T_PEER };
const asOtherNetSameAlias: Identity = { net: OTHER_NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_OTHER_NET_SAME_ALIAS };
const asA: Identity = { net: NET, alias: NODE_A, isNetworkToken: true, tokenId: T_A };
const asB: Identity = { net: NET, alias: NODE_B, isNetworkToken: true, tokenId: T_B };
const asLegacy: Identity = { net: NET, alias: LEGACY_ALIAS, isNetworkToken: true, tokenId: T_LEGACY };

async function connect(id: Identity) {
  const server = new McpServer({ name: "files-session-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "files-session-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const first = r.content?.[0];
    if (!first || first.type !== "text") throw new Error(`no text result from ${name}: ${JSON.stringify(r).slice(0, 300)}`);
    try { return JSON.parse(first.text); } catch { return { raw: first.text, isError: r.isError === true }; }
  };
  const close = async () => { await client.close(); await server.close(); };
  return { call, close };
}

const capable = (alias: string, net = NET) =>
  db.get<{ c: number }>("SELECT files_capable AS c FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, net)?.c;
const rowCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_rules_requests WHERE network_id = ?1", NET)!.n;

async function report(id: Identity, alias: string, resume: string, flags: Record<string, true>) {
  const c = await connect(id);
  try { return await c.call("report_status", { resume_id: resume, alias, status: "idle", agent: "claude-code", ...flags }); }
  finally { await c.close(); }
}
const ALL_FLAGS = { rules_file_capable: true, skills_capable: true, files_capable: true } as const;

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

describe("files_capable is set only by the session's own node token", () => {
  test("own token sets it; a later report without it does not clear it; a peer cannot set it", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    expect(capable(SESSION_ALIAS)).toBe(1);
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, {});
    expect(capable(SESSION_ALIAS)).toBe(1);
    const r = await report(asPeer, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    expect(r).toMatchObject({ ok: false });
    // A user login cannot set it either.
    await report(asUser, PEER_ALIAS, "cc-files-user-report", ALL_FLAGS);
    expect(capable(PEER_ALIAS) ?? 0).toBe(0);
  }, 20_000);

  test("a stale process whose report is rewritten to a renamed alias does not grant that alias the flag", async () => {
    const NEW_ALIAS = "files-session-renamed";
    db.run(
      `INSERT INTO rename_txn (txn_id, network_id, old_alias, new_alias, status, committed_at) VALUES ('txn_files_rename', ?1, ?2, ?3, 'committed', datetime('now'))`,
      [NET, PEER_ALIAS, NEW_ALIAS],
    );
    // Token still carries the old alias; the hub rewrites the report to NEW_ALIAS.
    const r = await report(asPeer, PEER_ALIAS, "cc-files-renamed", ALL_FLAGS);
    expect(r.ok).toBe(true);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE alias = ?1 AND network_id = ?2", NEW_ALIAS, NET)!.n).toBe(1);
    expect(capable(NEW_ALIAS)).toBe(0);
  }, 20_000);
});

describe("list / read by alias reach a session with no nodes row", () => {
  test("list: pulled request carries the normalized relative path; result comes back", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("list_node_files", { alias: SESSION_ALIAS, path: "./src//lib/" });
      expect(enq).toMatchObject({ ok: true, op: "files_list" });
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "files_list", content: "src/lib" });
      const payload = JSON.stringify({ path: "src/lib", entries: [{ name: "a.ts", type: "file", size: 3, mtime: 1 }], truncated: false, total: 1 });
      expect(await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "files", exists: true, content: payload })).toMatchObject({ ok: true, status: "done" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, op: "files_list", status: "done", content: payload });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("list with no path targets the root (empty content)", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("list_node_files", { alias: SESSION_ALIAS });
      expect((await s.call("get_rules_file_request", {})).request).toEqual({ request_id: enq.request_id, op: "files_list", content: "" });
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("read round trip", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("read_node_file", { alias: SESSION_ALIAS, path: "docs/README.md" });
      expect(enq).toMatchObject({ ok: true, op: "file_read" });
      expect((await s.call("get_rules_file_request", {})).request).toEqual({ request_id: enq.request_id, op: "file_read", content: "docs/README.md" });
      const payload = JSON.stringify({ path: "docs/README.md", name: "README.md", kind: "text", size: 6, content: "# hi\n" });
      await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "README.md", exists: true, content: payload });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "done", content: payload });
    } finally { await u.close(); await s.close(); }
  }, 20_000);
});

describe("path validation happens before any row is written", () => {
  test("absolute, .., ~, drive letters, backslashes, NUL, and an empty read path are refused", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    try {
      const bad = ["/etc/passwd", "../outside", "a/../../b", "src/..", "~/.ssh/id_rsa", "C:/Windows", "a\\b", "..\\x", "a\u0000b", "x".repeat(1025)];
      for (const path of bad) {
        // Over-long paths are stopped by the zod schema (an MCP input error); the rest by invalid_path.
        const r = await u.call("read_node_file", { alias: SESSION_ALIAS, path });
        expect(r.ok).not.toBe(true);
        if (path.length <= 1024) expect(r).toMatchObject({ ok: false, error: "invalid_path" });
        const l = await u.call("list_node_files", { alias: SESSION_ALIAS, path });
        expect(l.ok).not.toBe(true);
      }
      expect(await u.call("read_node_file", { alias: SESSION_ALIAS, path: "/" })).toMatchObject({ ok: false, error: "invalid_path" });
      expect(await u.call("read_node_file", { alias: SESSION_ALIAS, path: "./" })).toMatchObject({ ok: false, error: "invalid_path" });
      expect(rowCount()).toBe(0);
    } finally { await u.close(); }
  }, 20_000);
});

describe("who may ask, and who may read the answer", () => {
  test("a node token cannot enqueue a files op on another node (or itself)", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const a = await connect(asA);
    try {
      expect(await a.call("list_node_files", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "node_token_cannot_browse_files" });
      expect(await a.call("read_node_file", { node_id: NODE_B_ID, path: ".env" })).toMatchObject({ ok: false, error: "node_token_cannot_browse_files" });
      expect(await a.call("list_node_files", { node_id: NODE_A_ID })).toMatchObject({ ok: false, error: "node_token_cannot_browse_files" });
      expect(rowCount()).toBe(0);
    } finally { await a.close(); }
  }, 20_000);

  test("only the token that asked can read a files result; node tokens never can", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const other = await connect(asUserOtherLogin);
    const s = await connect(asSession);
    const a = await connect(asA);
    try {
      const enq = await u.call("read_node_file", { alias: SESSION_ALIAS, path: "notes.txt" });
      await s.call("get_rules_file_request", {});
      await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: JSON.stringify({ path: "notes.txt", kind: "text", content: "x" }) });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "done" });
      expect(await other.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      expect(await a.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      // The serving session itself cannot read the stored result back through the client tool either.
      expect(await s.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
    } finally { await u.close(); await other.close(); await s.close(); await a.close(); }
  }, 20_000);

  test("rules/skills results stay readable by any writer of the network (unchanged)", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const other = await connect(asUserOtherLogin);
    try {
      const enq = await u.call("list_node_skills", { alias: SESSION_ALIAS });
      expect(await other.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "pending" });
    } finally { await u.close(); await other.close(); }
  }, 20_000);
});

describe("a token bound to node A cannot touch node B's files request", () => {
  test("B's request: A pulls nothing, A's ack is ignored, B pulls and acks it", async () => {
    const u = await connect(asUser);
    const a = await connect(asA);
    const b = await connect(asB);
    try {
      const enq = await u.call("read_node_file", { node_id: NODE_B_ID, path: "secret-plan.md" });
      expect(enq).toMatchObject({ ok: true });
      expect((await a.call("get_rules_file_request", {})).request).toBeNull();
      expect(await a.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{\"forged\":true}" })).toMatchObject({ ok: true, ignored: "unknown_or_foreign_request" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "pending" });
      expect((await b.call("get_rules_file_request", {})).request).toEqual({ request_id: enq.request_id, op: "file_read", content: "secret-plan.md" });
      expect(await b.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ok: true, status: "done" });
    } finally { await u.close(); await a.close(); await b.close(); }
  }, 20_000);

  test("same alias in another network neither pulls nor acks; a peer's ack is ignored", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const other = await connect(asOtherNetSameAlias);
    const peer = await connect(asPeer);
    try {
      const enq = await u.call("list_node_files", { alias: SESSION_ALIAS });
      expect((await other.call("get_rules_file_request", {})).request).toBeNull();
      expect(await other.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ignored: "unknown_or_foreign_request" });
      expect(await peer.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ignored: "unknown_or_foreign_request" });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ status: "pending" });
    } finally { await u.close(); await other.close(); await peer.close(); }
  }, 20_000);

  test("an unbound legacy token gets what skills gives it: alias fallback pull + ack, and it can set its own flag", async () => {
    const u = await connect(asUser);
    const legacy = await connect(asLegacy);
    try {
      await report(asLegacy, LEGACY_ALIAS, `sdk-${LEGACY_ID}`, ALL_FLAGS);
      expect(capable(LEGACY_ALIAS)).toBe(1);
      const skills = await u.call("list_node_skills", { node_id: LEGACY_ID });
      const files = await u.call("list_node_files", { node_id: LEGACY_ID, path: "src" });
      expect(skills).toMatchObject({ ok: true });
      expect(files).toMatchObject({ ok: true });
      const first = (await legacy.call("get_rules_file_request", {})).request;
      const second = (await legacy.call("get_rules_file_request", {})).request;
      expect([first.request_id, second.request_id].sort()).toEqual([skills.request_id, files.request_id].sort());
      expect(await legacy.call("ack_rules_file_request", { request_id: files.request_id, status: "done", content: "{}" })).toMatchObject({ ok: true, status: "done" });
      expect(await legacy.call("ack_rules_file_request", { request_id: skills.request_id, status: "done", content: "{}" })).toMatchObject({ ok: true, status: "done" });
    } finally { await u.close(); await legacy.close(); }
  }, 20_000);
});

describe("lanes, capability gate and ack size", () => {
  test("files has its own single-flight lane", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    try {
      expect(await u.call("read_node_rules_file", { alias: SESSION_ALIAS })).toMatchObject({ ok: true });
      expect(await u.call("list_node_skills", { alias: SESSION_ALIAS })).toMatchObject({ ok: true });
      const list = await u.call("list_node_files", { alias: SESSION_ALIAS });
      expect(list).toMatchObject({ ok: true });
      expect(await u.call("read_node_file", { alias: SESSION_ALIAS, path: "a.txt" })).toMatchObject({ ok: false, error: "request_in_flight", existing_request_id: list.request_id });
    } finally { await u.close(); }
  }, 20_000);

  test("rules+skills capable but not files capable → files_target_not_found, no row", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, { rules_file_capable: true, skills_capable: true });
    const u = await connect(asUser);
    try {
      expect(await u.call("list_node_files", { alias: SESSION_ALIAS })).toMatchObject({ ok: false, error: "files_target_not_found" });
      expect(rowCount()).toBe(0);
    } finally { await u.close(); }
  }, 20_000);

  test("a files ack may carry up to 1 MiB; a rules ack keeps its 256 KiB cap", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME, ALL_FLAGS);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const big = JSON.stringify({ path: "big.txt", kind: "text", content: "\n".repeat(256 * 1024) });
      expect(big.length).toBeGreaterThan(256 * 1024);
      const f = await u.call("read_node_file", { alias: SESSION_ALIAS, path: "big.txt" });
      const r = await u.call("read_node_rules_file", { alias: SESSION_ALIAS });
      await s.call("get_rules_file_request", {});
      await s.call("get_rules_file_request", {});
      expect(await s.call("ack_rules_file_request", { request_id: f.request_id, status: "done", content: big })).toMatchObject({ ok: true, status: "done" });
      expect(await s.call("ack_rules_file_request", { request_id: r.request_id, status: "done", content: "x".repeat(256 * 1024 + 1) })).toMatchObject({ ok: false, error: "content_too_large" });
      const tooBig = await s.call("ack_rules_file_request", { request_id: r.request_id, status: "done", content: "x".repeat(1024 * 1024 + 1) });
      expect(tooBig.ok).not.toBe(true);
    } finally { await u.close(); await s.close(); }
  }, 20_000);
});
