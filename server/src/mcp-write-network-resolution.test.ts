// #517 — MCP write-path network resolution (utok single-network fallback).
//
// Root cause (issue #517): utok_ token rows are created with network_id=null
// BY DESIGN (auth.ts login), and the MCP write path (tools.ts canWrite) had
// no single-network fallback — unlike REST POST /api/task (server.ts), which
// auto-resolves via singleNetworkId(restScope) when the user belongs to
// exactly one network. Result: a utok node could READ everything
// (resolveReadScope falls back to all memberships) but could not WRITE
// anything, and the error mislabeled the failure as permission_denied.
//
// Fix under test:
//  - getNetworkId falls back to the user's single membership via the SAME
//    shared singleNetworkId/getUserNetworkIds used by REST (network-scope.ts)
//  - canWrite delegates to the shared canRestWriteNetwork
//  - the 7 write tools that had NO network_id input gain an optional one:
//    send_message / send_reply / ack_inbox / send_ack / retry_task /
//    cancel_task / reassign_task
//  - writeDeniedReply names the REAL cause: network_id_required (0 or ≥2
//    memberships) / access_denied (not a member of the requested network) /
//    permission_denied (viewer role)
//  - ntok_ (network-bound) behavior: ZERO change — pinned below
//
// Assertion discipline: error replies are asserted with toEqual (accepted
// set == spec-allowed set, no not.toBe / toContain wideners).
//
// Run: COMMHUB_DB=/tmp/517-net-scope-test.db bun test src/mcp-write-network-resolution.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db, uuidv4 } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET_A = "net_517_a";
const NET_B = "net_517_b";
const U_SINGLE = "u517_single";    // owner of NET_A only → fallback resolves
const U_MULTI = "u517_multi";      // member of NET_A + NET_B → ambiguous
const U_VIEWER = "u517_viewer";    // viewer of NET_A only → resolves, then role-denied
const U_NONE = "u517_none";        // no memberships
const U_OUTSIDER = "u517_outsider"; // member of NET_B only, targets NET_A
const A1 = "peer-517-a1";
const A2 = "peer-517-a2";
const ALL_USERS = [U_SINGLE, U_MULTI, U_VIEWER, U_NONE, U_OUTSIDER];

interface ToolHandler {
  (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
interface Reply { ok?: boolean; error?: string; message?: string; [k: string]: unknown }

function cleanup() {
  for (const t of ["tasks", "inbox", "task_events"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id IN (?1, ?2)`, [NET_A, NET_B]); } catch {}
    try { db.run(`DELETE FROM ${t} WHERE content LIKE 'x517%'`); } catch {}
  }
  try { db.run("DELETE FROM sessions WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  for (const u of ALL_USERS) {
    try { db.run("DELETE FROM users WHERE user_id = ?1", [u]); } catch {}
  }
}

function seed() {
  for (const u of ALL_USERS) {
    db.run(
      `INSERT INTO users (user_id, username, password_hash, role, created_at)
       VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
      [u, u],
    );
  }
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_A, U_SINGLE]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_B, U_MULTI]);
  const member = (u: string, net: string, role: string) =>
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, ?3, datetime('now'))`, [u, net, role]);
  member(U_SINGLE, NET_A, "owner");
  member(U_MULTI, NET_A, "member");
  member(U_MULTI, NET_B, "owner");
  member(U_VIEWER, NET_A, "viewer");
  member(U_OUTSIDER, NET_B, "member");
  for (const alias of [A1, A2]) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
       VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'), datetime('now'), 'active')`,
      [`node_${alias}`, alias, NET_A, `host-${alias}`],
    );
    db.run(
      `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
       VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
      [`res_${alias}`, alias, `node_${alias}`, NET_A],
    );
  }
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

type HandlerMap = { tools: Record<string, ToolHandler>; schemas: Record<string, Record<string, unknown>> };

function buildHandlers(opts: { netId?: string | null; userId?: string | null; alias?: string | null; isNetwork?: boolean }): HandlerMap {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const schemas: Record<string, Record<string, unknown>> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    schemas[name] = schema;
    return origTool(name, _desc, schema, handler);
  };
  registerTools(
    server,
    undefined,
    opts.netId ?? null,
    opts.userId ?? null,
    opts.alias ?? opts.userId ?? null,
    opts.isNetwork ?? false,
    null,
  );
  return { tools, schemas };
}

async function call(handler: ToolHandler, args: any): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

function makeTask(to: string, status: string, content: string, net: string | null = NET_A): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, 'dispatcher', ?2, 'normal', ?3, ?4, 'reply', datetime('now'), ?5)`,
    [id, to, status, content, net],
  );
  return id;
}

