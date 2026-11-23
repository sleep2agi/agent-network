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

function seedSession(alias: string) {
  db.run(
    `INSERT OR REPLACE INTO sessions (resume_id, alias, status, updated_at, last_seen_at, network_id)
     VALUES (?1, ?2, 'idle', datetime('now'), datetime('now'), ?3)`,
    [`res_${alias}`, alias, NET],
  );
}

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

  test("普通聊天消息行（type='message'）：ack 后不再被回退（它不进模型，永远不会有回复）", async () => {
    // 旧数据里 send_message 没显式写 requires_response，吃的是列默认值 'reply'。
    seedInbox("inbox_chat_1", "reply", "message");
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_chat_1" });
    expect(r.ok).toBe(true);
    expect(sweepUnconfirmed(Date.now() + W + 60_000, W)).toEqual([]);
  });

  test("别人的任务结果行（type='reply'）：ack 后不再被回退", async () => {
    seedInbox("inbox_result_1", "reply", "reply");
    const r = await call("ack_inbox", { alias: ALIAS, message_id: "inbox_result_1" });
    expect(r.ok).toBe(true);
    expect(sweepUnconfirmed(Date.now() + W + 60_000, W)).toEqual([]);
  });
});

describe("send_message：普通聊天消息不该被标成「期待回复」", () => {
  test("新写入的 message 行 requires_response='none'", async () => {
    seedSession(ALIAS);
    const r = await call("send_message", { alias: ALIAS, message: "hi there", from_session: "peer-node" });
    expect(r.ok).toBe(true);
    const row = db.get<{ requires_response: string | null; type: string }>(
      "SELECT type, requires_response FROM inbox WHERE id = ?1 AND session_name = ?2",
      [String(r.message_id), ALIAS],
    );
    expect(row?.type).toBe("message");
    expect(row?.requires_response).toBe("none");
  });

  test("control（interrupt）行仍然期待回复：节点会用回执证明它执行了", async () => {
    seedSession(ALIAS);
    const r = await call("send_message", { alias: ALIAS, message: "stop", control: "interrupt", from_session: "peer-node" });
    expect(r.ok).toBe(true);
    const row = db.get<{ requires_response: string | null; type: string }>(
      "SELECT type, requires_response FROM inbox WHERE id = ?1 AND session_name = ?2",
      [String(r.message_id), ALIAS],
    );
    expect(row?.type).toBe("control");
    expect(row?.requires_response).toBe("reply");
  });
});

describe("ack_inbox：先回执、后 ack 的正常顺序不该被误判成「签收但没投递」", () => {
  test("回执在前、ack 在后 ⇒ 任务行不再被回退", async () => {
    seedSession(ALIAS);
    seedSession("peer-node");
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, status, content, created_at, delivered_at, requires_response, network_id)
       VALUES ('t_reply_first', 'peer-node', ?1, 'acked', 'do it', datetime('now'), datetime('now'), 'reply', ?2)`,
      [ALIAS, NET],
    );
    db.run(
      `INSERT INTO inbox (id, task_id, session_name, type, content, created_at, acked, requires_response, network_id)
       VALUES ('t_reply_first', 't_reply_first', ?1, 'task', 'do it', datetime('now'), 0, 'reply', ?2)`,
      [ALIAS, NET],
    );

    // 节点的真实顺序：先回执（send_reply），再 ack 收件箱那一行。
    const reply = await call("send_reply", { alias: "peer-node", text: "done", in_reply_to: "t_reply_first", from_session: ALIAS });
    expect(reply.ok).toBe(true);

    const ack = await call("ack_inbox", { alias: ALIAS, message_id: "t_reply_first" });
    expect(ack.ok).toBe(true);

    expect(sweepUnconfirmed(Date.now() + W + 60_000, W)).toEqual([]);
  });
});
