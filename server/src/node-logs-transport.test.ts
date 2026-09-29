// Node run-log view — tail_node_logs rides the rules-file queue + doorbell (op logs_tail).
//
// Hub-side contract verified here:
//   1. report_status { logs_capable: true } is sticky and set only by the node's
//      own token; /api/status-shaped rows expose it.
//   2. The pulled request carries only the normalised filter JSON — no path field
//      exists anywhere in the tool schema; unknown args are dropped.
//   3. Who may ask: user logins only (node tokens refused); the network owner/admin,
//      or the node's owner (nodes.owner_user_id). A member who does not own the
//      node, a viewer, and a user of another network are refused before any row.
//   4. Who may read: only the token that asked (like the project folder).
//   5. Storage: the result is handed out ONCE — the first terminal read purges
//      result_content and the filter JSON; the second read says content_purged.
//      An unread terminal result is purged by the sweep after LOGS_CONTENT_TTL_MS.
//   6. Own single-flight lane; logs acks may carry up to 1 MiB.
//
// 跑法：cd server && COMMHUB_DB=/tmp/logs-transport.db bun test src/node-logs-transport.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { LOGS_CONTENT_TTL_MS, sweepNodeRequestContent } from "./node-request-retention.js";

const NET = "net_logs_t";
const OTHER_NET = "net_logs_t_other";
const OWNER = "u_logs_net_owner";
const MEMBER = "u_logs_member_owns_a";
const MEMBER2 = "u_logs_member_plain";
const VIEWER = "u_logs_viewer";
const OUTSIDER = "u_logs_outsider";
const NODE_A = "logs-node-a";
const NODE_B = "logs-node-b";
const NODE_A_ID = "node_logs_a";
const NODE_B_ID = "node_logs_b";
const T_A = "tok_logs_node_a";
const T_B = "tok_logs_node_b";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    for (const t of ["node_rules_requests", "sessions", "nodes", "api_tokens", "network_members", "networks"]) {
      try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [net]); } catch {}
    }
  }
  for (const u of [OWNER, MEMBER, MEMBER2, VIEWER, OUTSIDER]) {
    try { db.run("DELETE FROM users WHERE user_id = ?1", [u]); } catch {}
  }
}

