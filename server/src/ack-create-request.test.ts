import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// RFC-026 §9.3 D2 / #338 PR3 — ack_create_request HANDLER tests.
//
// 通信龙 pre-review caught B1 + B2: my first cut of PR3 added a new daemon
// ack status `runtime_capability_check_failed` to create-node-daemon.ts but
// the hub's zod enum only accepted ["started", "failed", "rejected"] — the
// new status was silently zod-rejected on the hub side and the daemon's
// `.catch(()=>{})` swallowed the rejection. The PR body also claimed
// `daemon_capability_lied` audit was written when in fact the action wasn't
// in the audit enum and no insert ran.
//
// This handler-driven suite drives the registered MCP tool through
// registerTools() so a daemon's exact ack shape (status + runtime field)
// flows through the real zod schema + handler branch + audit insert. It
// would have caught the lane-recurring "single component passes but cross-
// component path stays broken" failure mode immediately.

const NET = "net_ack_t";
const DAEMON_NODE_ID = "node_ack_daemon";
const DAEMON_ALIAS = "ack-daemon";
const DAEMON_USER = "u_ack_owner";
const DAEMON_TOKEN_ID = "tok_ack_daemon";
const DAEMON_TOKEN_HASH = "hash_ack_daemon";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface AckReply { ok?: boolean; error?: string; status?: string; }

function cleanup() {
  try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM node_create_requests WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [DAEMON_USER]); } catch {}
}

beforeEach(cleanup);
afterAll(cleanup);

function seedDaemonWorld() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [DAEMON_USER, DAEMON_USER],
  );
  db.run(
    `INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [NET, NET, DAEMON_USER],
  );
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, 'owner', datetime('now'))`,
    [DAEMON_USER, NET],
  );
  // daemon node — must exist for resolveCallerDaemonTokenBound to bind.
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [DAEMON_NODE_ID, DAEMON_ALIAS, DAEMON_ALIAS, NET],
  );
  // daemon ntok — bound to the daemon node via name='node:<alias>'.
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOKEN_ID, DAEMON_USER, NET, `node:${DAEMON_ALIAS}`, DAEMON_TOKEN_HASH],
  );
}

