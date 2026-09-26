// Handler-level regression for the #212 dedup window swallowing human chat
// messages (see send_dedup.ts header, "Key selection").
//
// Before the fix, POST /api/task keyed the dedup window on
// (from, to, sha256(content)) only and ignored meta.client_request_id, so a
// user sending the same short text twice within 5 minutes got 200/429/429 and
// ONE stored row — and the app maps that 429 to "delivered". The table below
// is the repro, run against both transports:
//
//   case                              | before (REST) | after
//   ----------------------------------+---------------+-------------------------
//   same text, 3 different ids        | 1 row         | 3 rows, 3 x ok
//   same text, same id (retry)        | 1 row         | 1 row, 2 x replay (same id)
//   different text, same id           | 3 rows        | 1 row, 2 x idempotency_conflict
//   same text, no id (#212 agents)    | 1 row         | 1 row, 2 x duplicate_send
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "./auth.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { sharedSendDedup } from "./send_dedup.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-send-dedup-rid-"));
const TARGET = `dedup-rid-target-${process.pid}`;
const TARGET_NODE_ID = `node_dedup_rid_${process.pid}`;

let server: any;
let base = "";
let userToken = "";
let restNet = "";
let restUser = "";

const MCP_NET = `net_dedup_rid_${process.pid}`;
const MCP_USER = `user_dedup_rid_${process.pid}`;

function rid(n: number): string {
  // App shape: dreq_ + 32 lowercase hex.
  return `dreq_${n.toString(16).padStart(32, "0")}`;
}

function seedTarget(networkId: string, suffix: string) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`resume_${TARGET_NODE_ID}_${suffix}`, TARGET, `${TARGET_NODE_ID}_${suffix}`, networkId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'), 'active')`,
    [`${TARGET_NODE_ID}_${suffix}`, TARGET, networkId],
  );
}

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  restUser = `dedup_rid_${Date.now()}`;
  const registered = register(restUser, "DedupRid123!", undefined, "seed");
  expect(registered.ok).toBe(true);
  userToken = registered.token!;
  restNet = registered.network_id!;
  seedTarget(restNet, "rest");

  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [MCP_USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [MCP_NET, MCP_USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [MCP_USER, MCP_NET]);
  seedTarget(MCP_NET, "mcp");

  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const net of [restNet, MCP_NET]) {
    if (!net) continue;
    for (const table of ["tasks", "inbox", "task_events"]) {
      try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [net]); } catch {}
    }
  }
  sharedSendDedup.clear();
});

function rowCount(networkId: string): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1", [networkId])!.n;
}
function inboxCount(networkId: string): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1", [networkId])!.n;
}

// ── REST ────────────────────────────────────────────────────────────────

async function rest(task: string, requestId?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: TARGET,
      task,
      priority: "normal",
      network_id: restNet,
      from: restUser,
      meta: requestId
        ? { source: "dashboard-chat", client_request_id: requestId }
        : { source: "dashboard-chat" },
    }),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/task dedup key selection", () => {
  test("same text with 3 different request ids -> 3 rows (the reported data loss)", async () => {
    const results = [await rest("好", rid(1)), await rest("好", rid(2)), await rest("好", rid(3))];
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const ids = results.map((r) => r.body.task_id);
    expect(new Set(ids).size).toBe(3);
    expect(rowCount(restNet)).toBe(3);
    expect(inboxCount(restNet)).toBe(3);
  });

  test("same text with the same request id -> 1 row, retries replay the same task id", async () => {
    const first = await rest("好", rid(7));
    const second = await rest("好", rid(7));
    const third = await rest("好", rid(7));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, task_id: first.body.task_id, message_id: first.body.task_id, idempotent_replay: true });
    expect(third.body.task_id).toBe(first.body.task_id);
    expect(rowCount(restNet)).toBe(1);
    expect(inboxCount(restNet)).toBe(1);
  });

  test("different text with the same request id -> 1 row, reuse fails closed (409)", async () => {
    const first = await rest("第一条", rid(9));
    const second = await rest("第二条", rid(9));
    const third = await rest("第三条", rid(9));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("idempotency_conflict");
    expect(third.status).toBe(409);
    expect(rowCount(restNet)).toBe(1);
  });

  test("#212 guard: same text WITHOUT a request id is still deduped (429 duplicate_send)", async () => {
    const results = [await rest("继续"), await rest("继续"), await rest("继续")];
    expect(results.map((r) => r.status)).toEqual([200, 429, 429]);
    expect(results[1].body.error).toBe("duplicate_send");
    expect(rowCount(restNet)).toBe(1);
  });

  test("no request id, different text -> each goes through", async () => {
    const results = [await rest("a"), await rest("b"), await rest("c")];
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rowCount(restNet)).toBe(3);
  });
});

// ── MCP send_task ──────────────────────────────────────────────────────

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function mcpSendTask(): ToolHandler {
  const mcp = new McpServer({ name: "dedup-rid-test", version: "0" }) as any;
  let handler: ToolHandler | undefined;
  const original = mcp.tool.bind(mcp);
  mcp.tool = (name: string, description: string, schema: any, candidate: ToolHandler) => {
    if (name === "send_task") handler = candidate;
    return original(name, description, schema, candidate);
  };
  registerTools(mcp, undefined, MCP_NET, MCP_USER, MCP_USER, false, null);
  if (!handler) throw new Error("send_task handler missing");
  return handler;
}

async function mcp(handler: ToolHandler, task: string, requestId?: string): Promise<any> {
  const result = await handler({
    alias: TARGET,
    task,
    priority: "normal",
    ...(requestId ? { meta: { source: "dashboard-chat", client_request_id: requestId } } : {}),
  });
  return JSON.parse(result.content[0].text);
}

describe("MCP send_task dedup key selection", () => {
  test("same text with 3 different request ids -> 3 rows", async () => {
    const h = mcpSendTask();
    const results = [await mcp(h, "好", rid(11)), await mcp(h, "好", rid(12)), await mcp(h, "好", rid(13))];
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(new Set(results.map((r) => r.message_id)).size).toBe(3);
    expect(rowCount(MCP_NET)).toBe(3);
  });

  test("same text with the same request id -> 1 row, replay returns the same task id", async () => {
    const h = mcpSendTask();
    const first = await mcp(h, "好", rid(17));
    const second = await mcp(h, "好", rid(17));
    const third = await mcp(h, "好", rid(17));
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, task_id: first.message_id, idempotent_replay: true });
    expect(third.task_id).toBe(first.message_id);
    expect(rowCount(MCP_NET)).toBe(1);
  });

  test("different text with the same request id -> 1 row, idempotency_conflict", async () => {
    const h = mcpSendTask();
    expect((await mcp(h, "第一条", rid(19))).ok).toBe(true);
    expect((await mcp(h, "第二条", rid(19))).error).toBe("idempotency_conflict");
    expect((await mcp(h, "第三条", rid(19))).error).toBe("idempotency_conflict");
    expect(rowCount(MCP_NET)).toBe(1);
  });

  test("#212 guard: same text WITHOUT a request id is still deduped", async () => {
    const h = mcpSendTask();
    const results = [await mcp(h, "继续"), await mcp(h, "继续"), await mcp(h, "继续")];
    expect(results[0].ok).toBe(true);
    expect(results[1].error).toBe("duplicate_send");
    expect(results[2].error).toBe("duplicate_send");
    expect(rowCount(MCP_NET)).toBe(1);
  });
});
