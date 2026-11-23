// B 止血（ack 未确认回退）的适用范围 —— 生产事故回归：
//
//   通知 / 节点间回执这类 `requires_response = 'none'` 的 inbox 行，ack 本身就是终点：
//   没有回复可等，也不需要回复。旧口径把它们也塞进「acked 后 N 分钟无回复 ⇒ 回退未读」
//   的窗口，于是 ack 10 分钟后被回退成未读 ⇒ Hub 重新投递 ⇒ 节点再 ack ⇒ 再回退……
//   全网节点原地打转（生产实测：50 条 orphan 通知、79 条 chain 通知被反复回退）。
//
// 这里盯的是 ack 入口真的按 `requires_response` 区分，而不是只测 acked-unconfirmed 的纯函数。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { sweepUnconfirmed, _resetForTest } from "./acked-unconfirmed.js";

const NET = "net_ack_scope";
const USER = "u_ack_scope";
const ALIAS = "ack-scope-node";

const W = 10 * 60 * 1000;

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
  _resetForTest();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
}

function seedInbox(id: string, requiresResponse: string, type: string) {
  db.run(
    `INSERT INTO inbox (id, session_name, type, content, created_at, acked, requires_response, network_id)
     VALUES (?1, ?2, ?3, 'hello', datetime('now'), 0, ?4, ?5)`,
    [id, ALIAS, type, requiresResponse, NET],
  );
}

beforeEach(seed);
afterAll(cleanup);

describe("ack_inbox：只有期待回复的行才进 B 止血的回退窗口", () => {
  test("requires_response='none' 的通知行：ack 后不再被回退", async () => {
    seedInbox("inbox_notice_1", "none", "reply");
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_notice_1" });
    expect(r.ok).toBe(true);
    expect(sweepUnconfirmed(Date.now() + W + 60_000, W)).toEqual([]);
  });

  test("requires_response='reply' 的任务行：窗口到期仍会被回退（旧口径不变）", async () => {
    seedInbox("inbox_task_1", "reply", "task");
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_task_1" });
    expect(r.ok).toBe(true);
    const hit = sweepUnconfirmed(Date.now() + W + 60_000, W);
    expect(hit.map(h => h.messageId)).toEqual(["inbox_task_1"]);
  });
});
