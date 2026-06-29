import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// RFC-027 PR1 — handler-driven tests for stop_node, delete_node,
// get_stop_request, ack_stop_request. Drives the MCP handlers via
// registerTools() so the wired auth context is real (not the
// mirror-SQL pattern that PR2 v1 used and which let SEC-1 leak slip
// through, per [[feedback_parallel_fork_review_catches_wired_wrong]]).
//
// Covers RFC-027 P1 e2e plan §5.2 scenarios A/B/C/D/E/F at the
// handler layer:
//   A — stop happy path
//   B — stop + in-flight (default refuse)
//   C — stop + in-flight + force=true → audit row written
//   D — delete happy path
//   E — cross-tenant SEC-1 refusal
//   F — delete daemon via delete_node refused (D6 gate)
// Plus state machine + confirm_alias + ack finalize transitions.

const NET_A = "net_sd_alpha";
const NET_B = "net_sd_beta";
const USER_A_ID = "u_sd_alice";
const USER_B_ID = "u_sd_bob";
const DAEMON_A_ID = "node_sd_daemon_a";
const DAEMON_A_ALIAS = "sd-daemon-a";
const DAEMON_A_TOK = "tok_sd_daemon_a";
const CHILD_A_ID = "node_sd_child_a";
const CHILD_A_ALIAS = "sd-child-a";
const CHILD_TOK_A_ID = "tok_sd_child_a";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; [k: string]: unknown; }

