import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import "./require-explicit-test-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import {
  ackOpenCodeCatalog,
  expireOpenCodeCatalogForTest,
  getOpenCodeCatalogResult,
  queueOpenCodeCatalogRead,
  resetOpenCodeCatalogForTest,
  takeOpenCodeCatalogRequest,
} from "./opencode-v2-catalog.js";
import { readOwnedOpenCodeV2Catalog } from "../../agent-node/src/runtime/opencode-v2-catalog-daemon.ts";
import { readOpenCodeV2CatalogEndpoint, writeOpenCodeV2CatalogEndpoint } from "../../agent-node/src/runtime/opencode-v2-catalog-endpoint.ts";

const NET = "net_oc_catalog";
const OTHER = "net_oc_catalog_other";
const USER = "u_oc_catalog";
const VIEWER = "u_oc_catalog_viewer";
const OUTSIDER = "u_oc_catalog_out";
const DAEMON = "node_oc_daemon";
const DAEMON_ALIAS = "oc-daemon";
const DAEMON_TOK = "tok_oc_daemon";
const V2_REQ = "cr_ocv2child";
const V2 = "node_ocv2child";
const V1 = "node_ocv1child";
const UNSAFE = "node_ocunsafechild";
const NULLDIR = "node_ocnullchild";
const PROJECT = resolve(mkdtempSync(join(tmpdir(), "oc-hub-proj-")));

function cleanup() {
  resetOpenCodeCatalogForTest();
  for (const net of [NET, OTHER]) {
    for (const table of ["node_create_requests", "audit_log", "nodes", "sessions", "api_tokens", "network_members"]) {
      try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [net]); } catch {}
    }
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [net]); } catch {}
  }
  for (const user of [USER, VIEWER, OUTSIDER]) {
    try { db.run("DELETE FROM users WHERE user_id = ?1", [user]); } catch {}
  }
}
beforeEach(cleanup);
afterAll(() => { cleanup(); rmSync(PROJECT, { recursive: true, force: true }); });

function userRow(id: string) {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [id]);
}
function member(id: string, net: string, role: string) {
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, ?3, datetime('now'))`, [id, net, role]);
}
function node(id: string, alias: string, snapshot: unknown) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-x', datetime('now'), datetime('now'), 'active')`,
    [id, alias, NET, JSON.stringify(snapshot)],
  );
}
function created(requestId: string, nodeId: string, flags: unknown, workdir: string | null) {
  node(nodeId, nodeId, {});
  db.run(
    `INSERT INTO node_create_requests
      (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, created_at, created_by_token, workdir)
     VALUES (?1, ?2, ?3, ?4, 'opencode-cli', 'fixture/fixture-model', ?5, '[]', 'succeeded', ?6, 'tok', ?7)`,
    [requestId, DAEMON, nodeId, NET, JSON.stringify(flags), Date.now(), workdir],
  );
}