function makeInbox(to: string, content: string, net: string | null = NET_A): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
     VALUES (?1, ?2, ?3, 'message', 'normal', ?4, 'dispatcher', ?5)`,
    [id, to, `node_${to}`, content, net],
  );
  return id;
}

const taskRow = (content: string) =>
  db.get<{ task_id: string; status: string; to_name: string; network_id: string | null }>(
    "SELECT task_id, status, to_name, network_id FROM tasks WHERE content = ?1", content);
const taskById = (id: string) =>
  db.get<{ status: string; to_name: string; network_id: string | null }>(
    "SELECT status, to_name, network_id FROM tasks WHERE task_id = ?1", id);
const inboxRow = (content: string) =>
  db.get<{ id: string; acked: number; network_id: string | null }>(
    "SELECT id, acked, network_id FROM inbox WHERE content = ?1", content);

// ─────────────────────────────────────────────────────────────────────
// Group 1 — utok, single network, NO network_id argument anywhere.
// The hub must auto-resolve to the user's only membership (REST parity
// with server.ts POST /api/task → singleNetworkId fallback).
// ─────────────────────────────────────────────────────────────────────
describe("utok single-network auto-resolve (no network_id argument)", () => {
  test("send_task resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const r = await call(tools["send_task"], { alias: A1, task: "x517 g1 send_task", priority: "normal" });
    expect(r.ok).toBe(true);
    expect(taskRow("x517 g1 send_task")?.network_id).toBe(NET_A);
  });

  test("send_message resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const r = await call(tools["send_message"], { alias: A1, message: "x517 g1 send_message" });
    expect(r.ok).toBe(true);
    expect(inboxRow("x517 g1 send_message")?.network_id).toBe(NET_A);
  });

  test("send_reply resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const t = makeTask(A1, "delivered", "x517 g1 send_reply parent");
    const r = await call(tools["send_reply"], { alias: A1, text: "x517 g1 send_reply", in_reply_to: t, status: "replied" });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("replied");
  });

  test("ack_inbox resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const ib = makeInbox(A1, "x517 g1 ack_inbox");
    const r = await call(tools["ack_inbox"], { alias: A1, message_id: ib });
    expect(r.ok).toBe(true);
    expect(inboxRow("x517 g1 ack_inbox")?.acked).toBe(1);
  });

  test("send_ack resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const t = makeTask(A1, "delivered", "x517 g1 send_ack");
    const r = await call(tools["send_ack"], { task_id: t });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("acked");
  });

  test("retry_task resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const t = makeTask(A1, "failed", "x517 g1 retry_task");
    const r = await call(tools["retry_task"], { task_id: t });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("delivered");
  });

  test("cancel_task resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const t = makeTask(A1, "delivered", "x517 g1 cancel_task");
    const r = await call(tools["cancel_task"], { task_id: t });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("cancelled");
  });

  test("reassign_task resolves to the only membership", async () => {
    const { tools } = buildHandlers({ userId: U_SINGLE });
    const t = makeTask(A1, "delivered", "x517 g1 reassign_task");
    const r = await call(tools["reassign_task"], { task_id: t, new_alias: A2 });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.to_name).toBe(A2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group 2 — utok, MULTI network. Without network_id: precise
// network_id_required error (not permission_denied). With explicit
// network_id: every formerly param-less tool must thread it through.
// One case per changed tool (通信龙 acceptance rule: 改了三个只测一个,
// 剩下两个等于没验).
// ─────────────────────────────────────────────────────────────────────
describe("utok multi-network", () => {
  test("send_task without network_id → exact network_id_required error", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const r = await call(tools["send_task"], { alias: A1, task: "x517 g2 ambiguous", priority: "normal" });
    expect(r).toEqual({
      ok: false,
      error: "network_id_required",
      message: "user token spans 2 networks; pass network_id explicitly (see /api/auth/me networks[].network_id)",
    });
    expect(taskRow("x517 g2 ambiguous")).toBeNull();
  });

  test("send_message threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const r = await call(tools["send_message"], { alias: A1, message: "x517 g2 send_message", network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(inboxRow("x517 g2 send_message")?.network_id).toBe(NET_A);
  });

  test("send_reply threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const t = makeTask(A1, "delivered", "x517 g2 send_reply parent");
    const r = await call(tools["send_reply"], { alias: A1, text: "x517 g2 send_reply", in_reply_to: t, status: "replied", network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("replied");
  });

  test("ack_inbox threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const ib = makeInbox(A1, "x517 g2 ack_inbox");
    const r = await call(tools["ack_inbox"], { alias: A1, message_id: ib, network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(inboxRow("x517 g2 ack_inbox")?.acked).toBe(1);
  });

  test("send_ack threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const t = makeTask(A1, "delivered", "x517 g2 send_ack");
    const r = await call(tools["send_ack"], { task_id: t, network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("acked");
  });

  test("retry_task threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const t = makeTask(A1, "failed", "x517 g2 retry_task");
    const r = await call(tools["retry_task"], { task_id: t, network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("delivered");
  });

  test("cancel_task threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const t = makeTask(A1, "delivered", "x517 g2 cancel_task");
    const r = await call(tools["cancel_task"], { task_id: t, network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.status).toBe("cancelled");
  });

  test("reassign_task threads explicit network_id", async () => {
    const { tools } = buildHandlers({ userId: U_MULTI });
    const t = makeTask(A1, "delivered", "x517 g2 reassign_task");
    const r = await call(tools["reassign_task"], { task_id: t, new_alias: A2, network_id: NET_A });
    expect(r.ok).toBe(true);
    expect(taskById(t)?.to_name).toBe(A2);
  });

  test("all 7 formerly param-less write tools expose network_id in their input schema", () => {
    const { schemas } = buildHandlers({ userId: U_MULTI });
    for (const name of ["send_message", "send_reply", "ack_inbox", "send_ack", "retry_task", "cancel_task", "reassign_task"]) {
      expect(Object.keys(schemas[name] ?? {})).toContain("network_id");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group 3 — precise causes replace the old catch-all message.
// ─────────────────────────────────────────────────────────────────────
describe("precise denial causes", () => {
  test("utok with zero memberships → network_id_required naming the real cause", async () => {
    const { tools } = buildHandlers({ userId: U_NONE });
    const r = await call(tools["send_task"], { alias: A1, task: "x517 g3 none", priority: "normal" });
    expect(r).toEqual({
      ok: false,
      error: "network_id_required",
      message: "user token has no network memberships; join or create a network first",
    });
  });

  test("utok explicitly targeting a network it is not a member of → access_denied", async () => {
    const { tools } = buildHandlers({ userId: U_OUTSIDER });
    const r = await call(tools["send_task"], { alias: A1, task: "x517 g3 outsider", priority: "normal", network_id: NET_A });
    expect(r).toEqual({
      ok: false,
      error: "access_denied",
      message: "access denied to requested network (not a member)",
    });
    expect(taskRow("x517 g3 outsider")).toBeNull();
  });

  test("viewer in a single network → permission_denied (send_task wording)", async () => {
    const { tools } = buildHandlers({ userId: U_VIEWER });
    const r = await call(tools["send_task"], { alias: A1, task: "x517 g3 viewer task", priority: "normal" });
    expect(r).toEqual({
      ok: false,
      error: "permission_denied",
      message: "Viewer role cannot send tasks",
    });
  });

  test("viewer in a single network → permission_denied (generic write wording)", async () => {
    const { tools } = buildHandlers({ userId: U_VIEWER });
    const r = await call(tools["send_message"], { alias: A1, message: "x517 g3 viewer msg" });
    expect(r).toEqual({
      ok: false,
      error: "permission_denied",
      message: "Viewer role cannot write to this network",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group 4 — ntok_ pins: network-bound tokens must see ZERO change.
// ─────────────────────────────────────────────────────────────────────
describe("ntok behavior pinned (zero change)", () => {
  test("ntok send_task without network_id stays bound to token network", async () => {
    const { tools } = buildHandlers({ netId: NET_A, userId: U_SINGLE, alias: A1, isNetwork: true });
    const r = await call(tools["send_task"], { alias: A2, task: "x517 g4 ntok plain", priority: "normal" });
    expect(r.ok).toBe(true);
    expect(taskRow("x517 g4 ntok plain")?.network_id).toBe(NET_A);
  });

  test("ntok send_task ignores a client-supplied foreign network_id (enforced binding wins)", async () => {
    const { tools } = buildHandlers({ netId: NET_A, userId: U_MULTI, alias: A1, isNetwork: true });
    const r = await call(tools["send_task"], { alias: A2, task: "x517 g4 ntok override", priority: "normal", network_id: NET_B });
    expect(r.ok).toBe(true);
    expect(taskRow("x517 g4 ntok override")?.network_id).toBe(NET_A);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group 5 — legacy global-token mode (no enforceUserId): the fallback
// must NOT kick in; writes stay unscoped exactly as before.
// ─────────────────────────────────────────────────────────────────────
describe("legacy global-token mode pinned", () => {
  test("send_message without auth context stays network-unscoped", async () => {
    const { tools } = buildHandlers({ userId: null });
    const r = await call(tools["send_message"], { alias: A1, message: "x517 g5 legacy" });
    expect(r.ok).toBe(true);
    expect(inboxRow("x517 g5 legacy")?.network_id).toBeNull();
  });
});
