// #448 — report_status.health passthrough (layered node health, report-only).
//
// Hub-side contract verified here:
//   1. A well-formed `health` from the node's own token is kept (memory-only) and readable.
//   2. Malformed `health` never rejects the report — the node stays online, health reads as null.
//   3. Another node / a user login cannot speak for this node's health.
//   4. Stale (> TTL) health reads as null, never as "healthy".
//
// 跑法：cd server && COMMHUB_DB=/tmp/node-health.db bun test src/node-health-passthrough.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { clearNodeHealthStore, NODE_HEALTH_TTL_MS, readNodeHealth, recordNodeHealth } from "./node-health-store.js";

const NET = "net_health_t";
const OWNER = "u_health_owner";
const NODE_A = "health-node-a";
const NODE_B = "health-node-b";
const NODE_A_ID = "node_health_a";
const NODE_B_ID = "node_health_b";
const T_A = "tok_health_node_a";
const T_B = "tok_health_node_b";

function cleanup() {
  for (const t of ["sessions", "nodes", "api_tokens", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [OWNER]); } catch {}
  clearNodeHealthStore();
}
function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [OWNER, OWNER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET, NET, OWNER]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [OWNER, NET]);
  for (const [id, alias, tok] of [[NODE_A_ID, NODE_A, T_A], [NODE_B_ID, NODE_B, T_B]]) {
    db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`, [id, alias, alias, NET, OWNER]);
    db.run(`INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, ?6)`, [tok, OWNER, NET, `node:${alias}`, `hash_${tok}`, id]);
  }
}

async function connectAs(alias: string, tokenId: string) {
  const server = new McpServer({ name: "health-test", version: "1" });
  registerTools(server, undefined, NET, OWNER, alias, true, tokenId);
  const client = new Client({ name: "health-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name: "report_status", arguments: args });
    return { isError: r.isError === true, body: JSON.parse(r.content?.[0]?.text ?? "null") };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const HEALTH = {
  bridge: "ok",
  app_server: { ok: false, rtt_ms: null, last_error: "connection refused" },
  tui: { ok: false, reason: "sleep-placeholder" },
  model_auth: "revoked",
};

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("#448 report_status.health passthrough", () => {
  test("node's own token: stored and readable as reported", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      const r = await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: HEALTH });
      expect(r.isError).toBe(false);
      expect(r.body.ok).not.toBe(false);
    } finally { await a.close(); }
    expect(readNodeHealth(NET, NODE_A)?.health).toEqual(HEALTH as any);
  });

  test("malformed health never rejects the report (node stays online); it reads as not reported", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      for (const bad of [42, "ok", { app_server: { ok: "yes" }, model_auth: "weird", tui: [] }, { app_server: { ok: true, rtt_ms: NaN, last_error: 5 } }]) {
        const r = await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: bad });
        expect(r.isError).toBe(false);
      }
    } finally { await a.close(); }
    expect(db.get<{ s: string }>("SELECT status AS s FROM sessions WHERE alias = ?1 AND network_id = ?2", NODE_A, NET)?.s).toBe("idle");
    // 最后一份里 app_server.ok 合法、其余两格降级成 null —— 留下的是能证实的部分,不是编出来的。
    expect(readNodeHealth(NET, NODE_A)?.health.app_server).toEqual({ ok: true, rtt_ms: null, last_error: null });
  });

  test("another node's token cannot speak for this node", async () => {
    const b = await connectAs(NODE_B, T_B);
    try {
      await b.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: HEALTH });
    } finally { await b.close(); }
    expect(readNodeHealth(NET, NODE_A)).toBeNull();
  });

  test("stale health reads as null, never as healthy", () => {
    const t0 = 1_000_000;
    recordNodeHealth(NET, NODE_A, { bridge: "ok", model_auth: "ok" }, t0);
    expect(readNodeHealth(NET, NODE_A, t0 + 1_000)?.observed_ms_ago).toBe(1_000);
    expect(readNodeHealth(NET, NODE_A, t0 + NODE_HEALTH_TTL_MS + 1)).toBeNull();
  });

  test("a report without health leaves the last one (heartbeats from older code paths do not erase it)", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: HEALTH });
      await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "working", node_id: NODE_A_ID });
    } finally { await a.close(); }
    expect(readNodeHealth(NET, NODE_A)?.health.model_auth).toBe("revoked");
  });
});
