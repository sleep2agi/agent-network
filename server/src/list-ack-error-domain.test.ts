// #3309 读数覆盖第七批 —— 两个 error 字面量此前在测试里一次都没出现过：
//
//   list_tasks  : durable_cursor_required
//   ack_inbox   : message not found or already acknowledged
//
// 两条都是「调用协议用错了」，而不是「权限/状态不对」：
//   durable_cursor_required ⇒ 打开了「按序号读终态日志」这个模式，却没给游标
//                             （这只在 durable_terminal_cursor=true 时才要求，
//                              所以它是一条**条件性必需参数**的错误）
//   already acknowledged    ⇒ 这条消息已经被 ack 过（或 id 根本不在你的待办里）
//
// ⚠ 故意没测 `ack_inbox` 的第二个出口 "message not found or not yours"：
//   它只在「SELECT 找到了、UPDATE 影响 0 行」时发生，也就是**并发**下另一个
//   ack 抢先提交的那一刻。本仓没有可注入的并发点，造一个不算真。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_7th_err";
const USER = "u_7th_user";
const ALIAS = "7th-node";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function handlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  registerTools(server, undefined, NET, USER, ALIAS, false, null);
  return out;
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await handlers()[name](args);
  return JSON.parse(r.content[0].text) as { ok?: boolean; error?: string; [k: string]: unknown };
}

function cleanup() {
  try { db.run("DELETE FROM inbox WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
}

function seedInbox(acked: number) {
  db.run(
    `INSERT INTO inbox (id, session_name, type, content, created_at, acked, network_id)
     VALUES ('inbox_7th_1', ?1, 'message', 'hello', ?2, ?3, ?4)`,
    [ALIAS, Date.now(), acked, NET],
  );
}

beforeEach(seed);
afterAll(cleanup);

describe("#3309 list_tasks / ack_inbox 的错误值域", () => {
  test("durable_terminal_cursor=true 但没给 durable_cursor ⇒ durable_cursor_required", async () => {
    const r = await call("list_tasks", { durable_terminal_cursor: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("durable_cursor_required");
  });

  test("不给 durable_terminal_cursor 时不要求游标（条件性必需）", async () => {
    // ⚠ 本 harness 直接调 handler，**绕过了 zod** ⇒ `.default(20)` 不会生效。
    // 第一次没给 limit，SQL 里 `LIMIT ?` 绑到 undefined ⇒ SQLITE_MISMATCH。
    // 那是夹具的事，不是产品的事 —— 所以这里显式补上默认值。
    const r = await call("list_tasks", { limit: 20 });
    // 这条不是为了「成功」，而是为了证明上一条是**条件**触发的：
    // 若改成无条件要求游标，这条会红。
    expect(r.ok).toBe(true);
  });

  test("ack 一条已 ack 过的消息 ⇒ message not found or already acknowledged", async () => {
    seedInbox(1);
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_7th_1" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("message not found or already acknowledged");
  });

  test("ack 一个根本不存在的 id ⇒ 同一句（两种成因**故意**不区分）", async () => {
    seedInbox(0);
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_7th_does_not_exist" });
    expect(r.ok).toBe(false);
    // 「没见过这个 id」与「已经 ack 过」对调用方是同一种处置：不要重试。
    // 而服务端**不区分**它们是有意的（避免用错误码探测别人有没有这条消息）。
    expect(r.error).toBe("message not found or already acknowledged");
  });

  test("两条载荷都没有 code 字段（现状，不是契约）", async () => {
    const replies = [
      await call("list_tasks", { durable_terminal_cursor: true, limit: 20 }),
      await call("ack_inbox", { alias: ALIAS, message_id: "inbox_7th_nope" }),
    ];
    for (const r of replies) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});