function seedCreateRequest(opts: {
  request_id: string,
  child_token_id?: string,
  status?: "pending" | "delivered" | "succeeded" | "failed",
  child_name?: string,
  runtime?: string,
}) {
  const childName = opts.child_name ?? `child_${opts.request_id}`;
  if (opts.child_token_id) {
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
      [opts.child_token_id, DAEMON_USER, NET, `node:${childName}`, `hash_${opts.child_token_id}`],
    );
  }
  db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token)
     VALUES (?1, ?2, ?3, ?4, ?5, 'x', '{}', '[]', ?6, ?7, ?8, ?9)`,
    [
      opts.request_id, DAEMON_NODE_ID, childName, NET,
      opts.runtime ?? "claude-agent-sdk",
      opts.status ?? "delivered",
      opts.child_token_id ?? null,
      Date.now(),
      DAEMON_TOKEN_ID,
    ],
  );
}

/** Build a server with registerTools wired as if the daemon's ntok bound. */
function buildAckHandler(): ToolHandler {
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
    server,
    /* clientIP */ undefined,
    /* enforceNetworkId */ NET,
    /* enforceUserId */ DAEMON_USER,
    /* callerAlias */ DAEMON_ALIAS,
    /* callerTokenIsNetwork */ true,
    /* callerTokenId */ DAEMON_TOKEN_ID,
  );
  const h = tools["ack_create_request"];
  if (!h) throw new Error("ack_create_request tool not registered");
  return h;
}

async function callAck(handler: ToolHandler, args: any): Promise<AckReply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as AckReply;
}

function readRequest(request_id: string) {
  return db.get<{ status: string; error: string | null; acked_at: number | null }>(
    `SELECT status, error, acked_at FROM node_create_requests WHERE request_id = ?1`,
    request_id,
  );
}

function readToken(token_id: string) {
  return db.get<{ revoked_at: string | null }>(
    `SELECT revoked_at FROM api_tokens WHERE token_id = ?1`,
    token_id,
  );
}

function readAuditRows(action: string, target_id: string) {
  return db.all<{ action: string; network_id: string; target_id: string; detail: string }>(
    `SELECT action, network_id, target_id, detail FROM audit_log
     WHERE action = ?1 AND target_id = ?2 ORDER BY id DESC`,
    [action, target_id],
  );
}

describe("ack_create_request HANDLER — B1 schema accepts runtime_capability_check_failed", () => {
  test("schema accepts runtime_capability_check_failed + runtime field (no zod reject)", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b1_accept";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    const reply = await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      error: "child died within 5000ms post-spawn",
      runtime: "codex-sdk",
    });
    // PR3 v1 BUG: hub zod enum rejected this status → reply.ok=false /
    // tool would even throw before getting here. Now must accept.
    expect(reply.ok).toBe(true);
    expect(reply.status).toBe("runtime_capability_check_failed");
  });

  test("request flips to terminal runtime_capability_check_failed status", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b1_terminal";
    seedCreateRequest({ request_id: reqId, status: "delivered" });
    const handler = buildAckHandler();
    await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      error: "boom",
      runtime: "codex-sdk",
    });
    const row = readRequest(reqId);
    expect(row?.status).toBe("runtime_capability_check_failed");
    expect(row?.error).toBe("boom");
    expect(row?.acked_at).toBeGreaterThan(0);
  });

  test("child ntok is revoked on capability-check-failed (same teardown as 'failed')", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b1_revoke";
    const childTok = "tok_ack_child_b1";
    seedCreateRequest({ request_id: reqId, child_token_id: childTok });
    expect(readToken(childTok)?.revoked_at).toBeNull();
    const handler = buildAckHandler();
    await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      runtime: "codex-sdk",
    });
    expect(readToken(childTok)?.revoked_at).not.toBeNull();
  });
});

describe("ack_create_request HANDLER — B2 audit_log daemon_capability_lied", () => {
  test("writes daemon_capability_lied audit row with runtime + daemon + error in detail", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b2_audit";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      error: "OPENAI_API_KEY unset",
      runtime: "codex-sdk",
    });
    const rows = readAuditRows("daemon_capability_lied", reqId);
    // PR3 v1 BUG: action wasn't in auditCreateNode enum → 0 rows + no
    // surface for ops to spot lying daemons. Now must write exactly 1.
    expect(rows.length).toBe(1);
    expect(rows[0].network_id).toBe(NET);
    const detail = JSON.parse(rows[0].detail);
    expect(detail.runtime).toBe("codex-sdk");
    expect(detail.daemon_node_id).toBe(DAEMON_NODE_ID);
    expect(detail.error).toBe("OPENAI_API_KEY unset");
    expect(typeof detail.acked_at).toBe("number");
  });

  test("does NOT write daemon_capability_lied on generic 'failed' ack (status discriminates)", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b2_no_audit_on_failed";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    await callAck(handler, {
      request_id: reqId,
      status: "failed",
      error: "child died immediately after spawn",
    });
    const rows = readAuditRows("daemon_capability_lied", reqId);
    expect(rows.length).toBe(0);
  });

  test("does NOT write daemon_capability_lied on 'started' (happy path silence)", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b2_no_audit_on_started";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    await callAck(handler, { request_id: reqId, status: "started", child_pid: 12345 });
    const rows = readAuditRows("daemon_capability_lied", reqId);
    expect(rows.length).toBe(0);
  });

  test("runtime field nullable if daemon omitted it (older daemon back-compat)", async () => {
    // Older daemon (preview.10 and earlier) wouldn't send `runtime`.
    // The hub must still accept + audit, just with runtime=null.
    seedDaemonWorld();
    const reqId = "cr_ack_b2_nullable_runtime";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    const reply = await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      error: "child died",
    });
    expect(reply.ok).toBe(true);
    const rows = readAuditRows("daemon_capability_lied", reqId);
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail);
    expect(detail.runtime).toBeNull();
  });

  test("error string is truncated to 500 chars in audit detail (defense vs giant payload)", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_b2_trunc";
    seedCreateRequest({ request_id: reqId });
    const handler = buildAckHandler();
    const giant = "x".repeat(900);
    await callAck(handler, {
      request_id: reqId,
      status: "runtime_capability_check_failed",
      error: giant,
      runtime: "codex-sdk",
    });
    const rows = readAuditRows("daemon_capability_lied", reqId);
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail);
    expect(detail.error.length).toBe(500);
  });
});

describe("ack_create_request HANDLER — pre-existing happy-path stays green (regression)", () => {
  test("status='started' still flips acked_at without terminal teardown", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_started_regression";
    const childTok = "tok_ack_child_started";
    seedCreateRequest({ request_id: reqId, child_token_id: childTok });
    const handler = buildAckHandler();
    const reply = await callAck(handler, { request_id: reqId, status: "started", child_pid: 7777 });
    expect(reply.ok).toBe(true);
    expect(reply.status).toBe("awaiting_register");
    const row = readRequest(reqId);
    // 'started' doesn't flip to terminal; status stays 'delivered'.
    expect(row?.status).toBe("delivered");
    expect(row?.acked_at).toBeGreaterThan(0);
    // child ntok is NOT revoked on 'started'.
    expect(readToken(childTok)?.revoked_at).toBeNull();
  });

  test("status='failed' still revokes child + flips to failed (no audit_log daemon_capability_lied)", async () => {
    seedDaemonWorld();
    const reqId = "cr_ack_failed_regression";
    const childTok = "tok_ack_child_failed";
    seedCreateRequest({ request_id: reqId, child_token_id: childTok });
    const handler = buildAckHandler();
    const reply = await callAck(handler, { request_id: reqId, status: "failed", error: "fork failed" });
    expect(reply.ok).toBe(true);
    const row = readRequest(reqId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("fork failed");
    expect(readToken(childTok)?.revoked_at).not.toBeNull();
    expect(readAuditRows("daemon_capability_lied", reqId).length).toBe(0);
  });
});
