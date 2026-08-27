// f015d9d6 症状①：tasks.status 被置为 'delivered'，而 SSE 推送根本没发出。
//
// send_task 无条件以字面量 'delivered' 插入 tasks 行，推送却另外被
// `if (target.state === "online")` 挡着（tools.ts:1432）。同一段代码里给
// network observer 的事件把同一件事标成 "queued" —— 也就是说代码**知道**
// 它没投出去，却仍然把 delivered 写进了 tasks.status。
//
// 而 "online" 的判据是 resolveDeliveryTarget 里的
//   stale = now - (last_seen_at || updated_at) > 5 分钟
// 且 last_seen_at 只在 report_status 时刷新（tools.ts:674/702）。
// 全网「停发心跳/状态类消息」的省额度规则之下，一个安静的 MCP 会话必然变 stale。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { __resetSSEClientsForTest, createSSEStream } from "./push.js";

const NET = "net_delivered_push_f015";
const USER = "user_delivered_push_f015";
const SENDER = "sender-f015b";
const TARGET = "quiet-mcp-f015b";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  __resetSSEClientsForTest();
  for (const t of ["tasks", "inbox", "task_events", "sessions", "api_tokens", "nodes", "rename_txn"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

/** minutesAgo 控制目标会话的 last_seen_at —— 这是本文件唯一要动的变量。 */
function seed(minutesAgo: number) {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'admin', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  for (const alias of [SENDER, TARGET]) {
    db.run(
      "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'network')",
      [`token-${alias}`, `hash-${alias}`, USER, NET, `node:${alias}`],
    );
  }
  db.run(
    "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?1, 'idle', NULL, ?2, datetime('now'), datetime('now', ?3))",
    [SENDER, NET, "-1 minutes"],
  );
  // 🔴 目标：MCP 挂载的 claude-code 会话形状（node_id NULL），
  //    status 是 'idle'（不是 offline），只是安静了 minutesAgo 分钟。
  db.run(
    "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', NULL, ?3, datetime('now', ?4), datetime('now', ?4))",
    [`cc-n_${TARGET}`, TARGET, NET, `-${minutesAgo} minutes`],
  );
}

function toolsFor(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "delivered-push-f015", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler; return original(name, description, schema, handler);
  };
  registerTools(server, undefined, NET, USER, alias, true, `token-${alias}`);
  return tools;
}

/** 从订阅者那一侧真正读出字节 —— 地面真相，不是连接计数。 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms = 1500): Promise<string | null> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200)),
    ]);
    if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
    if (buf.includes(needle)) return buf;
  }
  return null;
}

let sendSeq = 0;
/** minutesAgo = 目标安静了多久；withSubscriber = 是否真的有人连着。 */
async function send(minutesAgo: number, withSubscriber = true) {
  cleanup(); seed(minutesAgo);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  if (withSubscriber) {
    const res = createSSEStream(TARGET, NET);
    reader = res.body!.getReader();
  }
  const r = await toolsFor(SENDER).send_task({ alias: TARGET, task: `ping-${++sendSeq}`, priority: "normal" });
  const out = JSON.parse(r.content[0].text);
  const row = db.get<{ status: string }>("SELECT status FROM tasks WHERE to_name = ?1 AND network_id = ?2", TARGET, NET);
  const received = reader ? await readUntil(reader, "new_task") : null;
  return { out, taskStatus: row?.status ?? null, received };
}

describe("f015d9d6 症状① — delivered 置位与实际推送不同步", () => {
  beforeEach(() => cleanup());
  afterAll(() => cleanup());

  test("对照：目标 1 分钟前还活跃 ⇒ 订阅者收到 new_task", async () => {
    const { taskStatus, received } = await send(1);
    expect(taskStatus).toBe("delivered");
    expect(received).toContain("new_task");
  });

  test("🔴 核心：目标安静 10 分钟但订阅者连着 ⇒ 仍然收得到（修复前这里收到 null）", async () => {
    const { taskStatus, received } = await send(10);
    expect(received).toContain("new_task");
    expect(taskStatus).toBe("delivered");   // 现在这个 delivered 是真话了
  });

  test("🔴 可达性判据必须来自订阅者注册表，不是 last_seen_at 的时间戳猜测", async () => {
    // 安静 10 分钟 = 时间戳判据会说 offline；而实际上有人在听。
    const quiet = await send(10);
    expect(quiet.received).toContain("new_task");
    // 真没人听的时候，pushEvent 本来就是 no-op，不需要额外的闸来保护。
    const nobody = await send(10, false);
    expect(nobody.received).toBeNull();
  });

  test("真的没有订阅者时，tasks 行仍写 delivered —— 本 PR 刻意不改，记录在案", async () => {
    const { taskStatus, received } = await send(10, false);
    expect(received).toBeNull();
    // 这一条钉的是**当前行为**，不是我认为对的行为：没人收到，行仍自称 delivered。
    expect(taskStatus).toBe("delivered");
  });

  test("活性判据的输入 last_seen_at 只由 report_status 刷新 —— 发送方不刷新它", async () => {
    cleanup(); seed(4);
    const before = db.get<{ last_seen_at: string }>("SELECT last_seen_at FROM sessions WHERE alias = ?1 AND network_id = ?2", TARGET, NET);
    await toolsFor(SENDER).send_task({ alias: TARGET, task: `ping-${++sendSeq}`, priority: "normal" });
    const after = db.get<{ last_seen_at: string }>("SELECT last_seen_at FROM sessions WHERE alias = ?1 AND network_id = ?2", TARGET, NET);
    expect(after?.last_seen_at).toBe(before!.last_seen_at);
  });
});
