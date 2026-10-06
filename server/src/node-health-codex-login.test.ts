// #594 step 1 — report_status.health.codex_login (non-secret codex login fingerprint +
// "shared with N other nodes on this host"). Additive on the #448 health channel.
//
// 跑法：cd server && COMMHUB_DB=/tmp/node-health-codex-login.db bun test src/node-health-codex-login.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { clearNodeHealthStore, readNodeHealth } from "./node-health-store.js";
import { degradedLayers } from "./node-health-guard.js";

const NET = "net_health_codex_login_t";
const OWNER = "u_hcl_owner";
const NODE_A = "hcl-node-a";
const NODE_B = "hcl-node-b";
const NODE_A_ID = "node_hcl_a";
const NODE_B_ID = "node_hcl_b";
const T_A = "tok_hcl_node_a";
const T_B = "tok_hcl_node_b";

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

const LOGIN = { fingerprint: "1a2b3c4d", shared_with: 2, shared_home_with: 1, codex_home: "/srv/ws/.anet/nodes/a/codex-home" };

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("#594 report_status.health.codex_login passthrough", () => {
  test("well-formed codex_login is kept next to the #448 layers and readable", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      const r = await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: { bridge: "ok", model_auth: "ok", codex_login: LOGIN } });
      expect(r.isError).toBe(false);
    } finally { await a.close(); }
    expect(readNodeHealth(NET, NODE_A)?.health.codex_login).toEqual(LOGIN);
  });

  test("codex_login alone (codex-sdk runtime, no #448 monitor) is accepted", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: { codex_login: { fingerprint: "deadbeef", shared_with: 0 } } });
    } finally { await a.close(); }
    expect(readNodeHealth(NET, NODE_A)?.health.codex_login).toEqual({ fingerprint: "deadbeef", shared_with: 0 });
  });

  test("🔴 a shared login is NOT a degraded layer — dispatch must not refuse because of it", () => {
    expect(degradedLayers({ bridge: "ok", model_auth: "ok", codex_login: LOGIN } as any)).toEqual([]);
  });

  test("🔴 anything that is not an 8-hex fingerprint is dropped (a token pasted there never gets stored), report still accepted", async () => {
    const a = await connectAs(NODE_A, T_A);
    const bads = [
      { fingerprint: "FAKE-REFRESH-TOKEN-should-never-be-stored", shared_with: 1 },
      { fingerprint: "a".repeat(64), shared_with: 1 },
      { fingerprint: "1A2B3C4D", shared_with: 1 },
      { fingerprint: "1a2b3c4d", shared_with: -1 },
      { fingerprint: "1a2b3c4d", shared_with: 1.5 },
      { fingerprint: "1a2b3c4d" },
      "1a2b3c4d",
    ];
    try {
      for (const bad of bads) {
        const r = await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: { bridge: "ok", model_auth: "ok", codex_login: bad } });
        expect(r.isError).toBe(false);
        const h = readNodeHealth(NET, NODE_A)?.health;
        expect(h?.model_auth).toBe("ok");
        expect(h?.codex_login).toBeUndefined();
        expect(JSON.stringify(h)).not.toContain("FAKE-REFRESH-TOKEN");
      }
    } finally { await a.close(); }
    expect(db.get<{ s: string }>("SELECT status AS s FROM sessions WHERE alias = ?1 AND network_id = ?2", NODE_A, NET)?.s).toBe("idle");
  });

  test("bad optional sub-fields degrade alone: control characters in codex_home are dropped, the rest kept", async () => {
    const a = await connectAs(NODE_A, T_A);
    try {
      await a.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: { codex_login: { fingerprint: "1a2b3c4d", shared_with: 1, shared_home_with: "x", codex_home: "/x\n; rm -rf /" } } });
    } finally { await a.close(); }
    expect(readNodeHealth(NET, NODE_A)?.health.codex_login).toEqual({ fingerprint: "1a2b3c4d", shared_with: 1 });
  });

  test("another node's token cannot set this node's codex_login", async () => {
    const b = await connectAs(NODE_B, T_B);
    try {
      await b.call({ resume_id: `sdk-${NODE_A_ID}`, alias: NODE_A, status: "idle", node_id: NODE_A_ID, health: { codex_login: LOGIN } });
    } finally { await b.close(); }
    expect(readNodeHealth(NET, NODE_A)).toBeNull();
  });
});
