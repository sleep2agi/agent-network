import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db, hashToken, generateId } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// RFC-026 §9.2 / #338 PR2 v2 — list_host_supervisors HANDLER tests.
//
// PR2 v1 used a mirror-SQL pattern (re-implemented the query in the test
// itself) → trivially passed but didn't exercise the handler. 通信龙 audit
// caught: that style misses the SEC-1 scope-derivation bug
// (`getNetworkId(clientNetId)` returns the unchecked client-supplied
// network_id for utok_ callers when enforceNetworkId is null, leaking
// cross-tenant daemons). This rewrite drives the registered MCP tool
// through registerTools() so the auth context is real.
//
// Covers:
//   SEC-1.1 — cross-tenant utok_ caller with foreign network_id: DENIED
//   SEC-1.2 — admin caller with own network_id: returns own daemons
//   SEC-1.3 — caller with no network_id: returns daemons in all member networks
//   masking — non-admin viewer: host_telemetry IP/cpu/mem stripped, alert_level still surfaces
//   revoked — DELETEd token row (revokeToken path): daemon excluded
//   revoked — revoked_at SET token: daemon excluded
//   self-declare — runtimes_supported/allowed_secret_keys surface from columns
//   pre-PR2 daemon — empty arrays on NULL columns (back-compat)

const NET_ALPHA = "net_lhs_alpha";
const NET_BETA = "net_lhs_beta";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; daemons?: any[]; count?: number; }