function seedWorld() {
  for (const u of [OWNER, MEMBER, MEMBER2, VIEWER, OUTSIDER]) {
    db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [u, u]);
  }
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET, NET, OWNER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [OTHER_NET, OTHER_NET, OUTSIDER]);
  const member = (u: string, net: string, role: string) =>
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, ?3, datetime('now'))`, [u, net, role]);
  member(OWNER, NET, "owner");
  member(MEMBER, NET, "member");
  member(MEMBER2, NET, "member");
  member(VIEWER, NET, "viewer");
  member(OUTSIDER, OTHER_NET, "owner");
  const node = (id: string, alias: string, owner: string | null) => db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`,
    [id, alias, alias, NET, owner],
  );
  node(NODE_A_ID, NODE_A, MEMBER);
  node(NODE_B_ID, NODE_B, OWNER);
  const tok = (id: string, alias: string, bound: string) => db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, ?6)`,
    [id, OWNER, NET, `node:${alias}`, `hash_${id}`, bound],
  );
  tok(T_A, NODE_A, NODE_A_ID);
  tok(T_B, NODE_B, NODE_B_ID);
}

type Identity = { net: string | null; user: string; alias: string; isNetworkToken: boolean; tokenId: string };
const asOwner: Identity = { net: null, user: OWNER, alias: OWNER, isNetworkToken: false, tokenId: "tok_logs_owner_login" };
const asOwnerOtherLogin: Identity = { ...asOwner, tokenId: "tok_logs_owner_login_2" };
const asMember: Identity = { net: null, user: MEMBER, alias: MEMBER, isNetworkToken: false, tokenId: "tok_logs_member_login" };
const asMember2: Identity = { net: null, user: MEMBER2, alias: MEMBER2, isNetworkToken: false, tokenId: "tok_logs_member2_login" };
const asViewer: Identity = { net: null, user: VIEWER, alias: VIEWER, isNetworkToken: false, tokenId: "tok_logs_viewer_login" };
const asOutsider: Identity = { net: null, user: OUTSIDER, alias: OUTSIDER, isNetworkToken: false, tokenId: "tok_logs_outsider_login" };
const asA: Identity = { net: NET, user: OWNER, alias: NODE_A, isNetworkToken: true, tokenId: T_A };
const asB: Identity = { net: NET, user: OWNER, alias: NODE_B, isNetworkToken: true, tokenId: T_B };

async function connect(id: Identity) {
  const server = new McpServer({ name: "logs-test", version: "1" });
  registerTools(server, undefined, id.net, id.user, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "logs-client", version: "1" });
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

const rowCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_rules_requests WHERE network_id = ?1", NET)!.n;
const row = (id: string) => db.get<any>("SELECT op, content, result_content, content_purged_at FROM node_rules_requests WHERE request_id = ?1", id);
const SAMPLE = JSON.stringify({ files: ["2026-09-29.log"], lines: [{ ts: 1, level: "info", text: "[10:00:00] [INFO ] [x] hello", key: "2026-09-29.log:0" }], truncated: false, matched: 1, now_ts: 2 });

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

describe("logs_capable", () => {
  test("set by the node's own token, sticky, not settable by a user login", async () => {
    const a = await connect(asA);
    try {
      await a.call("report_status", { resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, logs_capable: true });
      await a.call("report_status", { resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID });
    } finally { await a.close(); }
    expect(db.get<{ c: number }>("SELECT logs_capable AS c FROM sessions WHERE alias = ?1 AND network_id = ?2", NODE_A, NET)?.c).toBe(1);
    const u = await connect(asOwner);
    try {
      await u.call("report_status", { resume_id: "user-logs-report", alias: NODE_B, status: "idle", network_id: NET, logs_capable: true });
    } finally { await u.close(); }
    expect(db.get<{ c: number }>("SELECT logs_capable AS c FROM sessions WHERE alias = ?1 AND network_id = ?2", NODE_B, NET)?.c ?? 0).toBe(0);
  }, 20_000);
});

describe("round trip", () => {
  test("the node pulls only the normalised filter JSON (no path), acks, the asker reads it once", async () => {
    const u = await connect(asOwner);
    const a = await connect(asA);
    try {
      const enq = await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET, lines: 99999 > 2000 ? 2000 : 1, level: "warn", grep: "boom", since_ts: 5, path: "/etc/passwd" });
      expect(enq).toMatchObject({ ok: true, op: "logs_tail" });
      const pulled = (await a.call("get_rules_file_request", {})).request;
      expect(pulled.op).toBe("logs_tail");
      expect(JSON.parse(pulled.content)).toEqual({ lines: 2000, level: "warn", grep: "boom", since_ts: 5 });
      expect(pulled.content).not.toContain("passwd");
      expect(await a.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "logs", exists: true, content: SAMPLE })).toMatchObject({ ok: true, status: "done" });

      const first = await u.call("get_rules_file_result", { request_id: enq.request_id, network_id: NET });
      expect(first).toMatchObject({ ok: true, op: "logs_tail", status: "done", content: SAMPLE });
      // Read-once: purged in the same call, including the filter JSON.
      expect(row(enq.request_id)).toMatchObject({ result_content: null, content: null });
      expect(row(enq.request_id).content_purged_at).toBeGreaterThan(0);
      const second = await u.call("get_rules_file_result", { request_id: enq.request_id, network_id: NET });
      expect(second.content).toBeUndefined();
      expect(second.content_purged).toBe(true);
    } finally { await u.close(); await a.close(); }
  }, 20_000);

  test("lines above 2000 are refused by the schema; bad level refused", async () => {
    const u = await connect(asOwner);
    try {
      expect((await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET, lines: 2001 })).ok).not.toBe(true);
      expect((await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET, level: "debug" })).ok).not.toBe(true);
      expect(rowCount()).toBe(0);
    } finally { await u.close(); }
  }, 20_000);
});

describe("who may ask", () => {
  test("node tokens are refused — for other nodes and for themselves", async () => {
    const a = await connect(asA);
    try {
      expect(await a.call("tail_node_logs", { node_id: NODE_B_ID })).toMatchObject({ ok: false, error: "node_token_cannot_read_logs" });
      expect(await a.call("tail_node_logs", { node_id: NODE_A_ID })).toMatchObject({ ok: false, error: "node_token_cannot_read_logs" });
      expect(rowCount()).toBe(0);
    } finally { await a.close(); }
  }, 20_000);

  test("node owner yes; plain member no; viewer no; network owner yes", async () => {
    const m = await connect(asMember);
    const m2 = await connect(asMember2);
    const v = await connect(asViewer);
    const o = await connect(asOwner);
    try {
      expect(await m.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET })).toMatchObject({ ok: true });
      expect(await m.call("tail_node_logs", { node_id: NODE_B_ID, network_id: NET })).toMatchObject({ ok: false, error: "logs_permission_denied" });
      expect(await m2.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET })).toMatchObject({ ok: false, error: "logs_permission_denied" });
      expect((await v.call("tail_node_logs", { node_id: NODE_B_ID, network_id: NET })).ok).toBe(false);
      expect(await o.call("tail_node_logs", { node_id: NODE_B_ID, network_id: NET })).toMatchObject({ ok: true });
      expect(rowCount()).toBe(2);
    } finally { await m.close(); await m2.close(); await v.close(); await o.close(); }
  }, 20_000);

  test("a user of another network is refused (cross network)", async () => {
    const x = await connect(asOutsider);
    try {
      const r1 = await x.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET });
      expect(r1.ok).toBe(false);
      const r2 = await x.call("tail_node_logs", { node_id: NODE_A_ID, network_id: OTHER_NET });
      expect(r2).toMatchObject({ ok: false, error: "cross_network_node" });
      expect(rowCount()).toBe(0);
    } finally { await x.close(); }
  }, 20_000);
});

describe("who may read", () => {
  test("only the login that asked; another login of the same user, node tokens and the serving node cannot", async () => {
    const u = await connect(asOwner);
    const other = await connect(asOwnerOtherLogin);
    const b = await connect(asB);
    const a = await connect(asA);
    try {
      const enq = await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET });
      await a.call("get_rules_file_request", {});
      await a.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: SAMPLE });
      expect(await other.call("get_rules_file_result", { request_id: enq.request_id, network_id: NET })).toMatchObject({ ok: false, error: "request_not_found" });
      expect(await b.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      expect(await a.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      // Those refusals did not consume the read-once result.
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id, network_id: NET })).toMatchObject({ status: "done", content: SAMPLE });
    } finally { await u.close(); await other.close(); await b.close(); await a.close(); }
  }, 20_000);

  test("node B never pulls or acks node A's logs request", async () => {
    const u = await connect(asOwner);
    const a = await connect(asA);
    const b = await connect(asB);
    try {
      const enq = await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET });
      expect((await b.call("get_rules_file_request", {})).request).toBeNull();
      expect(await b.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{\"forged\":true}" })).toMatchObject({ ignored: "unknown_or_foreign_request" });
      expect((await a.call("get_rules_file_request", {})).request.request_id).toBe(enq.request_id);
    } finally { await u.close(); await a.close(); await b.close(); }
  }, 20_000);
});

describe("storage and lanes", () => {
  test("an unread terminal result is purged by the sweep after the logs TTL; other ops keep theirs", async () => {
    const u = await connect(asOwner);
    const a = await connect(asA);
    try {
      const enq = await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET });
      const rules = await u.call("read_node_rules_file", { node_id: NODE_A_ID, network_id: NET });
      await a.call("get_rules_file_request", {});
      await a.call("get_rules_file_request", {});
      await a.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: SAMPLE });
      await a.call("ack_rules_file_request", { request_id: rules.request_id, status: "done", content: "# rules" });
      sweepNodeRequestContent(Date.now() + LOGS_CONTENT_TTL_MS - 5_000);
      expect(row(enq.request_id).result_content).toBe(SAMPLE);
      sweepNodeRequestContent(Date.now() + LOGS_CONTENT_TTL_MS + 5_000);
      expect(row(enq.request_id)).toMatchObject({ result_content: null, content: null });
      expect(row(rules.request_id).result_content).toBe("# rules");
    } finally { await u.close(); await a.close(); }
  }, 20_000);

  test("own single-flight lane; a 1 MiB-class ack is accepted", async () => {
    const u = await connect(asOwner);
    const a = await connect(asA);
    try {
      expect(await u.call("list_node_files", { node_id: NODE_A_ID, network_id: NET })).toMatchObject({ ok: true });
      const first = await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET });
      expect(first).toMatchObject({ ok: true });
      expect(await u.call("tail_node_logs", { node_id: NODE_A_ID, network_id: NET })).toMatchObject({ ok: false, error: "request_in_flight", existing_request_id: first.request_id });
      await a.call("get_rules_file_request", {});
      await a.call("get_rules_file_request", {});
      const big = "x".repeat(700 * 1024);
      expect(await a.call("ack_rules_file_request", { request_id: first.request_id, status: "done", content: big })).toMatchObject({ ok: true, status: "done" });
    } finally { await u.close(); await a.close(); }
  }, 20_000);
});
