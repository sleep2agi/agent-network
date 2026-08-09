import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_ack_transport";
const DAEMON_NODE_ID = "node_ack_transport_daemon";
const DAEMON_ALIAS = "ack-transport-daemon";
const DAEMON_USER = "u_ack_transport_owner";
const DAEMON_TOKEN_ID = "tok_ack_transport_daemon";

function cleanup() {
  try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM node_create_requests WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [DAEMON_USER]); } catch {}
}

function seedWorld() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [DAEMON_USER, DAEMON_USER],
  );
  db.run(
    `INSERT INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
    [NET, NET, DAEMON_USER],
  );
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, 'owner', datetime('now'))`,
    [DAEMON_USER, NET],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [DAEMON_NODE_ID, DAEMON_ALIAS, DAEMON_ALIAS, NET],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOKEN_ID, DAEMON_USER, NET, `node:${DAEMON_ALIAS}`, "hash_ack_transport_daemon"],
  );
}

function seedRequest(requestId: string) {
  db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, created_at, created_by_token)
     VALUES (?1, ?2, ?3, ?4, 'codex-sdk', 'x', '{}', '[]', 'delivered', ?5, ?6)`,
    [requestId, DAEMON_NODE_ID, `child_${requestId}`, NET, Date.now(), DAEMON_TOKEN_ID],
  );
}

async function connectClient() {
  const server = new McpServer({ name: "ack-transport-test", version: "1" });
  registerTools(
    server,
    undefined,
    NET,
    DAEMON_USER,
    DAEMON_ALIAS,
    true,
    DAEMON_TOKEN_ID,
  );
  const client = new Client({ name: "ack-transport-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function responseJson(result: ToolResult) {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("missing text tool result");
  return JSON.parse(first.text) as { ok?: boolean; status?: string };
}

function expectTransportValidationError(result: ToolResult) {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  expect(first?.type).toBe("text");
  expect(first?.text).toMatch(/Input validation error.*ack_create_request/i);
}

beforeEach(() => {
  cleanup();
  seedWorld();
});
afterAll(cleanup);

describe("#344 ack_create_request real in-process MCP transport", () => {
  test("accepts runtime_capability_check_failed plus string runtime through the SDK zod gate", async () => {
    const requestId = "cr_transport_accept";
    seedRequest(requestId);
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({
        name: "ack_create_request",
        arguments: {
          request_id: requestId,
          status: "runtime_capability_check_failed",
          error: "child died within 5000ms post-spawn",
          runtime: "codex-sdk",
        },
      });
      expect(responseJson(result)).toMatchObject({ ok: true, status: "runtime_capability_check_failed" });
      expect(db.get<{ status: string }>("SELECT status FROM node_create_requests WHERE request_id = ?1", requestId)?.status)
        .toBe("runtime_capability_check_failed");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects unknown status at the transport gate before the handler mutates the row", async () => {
    const requestId = "cr_transport_bad_status";
    seedRequest(requestId);
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({
        name: "ack_create_request",
        arguments: { request_id: requestId, status: "capability_failed_typo", runtime: "codex-sdk" },
      });
      expectTransportValidationError(result);
      expect(db.get<{ status: string }>("SELECT status FROM node_create_requests WHERE request_id = ?1", requestId)?.status)
        .toBe("delivered");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects non-string runtime at the transport gate before the handler mutates the row", async () => {
    const requestId = "cr_transport_bad_runtime";
    seedRequest(requestId);
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({
        name: "ack_create_request",
        arguments: { request_id: requestId, status: "runtime_capability_check_failed", runtime: 42 },
      });
      expectTransportValidationError(result);
      expect(db.get<{ status: string }>("SELECT status FROM node_create_requests WHERE request_id = ?1", requestId)?.status)
        .toBe("delivered");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
