/**
 * #440 H0 expected RED — real /mcp raw-bearer consumer isolation.
 *
 * This deliberately starts the production Bun.serve entry point and sends
 * raw JSON-RPC requests to /mcp.  It does not call registerTools or a tool
 * handler directly.  The assertions describe the H1 contract and are
 * expected to fail on the H0 baseline: a network-bound token for consumer A
 * must not read or mutate consumer B's queue row merely by supplying B's
 * alias in tool arguments.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "hub-440-h0-red-"));
const TEST_DB = join(TEST_DIR, "commhub.db");
const PORT = 20_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const NETWORK_USER = `h440_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
const CONSUMER_A = "h440-consumer-a";
const CONSUMER_B = "h440-consumer-b";
const NODE_A = "h440-node-a";
const NODE_B = "h440-node-b";
const B_ROW_ID = "h440-row-owned-by-consumer-b";
const B_ROW_CONTENT = "H440_B_ROW_CANARY_NOT_SECRET";

let db: typeof import("./db.js").db;
let tokenA = "";
let tokenB = "";

type RawMcpResult = {
  httpStatus: number;
  contentType: string;
  rawBody: string;
  rpc: any;
  toolPayload: any;
};

function parseRpcBody(rawBody: string): any {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  // The MCP transport may select SSE when the Accept header allows it.
  // Preserve rawBody for evidence and parse the first JSON data event only.
  const dataLine = trimmed
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`unexpected MCP response body: ${trimmed.slice(0, 300)}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function rawMcpCall(token: string, id: number, name: string, args: Record<string, unknown>): Promise<RawMcpResult> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const rawBody = await res.text();
  const rpc = parseRpcBody(rawBody);
  const toolText = rpc?.result?.content?.[0]?.text;
  const toolPayload = typeof toolText === "string" ? JSON.parse(toolText) : null;
  return {
    httpStatus: res.status,
    contentType: res.headers.get("content-type") ?? "",
    rawBody,
    rpc,
    toolPayload,
  };
}

beforeAll(async () => {
  process.env.COMMHUB_DB = TEST_DB;
  process.env.COMMHUB_SCRYPT_N = "8";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(PORT);
  delete process.env.COMMHUB_AUTH_TOKEN;
  delete process.env.COMMHUB_DEV_OPEN;

  const dbMod = await import("./db.js");
  const auth = await import("./auth.js");
  db = dbMod.db;

  const registration = auth.register(
    NETWORK_USER,
    "H440-bootstrap-password!",
    undefined,
    "H440 fixture",
  );
  expect(registration.ok).toBe(true);
  expect(registration.user?.user_id).toBeTruthy();
  expect(registration.network_id).toBeTruthy();

  const a = auth.createNetworkTokenForNode(
    registration.user!.user_id,
    registration.network_id!,
    CONSUMER_A,
  );
  const b = auth.createNetworkTokenForNode(
    registration.user!.user_id,
    registration.network_id!,
    CONSUMER_B,
  );
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  tokenA = a.token!;
  tokenB = b.token!;

  // Importing index.ts is the real server start; /mcp then exercises the
  // production raw-bearer auth expansion and transport/handler stack.
  await import("./index.js");
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Register both consumers through the same raw /mcp entry. This makes the
  // fixture two real, distinct node_id principals rather than two token names
  // with no corresponding server-side node/session identity.
  for (const [token, alias, nodeId, rpcId] of [
    [tokenA, CONSUMER_A, NODE_A, 43998],
    [tokenB, CONSUMER_B, NODE_B, 43999],
  ] as const) {
    const status = await rawMcpCall(token, rpcId, "report_status", {
      resume_id: `${nodeId}-resume`,
      alias,
      node_id: nodeId,
      status: "idle",
      network_id: registration.network_id!,
    });
    expect(status.toolPayload?.ok).toBe(true);
    expect(status.toolPayload?.alias).toBe(alias);
  }

  db.run(
    `INSERT INTO inbox (
       id, session_name, node_id, type, priority, content, from_session, acked,
       requires_response, network_id
     ) VALUES (?1, ?2, ?3, 'task', 'normal', ?4, 'fixture-sender', 0, 'reply', ?5)`,
    [B_ROW_ID, CONSUMER_B, NODE_B, B_ROW_CONTENT, registration.network_id!],
  );
  db.run(
    `INSERT INTO tasks (
       task_id, from_name, to_node_id, to_name, priority, status, content,
       requires_response, network_id
     ) VALUES (?1, 'fixture-sender', ?2, ?3, 'normal', 'delivered', ?4, 'reply', ?5)`,
    [B_ROW_ID, NODE_B, CONSUMER_B, B_ROW_CONTENT, registration.network_id!],
  );
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe("#440 H0 expected RED — server-resolved consumer principal", () => {
  test("positive control: consumer B raw bearer can read B's pending row", async () => {
    const response = await rawMcpCall(tokenB, 44000, "get_inbox", {
      alias: CONSUMER_B,
      limit: 10,
    });
    expect(response.httpStatus).toBe(200);
    expect(response.toolPayload?.messages ?? []).toContainEqual(
      expect.objectContaining({ id: B_ROW_ID, content: B_ROW_CONTENT }),
    );
  });

  test("consumer A raw bearer cannot read consumer B's pending row", async () => {
    const before = db.get<{ acked: number }>(
      "SELECT acked FROM inbox WHERE id = ?1",
      B_ROW_ID,
    );
    const response = await rawMcpCall(tokenA, 44001, "get_inbox", {
      alias: CONSUMER_B,
      limit: 10,
    });
    const after = db.get<{ acked: number }>(
      "SELECT acked FROM inbox WHERE id = ?1",
      B_ROW_ID,
    );

    console.log("H440_RAW_GET_BASELINE", JSON.stringify({
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      rpc: response.rpc,
      before,
      after,
    }));

    expect(response.httpStatus).toBe(200);
    expect(response.toolPayload?.messages ?? []).not.toContainEqual(
      expect.objectContaining({ id: B_ROW_ID, content: B_ROW_CONTENT }),
    );
    expect(after).toEqual(before);
  });

  test("consumer A raw bearer cannot ack consumer B's pending row", async () => {
    const snapshot = () => ({
      inbox: db.get<{ acked: number }>(
        "SELECT acked FROM inbox WHERE id = ?1",
        B_ROW_ID,
      ),
      task: db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE task_id = ?1",
        B_ROW_ID,
      ),
      taskEvents: db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?1",
        B_ROW_ID,
      ),
      auditRows: db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_log WHERE target_id = ?1",
        B_ROW_ID,
      ),
    });
    const before = snapshot();
    const response = await rawMcpCall(tokenA, 44002, "ack_inbox", {
      alias: CONSUMER_B,
      message_id: B_ROW_ID,
    });
    const after = snapshot();

    console.log("H440_RAW_ACK_BASELINE", JSON.stringify({
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      rpc: response.rpc,
      before,
      after,
    }));

    expect(response.httpStatus).toBe(200);
    expect(response.toolPayload?.ok).not.toBe(true);
    expect(after).toEqual(before);
  });
});