function cleanup() {
  for (const n of [NET_ALPHA, NET_BETA]) {
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM sessions WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM network_members WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [n]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id LIKE 'u_lhs_%'"); } catch {}
}

beforeEach(cleanup);
afterAll(cleanup);

function seedUser(user_id: string) {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [user_id, user_id],
  );
}
function seedNetwork(net_id: string, owner_id = "u_lhs_owner") {
  db.run(
    `INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [net_id, net_id, owner_id],
  );
}
function seedMembership(user_id: string, net_id: string, role: "owner" | "admin" | "member" | "viewer" = "member") {
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [user_id, net_id, role],
  );
}
function seedDaemon(opts: {
  network_id: string, alias: string, node_id?: string,
  role?: string,
  runtimes?: string[],
  secrets?: string[],
  sessionAgeMs?: number,
  mintToken?: boolean,
  tokenRevokedAt?: boolean,
  tokenDeleted?: boolean,
}) {
  const node_id = opts.node_id || `node_${opts.network_id}_${opts.alias}`;
  const snapshot = JSON.stringify({
    model: "claude-opus", flags: {}, role: opts.role ?? "host_supervisor",
    runtimes_supported: opts.runtimes ?? ["claude-agent-sdk"],
    allowed_secret_keys: opts.secrets ?? [],
  });
  db.run(
    `INSERT OR REPLACE INTO nodes (
      node_id, node_name, alias, network_id,
      runtimes_supported, allowed_secret_keys,
      config_snapshot, hostname,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))`,
    [node_id, opts.alias, opts.alias, opts.network_id,
     JSON.stringify(opts.runtimes ?? ["claude-agent-sdk"]),
     JSON.stringify(opts.secrets ?? []),
     snapshot, `host-${opts.alias}`],
  );
  if (opts.sessionAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.sessionAgeMs).toISOString().replace("T", " ").replace(/\..+/, "");
    db.run(
      `INSERT OR REPLACE INTO sessions (resume_id, alias, network_id, last_seen_at, status, cpu_cores, mem_total_gb, ip)
       VALUES (?1, ?2, ?3, ?4, 'idle', 8, 16, '10.0.0.5')`,
      [`s_${node_id}`, opts.alias, opts.network_id, ts],
    );
  }
  if (opts.mintToken !== false && !opts.tokenDeleted) {
    db.run(
      `INSERT OR REPLACE INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, ?6)`,
      [`tok_${node_id}`, `u_seed_${node_id}`, opts.network_id, `node:${opts.alias}`,
       `hash_${node_id}`,
       opts.tokenRevokedAt ? new Date().toISOString().replace("T", " ").replace(/\..+/, "") : null],
    );
  }
  return node_id;
}

/** Build a server with registerTools wired to a specific enforceUserId. */
function buildToolHandler(enforceUserId: string | null): ToolHandler {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  // Capture the registered tool function. The MCP SDK's server.tool stores
  // the handler internally; we intercept by overriding before registerTools.
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, _schema, handler);
  };
  // Some tools use registerTool; intercept that too
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => {
      tools[name] = handler;
      return origRegisterTool(name, _cfg, handler);
    };
  }
  registerTools(
    server,
    /* clientIP */ undefined,
    /* enforceNetworkId */ null,
    /* enforceUserId */ enforceUserId,
    /* callerAlias */ null,
    /* callerTokenIsNetwork */ false,
    /* callerTokenId */ null,
  );
  const h = tools["list_host_supervisors"];
  if (!h) throw new Error("list_host_supervisors tool not registered");
  return h;
}

async function callList(handler: ToolHandler, args: any = {}): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

describe("list_host_supervisors HANDLER tests (RFC-026 §9.2, PR2 v2)", () => {
  test("SEC-1.1: cross-tenant utok_ caller with foreign network_id → DENIED", async () => {
    const userA = "u_lhs_alice"; // belongs to NET_ALPHA only
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedNetwork(NET_BETA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_BETA, alias: "secret-beta-daemon" });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_BETA });
    // PR2 v1 BUG: this returned ok:true with secret-beta-daemon in the list.
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/access denied|not a member/i);
    // Belt: hostname not in error payload
    expect(JSON.stringify(reply)).not.toContain("secret-beta-daemon");
    expect(JSON.stringify(reply)).not.toContain("host-secret-beta-daemon");
  });

  test("SEC-1.2: admin caller with own network_id returns own daemons", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_ALPHA, alias: "alpha-daemon-1" });
    seedDaemon({ network_id: NET_ALPHA, alias: "alpha-daemon-2" });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    expect(reply.ok).toBe(true);
    const aliases = (reply.daemons ?? []).map(d => d.alias).sort();
    expect(aliases).toEqual(["alpha-daemon-1", "alpha-daemon-2"]);
  });

  test("SEC-1.3: caller without network_id arg → returns daemons across member networks only", async () => {
    const userA = "u_lhs_alice"; // member of NET_ALPHA only
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedNetwork(NET_BETA);
    seedMembership(userA, NET_ALPHA, "member");
    seedDaemon({ network_id: NET_ALPHA, alias: "ok-daemon" });
    seedDaemon({ network_id: NET_BETA, alias: "forbidden-daemon" });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler);
    expect(reply.ok).toBe(true);
    const aliases = (reply.daemons ?? []).map(d => d.alias);
    expect(aliases).toContain("ok-daemon");
    expect(aliases).not.toContain("forbidden-daemon");
  });

  test("masking: member caller gets host_telemetry without IP/cpu/mem; admin gets full", async () => {
    const userMember = "u_lhs_bob_member";
    const userAdmin = "u_lhs_carol_admin";
    seedUser(userMember);
    seedUser(userAdmin);
    seedNetwork(NET_ALPHA);
    seedMembership(userMember, NET_ALPHA, "member");
    seedMembership(userAdmin, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_ALPHA, alias: "telemetry-daemon", sessionAgeMs: 5_000 });

    const memberHandler = buildToolHandler(userMember);
    const memberReply = await callList(memberHandler, { network_id: NET_ALPHA });
    expect(memberReply.daemons?.[0].host_telemetry.alert_level).toBeDefined();
    expect(memberReply.daemons?.[0].host_telemetry).not.toHaveProperty("cpu_cores");
    expect(memberReply.daemons?.[0].host_telemetry).not.toHaveProperty("mem_gb");
    expect(memberReply.daemons?.[0].host_telemetry).not.toHaveProperty("ip_internal");

    const adminHandler = buildToolHandler(userAdmin);
    const adminReply = await callList(adminHandler, { network_id: NET_ALPHA });
    expect(adminReply.daemons?.[0].host_telemetry.cpu_cores).toBe(8);
    expect(adminReply.daemons?.[0].host_telemetry.mem_gb).toBe(16);
    expect(adminReply.daemons?.[0].host_telemetry.ip_internal).toBe("10.0.0.5");
  });

  test("revoked: DELETEd token row (revokeToken path) excludes daemon", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_ALPHA, alias: "alive-daemon" });
    seedDaemon({ network_id: NET_ALPHA, alias: "deleted-token-daemon", tokenDeleted: true });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    const aliases = (reply.daemons ?? []).map(d => d.alias).sort();
    expect(aliases).toContain("alive-daemon");
    expect(aliases).not.toContain("deleted-token-daemon");
  });

  test("revoked: token with revoked_at SET also excludes daemon", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_ALPHA, alias: "alive-daemon" });
    seedDaemon({ network_id: NET_ALPHA, alias: "revoked-at-daemon", tokenRevokedAt: true });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    const aliases = (reply.daemons ?? []).map(d => d.alias).sort();
    expect(aliases).toContain("alive-daemon");
    expect(aliases).not.toContain("revoked-at-daemon");
  });

  test("role filter: regular member nodes (role=member) excluded after extraction", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({ network_id: NET_ALPHA, alias: "real-daemon", role: "host_supervisor" });
    seedDaemon({ network_id: NET_ALPHA, alias: "regular-node", role: "member" });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    const aliases = (reply.daemons ?? []).map(d => d.alias).sort();
    expect(aliases).toEqual(["real-daemon"]);
  });

  test("self-declare: runtimes_supported + allowed_secret_keys surface from columns", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    seedDaemon({
      network_id: NET_ALPHA, alias: "rich-daemon",
      runtimes: ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
      secrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    });

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    const d = reply.daemons?.[0];
    expect(d.runtimes_supported).toEqual(["claude-agent-sdk", "codex-sdk", "grok-build-acp"]);
    expect(d.allowed_secret_keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  test("pre-PR2 daemon (NULL columns) extracts to empty arrays back-compat", async () => {
    const userA = "u_lhs_alice";
    seedUser(userA);
    seedNetwork(NET_ALPHA);
    seedMembership(userA, NET_ALPHA, "admin");
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, runtimes_supported, allowed_secret_keys, created_at, updated_at)
       VALUES (?1, 'legacy', 'legacy', ?2, ?3, NULL, NULL, datetime('now'), datetime('now'))`,
      ["node_legacy_alpha", NET_ALPHA, JSON.stringify({ role: "host_supervisor" })],
    );
    // Seed active token so the EXISTS guard lets it through
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash)
       VALUES ('tok_legacy', 'u_seed_legacy', ?1, 'network', 'node:legacy', 'hash_legacy')`,
      [NET_ALPHA],
    );

    const handler = buildToolHandler(userA);
    const reply = await callList(handler, { network_id: NET_ALPHA });
    const d = reply.daemons?.find(d => d.alias === "legacy");
    expect(d).toBeTruthy();
    expect(d.runtimes_supported).toEqual([]);
    expect(d.allowed_secret_keys).toEqual([]);
  });
});