function cleanup() {
  for (const n of [NET_A, NET_B]) {
    try { db.run("DELETE FROM node_stop_requests WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM inbox WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM sessions WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM network_members WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [n]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [USER_A_ID, USER_B_ID]); } catch {}
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
function seedNetwork(net_id: string, owner_id: string) {
  db.run(
    `INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [net_id, net_id, owner_id],
  );
}
function seedMembership(user_id: string, net_id: string, role: "owner" | "admin" | "member" | "viewer" = "admin") {
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [user_id, net_id, role],
  );
}
function seedDaemon(net: string, node_id: string, alias: string, user_id: string, tokenId: string, role = "host_supervisor") {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'), 'active')`,
    [node_id, alias, alias, net, JSON.stringify({ role, daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"] } }), `host-${alias}`],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [tokenId, user_id, net, `node:${alias}`, `hash_${tokenId}`],
  );
}
function seedChild(net: string, node_id: string, alias: string, user_id: string, tokenId: string, opts: { lifecycle_state?: string; role?: string } = {}) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'), ?7)`,
    [node_id, alias, alias, net, JSON.stringify({ role: opts.role ?? "member" }), `host-${alias}`, opts.lifecycle_state ?? "active"],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [tokenId, user_id, net, `node:${alias}`, `hash_${tokenId}`],
  );
}
function seedInbox(net: string, alias: string, n: number) {
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id, acked)
       VALUES (?1, ?2, 'task', 'normal', ?3, 'caller', ?4, 0)`,
      [`inbox_${alias}_${i}_${Date.now()}`, alias, `task ${i}`, net],
    );
  }
}

function buildHandlers(
  enforceUserId: string | null,
  daemonTokenBound = false,
  callerTokenId: string | null = null,
  daemonNetId: string | null = null,
): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, _schema, handler);
  };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => {
      tools[name] = handler;
      return origRegisterTool(name, _cfg, handler);
    };
  }
  registerTools(
    server, undefined,
    /* enforceNetworkId */ daemonTokenBound ? daemonNetId : null,
    /* enforceUserId */ enforceUserId,
    /* callerAlias */ null,
    /* callerTokenIsNetwork */ daemonTokenBound,
    /* callerTokenId */ callerTokenId,
  );
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

function readNode(node_id: string) {
  return db.get<{ lifecycle_state: string | null; alias: string }>(
    `SELECT lifecycle_state, alias FROM nodes WHERE node_id = ?1`, node_id,
  );
}
function readToken(tokenId: string) {
  return db.get<{ revoked_at: string | null }>(
    `SELECT revoked_at FROM api_tokens WHERE token_id = ?1`, tokenId,
  );
}
function readRequest(request_id: string) {
  return db.get<{ status: string; action: string; backup_path: string | null; exit_signal: string | null }>(
    `SELECT status, action, backup_path, exit_signal FROM node_stop_requests WHERE request_id = ?1`,
    request_id,
  );
}
function readAudit(action: string, network_id: string) {
  return db.all<{ action: string; target_id: string; detail: string }>(
    `SELECT action, target_id, detail FROM audit_log WHERE action = ?1 AND network_id = ?2 ORDER BY id DESC`,
    [action, network_id],
  );
}

function setupAlphaNetwork() {
  seedUser(USER_A_ID);
  seedNetwork(NET_A, USER_A_ID);
  seedMembership(USER_A_ID, NET_A, "admin");
  seedDaemon(NET_A, DAEMON_A_ID, DAEMON_A_ALIAS, USER_A_ID, DAEMON_A_TOK);
  seedChild(NET_A, CHILD_A_ID, CHILD_A_ALIAS, USER_A_ID, CHILD_TOK_A_ID);
}

// ── stop_node ──────────────────────────────────────────────────────

describe("stop_node — happy path (RFC-027 §5.2 A)", () => {
  test("active child + no in-flight → dispatch + state→stopping", async () => {
    setupAlphaNetwork();
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID,
      daemon_node_id: DAEMON_A_ID,
      network_id: NET_A,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("stop");
    expect(r.lifecycle_state).toBe("stopping");
    expect(r.in_flight_at_dispatch).toBe(0);
    expect(typeof r.request_id).toBe("string");
    expect((r.request_id as string).startsWith("sr_")).toBe(true);

    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("stopping");
    expect(readAudit("stop_node_dispatched", NET_A).length).toBe(1);
  });
});

describe("stop_node — in-flight default-refuse (RFC-027 §5.2 B)", () => {
  test("inbox has 2 unacked tasks → error=node_busy_in_flight, count surfaced", async () => {
    setupAlphaNetwork();
    seedInbox(NET_A, CHILD_A_ALIAS, 2);
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_busy_in_flight");
    expect(r.in_flight_count).toBe(2);
    // state untouched
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("active");
    expect(readAudit("stop_node_dispatched", NET_A).length).toBe(0);
  });
});

describe("stop_node — force=true with in-flight (RFC-027 §5.2 C)", () => {
  test("force overrides + forced_stop_with_in_flight audit row written", async () => {
    setupAlphaNetwork();
    seedInbox(NET_A, CHILD_A_ALIAS, 3);
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      force: true,
    });
    expect(r.ok).toBe(true);
    expect(r.in_flight_at_dispatch).toBe(3);
    const audits = readAudit("forced_stop_with_in_flight", NET_A);
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].detail).in_flight_count).toBe(3);
  });
});

describe("stop_node — state machine guards", () => {
  test("stop on already-stopped node → node_not_active", async () => {
    setupAlphaNetwork();
    db.run(`UPDATE nodes SET lifecycle_state = 'stopped' WHERE node_id = ?1`, [CHILD_A_ID]);
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_not_active");
    expect(r.current_state).toBe("stopped");
  });

  test("stop on already-stopping node → node_already_stopping", async () => {
    setupAlphaNetwork();
    db.run(`UPDATE nodes SET lifecycle_state = 'stopping' WHERE node_id = ?1`, [CHILD_A_ID]);
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_already_stopping");
  });
});

// ── delete_node ────────────────────────────────────────────────────

describe("delete_node — happy path (RFC-027 §5.2 D)", () => {
  test("active child + correct confirm_alias → dispatch + state→deleting", async () => {
    setupAlphaNetwork();
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.delete_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      confirm_alias: CHILD_A_ALIAS,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("delete");
    expect(r.lifecycle_state).toBe("deleting");
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("deleting");
    expect(readAudit("delete_node_dispatched", NET_A).length).toBe(1);
  });
});

describe("delete_node — confirm_alias gate", () => {
  test("wrong alias input → confirm_alias_mismatch", async () => {
    setupAlphaNetwork();
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.delete_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      confirm_alias: "wrong-alias",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("confirm_alias_mismatch");
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("active");
  });
});

describe("delete_node — D6 daemon-role-gate (RFC-027 §5.2 F)", () => {
  test("delete targeting host_supervisor daemon → cannot_delete_daemon_via_delete_node", async () => {
    setupAlphaNetwork();
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.delete_node, {
      child_node_id: DAEMON_A_ID,    // targeting the daemon itself
      daemon_node_id: DAEMON_A_ID,
      network_id: NET_A,
      confirm_alias: DAEMON_A_ALIAS,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cannot_delete_daemon_via_delete_node");
    // Daemon row untouched.
    expect(readNode(DAEMON_A_ID)?.lifecycle_state).toBe("active");
  });
});

// ── SEC-1 cross-tenant ─────────────────────────────────────────────

describe("stop_node / delete_node — SEC-1 cross-tenant (RFC-027 §5.2 E)", () => {
  test("user-B targeting user-A's child → forbidden_cross_tenant; netA node untouched", async () => {
    setupAlphaNetwork();
    // also seed user B in own network
    seedUser(USER_B_ID);
    seedNetwork(NET_B, USER_B_ID);
    seedMembership(USER_B_ID, NET_B, "admin");

    const tools = buildHandlers(USER_B_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID,
      network_id: NET_A,                          // user-B claiming netA scope
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/forbidden_cross_tenant|access denied/i);
    // netA child unaffected
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("active");
    expect(readAudit("stop_node_dispatched", NET_A).length).toBe(0);
  });

  test("user-B with no network_id arg still can't see/touch netA child", async () => {
    setupAlphaNetwork();
    seedUser(USER_B_ID);
    seedNetwork(NET_B, USER_B_ID);
    seedMembership(USER_B_ID, NET_B, "admin");

    const tools = buildHandlers(USER_B_ID);
    const r = await call(tools.delete_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID,
      confirm_alias: CHILD_A_ALIAS,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/forbidden_cross_tenant/i);
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("active");
  });
});

// ── get_stop_request + ack_stop_request (daemon-side flow) ─────────

describe("get_stop_request + ack_stop_request — daemon flow", () => {
  test("daemon pulls request → ack 'stopped' → state machine finalizes (stop branch)", async () => {
    setupAlphaNetwork();
    const userTools = buildHandlers(USER_A_ID);
    const dispatch = await call(userTools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    expect(dispatch.ok).toBe(true);
    const requestId = dispatch.request_id as string;

    // daemon perspective: token-bound to its own ntok
    const daemonTools = buildHandlers(USER_A_ID, /*tokenBound*/ true, DAEMON_A_TOK, NET_A);
    const got = await call(daemonTools.get_stop_request, { request_id: requestId });
    expect(got.ok).toBe(true);
    expect(got.action).toBe("stop");
    expect(got.child_node_id).toBe(CHILD_A_ID);
    expect(got.child_alias).toBe(CHILD_A_ALIAS);
    expect(readRequest(requestId)?.status).toBe("delivered");

    const acked = await call(daemonTools.ack_stop_request, {
      request_id: requestId, status: "stopped", exit_signal: "SIGTERM",
    });
    expect(acked.ok).toBe(true);
    expect(readRequest(requestId)?.status).toBe("stopped");
    expect(readRequest(requestId)?.exit_signal).toBe("SIGTERM");
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("stopped");
    expect(readAudit("stop_node_completed", NET_A).length).toBe(1);
    // ntok must NOT be revoked on stop (reversible).
    expect(readToken(CHILD_TOK_A_ID)?.revoked_at).toBeNull();
  });

  test("daemon ack 'stopped' on delete branch → ntok revoked + node row DELETEd", async () => {
    setupAlphaNetwork();
    const userTools = buildHandlers(USER_A_ID);
    const dispatch = await call(userTools.delete_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      confirm_alias: CHILD_A_ALIAS,
    });
    expect(dispatch.ok).toBe(true);
    const requestId = dispatch.request_id as string;

    const daemonTools = buildHandlers(USER_A_ID, true, DAEMON_A_TOK, NET_A);
    const acked = await call(daemonTools.ack_stop_request, {
      request_id: requestId, status: "stopped", exit_signal: "SIGTERM",
      backup_path: "/home/u/.anet/deleted/1719647200000-sd-child-a",
    });
    expect(acked.ok).toBe(true);
    // Row gone, ntok revoked, audit row written
    expect(readNode(CHILD_A_ID) ?? null).toBeNull();
    expect(readToken(CHILD_TOK_A_ID)?.revoked_at).not.toBeNull();
    const audits = readAudit("delete_node_completed", NET_A);
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].detail).backup_path).toBe("/home/u/.anet/deleted/1719647200000-sd-child-a");
  });

  test("daemon ack 'stop_failed' → lifecycle_state=stop_failed, request error captured", async () => {
    setupAlphaNetwork();
    const userTools = buildHandlers(USER_A_ID);
    const dispatch = await call(userTools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    const requestId = dispatch.request_id as string;
    const daemonTools = buildHandlers(USER_A_ID, true, DAEMON_A_TOK, NET_A);
    await call(daemonTools.ack_stop_request, {
      request_id: requestId, status: "stop_failed", error: "SIGKILL also failed",
    });
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("stop_failed");
    expect(readRequest(requestId)?.status).toBe("stop_failed");
  });

  test("daemon B can't ack daemon A's request → not_your_request", async () => {
    setupAlphaNetwork();
    const userTools = buildHandlers(USER_A_ID);
    const dispatch = await call(userTools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    const requestId = dispatch.request_id as string;
    // Seed an unrelated daemon B in netA with its own token.
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
       VALUES ('node_other_daemon', 'other-daemon', 'other-daemon', ?1, '{}', 'h', datetime('now'), datetime('now'), 'active')`,
      [NET_A],
    );
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
       VALUES ('tok_other_daemon', ?1, ?2, 'network', 'node:other-daemon', 'hash_other', NULL, NULL)`,
      [USER_A_ID, NET_A],
    );
    const otherDaemonTools = buildHandlers(USER_A_ID, true, "tok_other_daemon", NET_A);
    const r = await call(otherDaemonTools.ack_stop_request, {
      request_id: requestId, status: "stopped",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_your_request");
  });
});

// ── PR1 v3: 通信龙 #345 deep-review fixes ──────────────────────────

describe("SF-2 — audit in tx propagates failure (D8 atomicity真)", () => {
  test("forced audit row written alongside dispatch in same tx (rollback if either fails)", async () => {
    // We can't easily simulate audit_log INSERT failure without
    // schema munging; the atomicity guarantee is structural (BEGIN..
    // COMMIT + auditCreateNodeStrict re-throws). Pin the invariant
    // observable to ops: the dispatch + forced audit both appear OR
    // both are absent. Happy path here; a true failure-injection
    // belongs in PR1.1's docker e2e where we can drop audit_log
    // permissions / corrupt the row.
    setupAlphaNetwork();
    seedInbox(NET_A, CHILD_A_ALIAS, 1);
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      force: true,
    });
    expect(r.ok).toBe(true);
    // Both audit rows present.
    expect(readAudit("stop_node_dispatched", NET_A).length).toBe(1);
    expect(readAudit("forced_stop_with_in_flight", NET_A).length).toBe(1);
    // node state moved
    expect(readNode(CHILD_A_ID)?.lifecycle_state).toBe("stopping");
  });
});

describe("SF-4 — D6 fail-CLOSED on ambiguous role", () => {
  test("corrupt config_snapshot + node referenced as daemon → still refused", async () => {
    setupAlphaNetwork();
    // Wreck the daemon's snapshot but leave the row + create-request
    // history. delete_node MUST still refuse — corrupt snapshot was the
    // SF-4 fail-open path.
    db.run(
      `UPDATE nodes SET config_snapshot = ?1 WHERE node_id = ?2`,
      ["not-valid-json{{{", DAEMON_A_ID],
    );
    // Plant a node_create_request that points to DAEMON_A as daemon,
    // simulating that this daemon has handed out children before.
    db.run(
      `INSERT INTO node_create_requests
         (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token)
       VALUES ('cr_sf4_evidence', ?1, 'past-child', ?2, 'claude-agent-sdk', 'x', '{}', '[]', 'succeeded', NULL, ?3, 'tok_test')`,
      [DAEMON_A_ID, NET_A, Date.now()],
    );
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.delete_node, {
      child_node_id: DAEMON_A_ID,
      daemon_node_id: DAEMON_A_ID,
      network_id: NET_A,
      confirm_alias: DAEMON_A_ALIAS,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cannot_delete_daemon_via_delete_node");
    expect(readNode(DAEMON_A_ID)?.lifecycle_state).toBe("active");
  });

  test("corrupt snapshot + NO daemon evidence → can be deleted (no FP)", async () => {
    // A plain child whose snapshot got mangled mustn't be refused.
    // Simulates corruption on a regular member node.
    setupAlphaNetwork();
    db.run(
      `UPDATE nodes SET config_snapshot = ?1 WHERE node_id = ?2`,
      ["{broken", CHILD_A_ID],
    );
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.delete_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
      confirm_alias: CHILD_A_ALIAS,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("delete");
  });
});

describe("SF-5 — in-flight COALESCE for legacy inbox rows", () => {
  test("inbox row with network_id=NULL but session_name matches → counted", async () => {
    setupAlphaNetwork();
    // Legacy-shape inbox row: session_name set, network_id NULL.
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id, acked)
       VALUES (?1, ?2, 'task', 'normal', 'legacy-task', 'caller', NULL, 0)`,
      [`inbox_legacy_${Date.now()}`, CHILD_A_ALIAS],
    );
    const tools = buildHandlers(USER_A_ID);
    const r = await call(tools.stop_node, {
      child_node_id: CHILD_A_ID, daemon_node_id: DAEMON_A_ID, network_id: NET_A,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_busy_in_flight");
    expect(r.in_flight_count).toBeGreaterThanOrEqual(1);
  });
});
