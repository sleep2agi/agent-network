// Desktop user push contract.
//
// Pins the new user-keyed SSE path and send_desktop_message MCP tool:
// - user streams are keyed by networkId:userId, never alias
// - ntok callers cannot cross network by supplying a foreign to_user_id/network_id
// - target ambiguity/miss is fail-closed before audit/push

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import {
  __resetSSEClientsForTest,
  createUserEventStream,
  pushUserEvent,
} from "./push.js";

const NET_A = "net_desktop_a";
const NET_B = "net_desktop_b";
const NODE_USER = "u_desktop_node_owner";
const SENDER_USER = "u_desktop_sender";
const TARGET_A = "u_desktop_target_a";
const TARGET_B = "u_desktop_target_b";
const TARGET_BOTH = "u_desktop_target_both";
const ALL_USERS = [NODE_USER, SENDER_USER, TARGET_A, TARGET_B, TARGET_BOTH];

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  try { db.run("DELETE FROM audit_log WHERE action = 'send_desktop_message' OR network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
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
      [u, `${u}_name`],
    );
  }
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_A, SENDER_USER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_B, TARGET_B]);
  const member = (userId: string, networkId: string, role: string) =>
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, ?3, datetime('now'))`, [userId, networkId, role]);
  member(NODE_USER, NET_A, "member");
  member(SENDER_USER, NET_A, "owner");
  member(TARGET_A, NET_A, "member");
  member(TARGET_B, NET_B, "member");
  member(TARGET_BOTH, NET_A, "member");
  member(TARGET_BOTH, NET_B, "member");
}

beforeEach(() => { cleanup(); seed(); });
afterEach(() => { __resetSSEClientsForTest(); });
afterAll(cleanup);

function buildHandlers(opts: { netId?: string | null; userId?: string | null; alias?: string | null; isNetwork?: boolean }) {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, schema, handler);
  };
  registerTools(
    server,
    undefined,
    opts.netId ?? null,
    opts.userId ?? null,
    opts.alias ?? opts.userId ?? null,
    opts.isNetwork ?? false,
    "tok_desktop_test",
  );
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<Record<string, any>> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`no SSE frame within ${timeoutMs}ms`)), deadline - Date.now()),
      ),
    ]);
    if (result.done) throw new Error("SSE stream ended unexpectedly");
    buf += decoder.decode(result.value, { stream: true });
    const sep = buf.indexOf("\n\n");
    if (sep === -1) continue;
    const rawFrame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    const dataLine = rawFrame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    return JSON.parse(dataLine.slice(6));
  }
  throw new Error(`no SSE frame within ${timeoutMs}ms`);
}

function auditCount() {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'send_desktop_message'")?.n ?? 0;
}

describe("send_desktop_message", () => {
  test("ntok caller can push to a user in the same bound network", async () => {
    const stream = createUserEventStream(NET_A, TARGET_A);
    const reader = stream.body!.getReader();
    await readFrame(reader);

    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, {
      to_user_id: TARGET_A,
      message: "desktop hello",
      severity: "success",
    });

    expect(result.ok).toBe(true);
    expect(result.message_id).toStartWith("dm_");
    expect(auditCount()).toBe(1);
    const evt = await readFrame(reader);
    expect(evt.type).toBe("desktop_message");
    expect(evt.message_id).toBe(result.message_id);
    expect(evt.message).toBe("desktop hello");
    expect(evt.from).toBe("node-a");
    expect(evt.network_id).toBe(NET_A);
    expect(evt.user_id).toBe(TARGET_A);
    expect(evt.scope).toBe("user");
    await reader.cancel();
  });

  test("utok caller can push with explicit network_id to a member user", async () => {
    const stream = createUserEventStream(NET_A, TARGET_A);
    const reader = stream.body!.getReader();
    await readFrame(reader);

    const tools = buildHandlers({ userId: SENDER_USER, alias: "sender-user" });
    const result = await call(tools.send_desktop_message, {
      to_username: `${TARGET_A}_name`,
      network_id: NET_A,
      title: "Heads up",
      message: "from user token",
    });

    expect(result.ok).toBe(true);
    const evt = await readFrame(reader);
    expect(evt.title).toBe("Heads up");
    expect(evt.message).toBe("from user token");
    expect(evt.network_id).toBe(NET_A);
    await reader.cancel();
  });

  test("ntok caller cannot cross network with foreign network_id and to_user_id; no audit or push happens first", async () => {
    const stream = createUserEventStream(NET_B, TARGET_B);
    const reader = stream.body!.getReader();
    await readFrame(reader);

    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, {
      to_user_id: TARGET_B,
      network_id: NET_B,
      message: "must not cross",
    });

    expect(result).toEqual({ ok: false, error: "desktop_target_not_in_network", network_id: NET_A });
    expect(auditCount()).toBe(0);

    pushUserEvent(NET_B, TARGET_B, { type: "desktop_message", message_id: "marker_after_denied" });
    expect((await readFrame(reader)).message_id).toBe("marker_after_denied");
    await reader.cancel();
  });

  test("missing target is fail-closed before audit", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, { message: "nobody" });
    expect(result).toEqual({
      ok: false,
      error: "desktop_target_required",
      message: "to_user_id or to_username is required",
    });
    expect(auditCount()).toBe(0);
  });

  test("conflicting to_user_id and to_username is fail-closed before audit", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, {
      to_user_id: TARGET_A,
      to_username: `${TARGET_BOTH}_name`,
      message: "conflict",
    });
    expect(result).toEqual({
      ok: false,
      error: "desktop_target_mismatch",
      to_user_id: TARGET_A,
      to_username: `${TARGET_BOTH}_name`,
    });
    expect(auditCount()).toBe(0);
  });

  test("unknown target is fail-closed before audit", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, {
      to_username: "not_a_real_user",
      message: "lost",
    });
    expect(result).toEqual({ ok: false, error: "desktop_target_not_found", field: "to_username" });
    expect(auditCount()).toBe(0);
  });
});

// #1459 —— 返回值必须反映真实投递态。
//
// send_desktop_message 是 fire-and-forget：只 INSERT audit_log（不写 inbox），
// 再 pushUserEvent 扇出；而 pushUserEvent 在没有订阅者时静默 return。
// 用户 dashboard 离线/重连时消息永久丢（无 DB 行 ⇒ 无从 reconcile，
// /api/messages 只 SELECT ... FROM inbox），而调用方拿到的是 ok:true。
//
// 本 PR 只做「让丢失可见」这一半：不碰 schema，返回值说实话。
// 持久化 + 重连补投（让丢失不发生）是另一条，方向已定为按 user_id 寻址的新表。
describe("#1459 send_desktop_message 返回值反映真实投递态", () => {
  test("🔴 无活跃订阅者 ⇒ delivered:false + 可判读的 reason，而不是笼统 ok:true", async () => {
    // 故意不建 SSE 流：这正是用户 dashboard 关着的情形
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const before = auditCount();
    const result = await call(tools.send_desktop_message, {
      to_user_id: TARGET_A,
      message: "nobody is listening",
      severity: "info",
    });

    // ok 仍为 true：调用被接受、审计已落库 —— 这一格没变
    expect(result.ok).toBe(true);
    expect(result.message_id).toStartWith("dm_");
    expect(auditCount()).toBe(before + 1);

    // 新增的那一格：投递态
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no_live_subscriber");
  });

  test("有活跃订阅者 ⇒ delivered:true 且不带 reason", async () => {
    const stream = createUserEventStream(NET_A, TARGET_A);
    const reader = stream.body!.getReader();
    await readFrame(reader);

    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const result = await call(tools.send_desktop_message, {
      to_user_id: TARGET_A,
      message: "someone is listening",
      severity: "info",
    });

    expect(result.delivered).toBe(true);
    expect(result.reason).toBeUndefined();
    // 前提断言：这一条真的送到了订阅者手上，否则 delivered:true 就是空话
    const evt = await readFrame(reader);
    expect(evt.message).toBe("someone is listening");
    await reader.cancel();
  });

  test("🔴 两种情形必须给出不同读数 —— 防止判据退化成恒真", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const offline = await call(tools.send_desktop_message, { to_user_id: TARGET_A, message: "off", severity: "info" });

    const stream = createUserEventStream(NET_A, TARGET_A);
    const reader = stream.body!.getReader();
    await readFrame(reader);
    const online = await call(tools.send_desktop_message, { to_user_id: TARGET_A, message: "on", severity: "info" });
    await reader.cancel();

    expect(offline.delivered).not.toBe(online.delivered);
  });
});

// #1459 ① P2 —— 写入持久化。
describe("#1459 ① P2 send_desktop_message 持久化", () => {
  const rowsFor = (mid: string) =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE message_id = ?1", mid)?.n ?? 0;

  test("🔴 发一条消息 ⇒ user_inbox 落一行，字段与事件一致", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const r = await call(tools.send_desktop_message, {
      to_user_id: TARGET_A, message: "persist me", severity: "warning", title: "T", kind: "agent_message",
    });
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
    const row = db.get<any>("SELECT * FROM user_inbox WHERE message_id = ?1", r.message_id);
    expect(row).toBeTruthy();
    expect(row.user_id).toBe(TARGET_A);
    expect(row.content).toBe("persist me");
    expect(row.severity).toBe("warning");
    expect(row.title).toBe("T");
    expect(row.from_session).toBe("node-a");
    expect(row.network_id).toBe(NET_A);
    expect(row.acked).toBe(0);
  });

  test("🔴 没有活订阅者时也要落库 —— 「丢了」变成「待补投」的那一格", async () => {
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const r = await call(tools.send_desktop_message, { to_user_id: TARGET_A, message: "offline body" });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("no_live_subscriber");
    expect(r.persisted).toBe(true);
    expect(rowsFor(r.message_id)).toBe(1);
  });

  test("🔴 zod 默认值不可依赖：直接调 handler 不传 kind/severity 也必须落库", async () => {
    // 测试与未来的内部调用方绕过 MCP 的 zod .default()，拿到的是 undefined。
    // 列上虽有 DEFAULT，但显式传 NULL 会覆盖它 —— 所以写入侧要自己兜。
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const r = await call(tools.send_desktop_message, { to_user_id: TARGET_A, message: "no kind given" });
    expect(rowsFor(r.message_id)).toBe(1);
    const row = db.get<any>("SELECT kind, severity FROM user_inbox WHERE message_id = ?1", r.message_id);
    expect(row.kind).toBe("agent_message");
    expect(row.severity).toBe("info");
  });

  test("audit_log 与 user_inbox 同生共死（同一事务，条数一致）", async () => {
    const before = auditCount();
    const tools = buildHandlers({ netId: NET_A, userId: NODE_USER, alias: "node-a", isNetwork: true });
    const r = await call(tools.send_desktop_message, { to_user_id: TARGET_A, message: "paired" });
    expect(auditCount()).toBe(before + 1);
    expect(rowsFor(r.message_id)).toBe(1);
  });
});

// #1459 ① P2 —— 幂等写法的选择本身要被钉住。
//
// 🔴 实现时踩到的：最初用 `INSERT OR IGNORE`，它对「重投同一 message_id」是对的，
//    但**连 NOT NULL 违规也一起吞掉** —— kind 为 undefined 时整行被静默丢弃，
//    而工具照样返回 persisted:true。**一条消息凭空消失且报告成功**，正是本
//    issue 要消灭的那个形状。改成 ON CONFLICT(message_id) DO NOTHING：
//    只赦免主键冲突，别的约束照常抛。
describe("#1459 ① P2 幂等写法：赦免重复，但不吞约束错误", () => {
  const stmt = `INSERT INTO user_inbox
      (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(message_id) DO NOTHING`;

  test("重复的 message_id ⇒ 不抛错、也不产生第二行", () => {
    const mid = `dm_dup_${Date.now()}`;
    const ins = () => db.run(stmt, [mid, NET_A, TARGET_A, "node-a", "info", null, "body", "info", null]);
    ins();
    expect(() => ins()).not.toThrow();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE message_id = ?1", mid)?.n).toBe(1);
  });

  test("🔴 NOT NULL 违规必须抛出来 —— 不能像 OR IGNORE 那样静默丢行", () => {
    const mid = `dm_bad_${Date.now()}`;
    expect(() =>
      db.run(stmt, [mid, NET_A, TARGET_A, "node-a", null, null, "body", "info", null]),
    ).toThrow();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE message_id = ?1", mid)?.n).toBe(0);
  });
});
