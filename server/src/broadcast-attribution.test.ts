// #4066 —— 广播的发信人必须是**真的调用者**，不是 'hub'。
//
// 现场（2026-11-13，生产库实测）：type='broadcast' 且 from_session='hub' 共 3253 行。
// 收件人看到「来自 hub」，正文却是 "[TMA客户端欧5号] …" —— 分不清谁说的。
// 根因：MCP `broadcast` 工具把 fromSession 写死成 "hub"（tools.ts），
// 而同一处已经在用 inboxSender() 取真实调用者做收件白名单判定。
//
// 这个文件钉住：节点令牌调用 broadcast 时，落库的 from_session == 该节点 alias。

import { afterAll, beforeAll, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const stamp = `${Date.now()}`;
const CALLER = `bcast-sender-${stamp}`;
const TARGETS = [`bcast-target-a-${stamp}`, `bcast-target-b-${stamp}`];
let NET = "";
let USER = "";
let TOKEN_ID = "";

function buildBroadcastHandler(): ToolHandler {
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
    /* enforceUserId */ USER,
    /* callerAlias */ CALLER,
    /* callerTokenIsNetwork */ true,
    /* callerTokenId */ TOKEN_ID,
  );
  const h = tools["broadcast"];
  if (!h) throw new Error("broadcast tool not registered");
  return h;
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth: any = register(`bcast_owner_${stamp}`, "Bcast-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id;
  USER = auth.user_id;
  TOKEN_ID = `tok_${stamp}`;
  // 收件人：只插 sessions 行（没有 nodes 行 ⇒ assertNodeActive 视为 active，见 lifecycle-guard.ts:46）。
  TARGETS.forEach((alias, i) => {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, status, node_id, last_seen_at, updated_at)
       VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
      [`resume-${stamp}-${i}`, alias, NET, `n_bcast_${stamp}_${i}`],
    );
  });
});

afterAll(() => {
  try { db.run("DELETE FROM inbox WHERE network_id = ?1 AND session_name LIKE ?2", [NET, `bcast-target-%${stamp}`]); } catch {}
  try { db.run("DELETE FROM sessions WHERE network_id = ?1 AND alias LIKE ?2", [NET, `bcast-target-%${stamp}`]); } catch {}
});

test("广播落库的 from_session 是调用者的 alias，不是 'hub'", async () => {
  const handler = buildBroadcastHandler();
  const reply = await handler({ message: `[${CALLER}] attribution probe ${stamp}` });
  const body = JSON.parse(reply.content[0].text);
  expect(body.ok).toBe(true);

  const rows = db.all<{ session_name: string; from_session: string | null }>(
    "SELECT session_name, from_session FROM inbox WHERE network_id = ?1 AND type = 'broadcast' AND content LIKE ?2",
    [NET, `%attribution probe ${stamp}%`],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.from_session).toBe(CALLER);
    expect(r.from_session).not.toBe("hub");
  }
  // 两个收件人都应收到，且都记为同一个真实发信人。
  const names = rows.map(r => r.session_name).sort();
  expect(names).toEqual([...TARGETS].sort());
});