function seed() {
  userRow(USER); userRow(VIEWER); userRow(OUTSIDER);
  db.run(`INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, USER]);
  db.run(`INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [OTHER, OUTSIDER]);
  member(USER, NET, "admin");
  member(VIEWER, NET, "viewer");
  member(OUTSIDER, OTHER, "admin");
  node(DAEMON, DAEMON_ALIAS, { role: "host_supervisor" });
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOK, USER, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOK}`],
  );
  created(V2_REQ, V2, { opencodeGeneration: "v2", opencodeUnsafeTools: true }, PROJECT);
  created("cr_ocv1child", V1, { opencodeGeneration: "v1" }, PROJECT);
  created("cr_ocunsafechild", UNSAFE, { opencodeGeneration: "v2", opencodeUnsafeTools: false }, PROJECT);
  created("cr_ocnullchild", NULLDIR, { opencodeGeneration: "v2", opencodeUnsafeTools: true }, null);
}

function queue(userId: string, nodeId: string, networkId: string | null = NET, callerIsNode = false) {
  return queueOpenCodeCatalogRead({ callerUserId: userId, callerIsNode, networkId, daemonNodeId: DAEMON, nodeId });
}

function handlers(userId: string, isNode: boolean, tokenId: string | null) {
  const server = new McpServer({ name: "oc-catalog-test", version: "0" }) as any;
  const out: Record<string, (args: any) => Promise<{ content: Array<{ text: string }> }>> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, d: string, schema: any, handler: any) => { out[name] = handler; return origTool(name, d, schema, handler); };
  const origRegister = server.registerTool.bind(server);
  server.registerTool = (name: string, cfg: any, handler: any) => { out[name] = handler; return origRegister(name, cfg, handler); };
  registerTools(server, undefined, NET, userId, isNode ? DAEMON_ALIAS : null, isNode, tokenId);
  return { out, server };
}
async function call(handler: (args: any) => Promise<{ content: Array<{ text: string }> }>, args: any) {
  return JSON.parse((await handler(args)).content[0]!.text);
}

function snapshot(directory = PROJECT, overrides: Record<string, unknown> = {}) {
  return {
    scope: { networkId: NET, daemonId: DAEMON, directory },
    source: "opencode-v2-api",
    state: "snapshot",
    invocationVerified: false,
    completeness: "unknown",
    observedAt: "2026-10-11T00:00:00.000Z",
    providers: [{ id: "custom", activation: "enabled" }],
    models: [{ providerId: "custom", id: "nested/model" }],
    defaultModel: { providerId: "custom", id: "nested/model" },
    ...overrides,
  };
}

describe("hub authorizes an owned OpenCode V2 catalog read", () => {
  test("member queues, daemon reads the owned loopback, ready snapshot stays unverified", async () => {
    seed();
    const user = handlers(USER, false, null);
    const queued = await call(user.out.read_opencode_catalog!, { daemon_node_id: DAEMON, node_id: V2 });
    expect(queued).toEqual({ ok: true, status: "pending", request_id: queued.request_id });
    expect(JSON.stringify(queued)).not.toContain("daemon_alias");
    const strict = await (user.server as any)._registeredTools.read_opencode_catalog.inputSchema.safeParseAsync({
      daemon_node_id: DAEMON, node_id: V2, settings: { apiKey: "sk-FAKE" }, headers: {}, body: {},
    });
    expect(strict.success).toBe(false);

    expect(takeOpenCodeCatalogRequest(queued.request_id, "node_other")).toEqual({ ok: false, error: "catalog_request_unavailable" });
    const daemon = handlers(USER, true, DAEMON_TOK);
    const pulled = await call(daemon.out.get_opencode_catalog_request!, { request_id: queued.request_id });
    expect(pulled.ok).toBe(true);
    expect(pulled.directory).toBe(PROJECT);
    for (const key of ["url", "authorization", "settings", "headers", "body"]) expect(pulled[key]).toBeUndefined();

    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      requests++;
      const url = new URL(req.url);
      const row = url.pathname === "/api/provider"
        ? [{ id: "custom", activation: "enabled", settings: { apiKey: "sk-FAKE" } }]
        : [{ providerID: "custom", id: "nested/model", headers: { Authorization: "sk-FAKE" } }];
      return Response.json({ location: { directory: PROJECT }, data: url.pathname === "/api/model/default" ? row[0] : row });
    } });
    const nodeDir = mkdtempSync(join(tmpdir(), "oc-hub-node-"));
    try {
      writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", directory: PROJECT });
      const read = await readOwnedOpenCodeV2Catalog({
        networkId: NET, daemonId: DAEMON, authorizedDirectory: pulled.directory,
        ownedProjectDirectory: PROJECT, endpoint: readOpenCodeV2CatalogEndpoint(nodeDir),
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const acked = await call(daemon.out.ack_opencode_catalog!, { request_id: queued.request_id, snapshot: read.snapshot });
      expect(acked).toEqual({ ok: true, status: "ready" });
      const got = await call(user.out.get_opencode_catalog!, { request_id: queued.request_id });
      expect(got.status).toBe("ready");
      expect(got.snapshot.invocationVerified).toBe(false);
      expect(got.snapshot.completeness).toBe("unknown");
      expect(JSON.stringify(got.snapshot)).not.toContain("sk-FAKE");
      expect(requests).toBe(3);
    } finally {
      server.stop(true);
      rmSync(nodeDir, { recursive: true, force: true });
    }
  });

  test("viewer may queue; outsider, node token, and non-v2 children may not", () => {
    seed();
    expect(queue(VIEWER, V2).ok).toBe(true);
    expect(queue(OUTSIDER, V2, NET)).toEqual({ ok: false, error: "access_denied" });
    expect(queue(OUTSIDER, V2, OTHER)).toEqual({ ok: false, error: "daemon_not_found" });
    expect(queue(USER, V2, NET, true)).toEqual({ ok: false, error: "user_token_required" });
    expect(queue(USER, V1)).toEqual({ ok: false, error: "not_opencode_v2" });
    expect(queue(USER, UNSAFE)).toEqual({ ok: false, error: "not_opencode_v2" });
    expect(queue(USER, "node_missing")).toEqual({ ok: false, error: "node_not_found" });
  });

  test("pending is not a snapshot; expiry, bad acks, and a missing endpoint stay closed", async () => {
    seed();
    const queued = queue(USER, V2);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(getOpenCodeCatalogResult({ callerUserId: USER, callerIsNode: false, networkId: NET, requestId: queued.request_id })).toEqual({
      ok: true, status: "pending", request_id: queued.request_id,
    });
    const pulled = takeOpenCodeCatalogRequest(queued.request_id, DAEMON);
    expect(pulled.ok).toBe(true);

    expect(ackOpenCodeCatalog(DAEMON, { request_id: queued.request_id, snapshot: snapshot(), settings: { apiKey: "sk-FAKE" } })).toEqual({ ok: false, error: "invalid_ack" });
    expect(ackOpenCodeCatalog(DAEMON, { request_id: queued.request_id, snapshot: snapshot(PROJECT, { invocationVerified: true }) })).toEqual({ ok: false, error: "invalid_ack" });
    expect(getOpenCodeCatalogResult({ callerUserId: USER, callerIsNode: false, networkId: NET, requestId: queued.request_id }).status).toBe("pending");

    const wrongDir = ackOpenCodeCatalog(DAEMON, { request_id: queued.request_id, snapshot: snapshot("/tmp/other-project") });
    expect(wrongDir).toEqual({ ok: true, status: "failed", error: "invalid_response" });
    expect(getOpenCodeCatalogResult({ callerUserId: USER, callerIsNode: false, networkId: NET, requestId: queued.request_id })).toMatchObject({
      ok: false, status: "failed", error: "invalid_response",
    });

    const again = queue(USER, V2);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    takeOpenCodeCatalogRequest(again.request_id, DAEMON);
    expect(ackOpenCodeCatalog(DAEMON, { request_id: again.request_id, error: "unavailable" })).toEqual({ ok: true, status: "failed", error: "unavailable" });
    expect(getOpenCodeCatalogResult({ callerUserId: USER, callerIsNode: false, networkId: NET, requestId: again.request_id })).toMatchObject({
      ok: false, status: "failed", error: "unavailable",
    });

    const waiting = queue(USER, NULLDIR);
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expireOpenCodeCatalogForTest(waiting.request_id);
    expect(getOpenCodeCatalogResult({ callerUserId: USER, callerIsNode: false, networkId: NET, requestId: waiting.request_id })).toMatchObject({
      ok: false, status: "expired", error: "unavailable",
    });
  });
});
