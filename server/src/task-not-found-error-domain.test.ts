// #3309 读数覆盖第九批 —— 一个错误字面量，三个工具共用：
//
//   "task not found"   ← retry_task / get_task / reassign_task
//
// 它此前在测试里一次都没出现过。而它正是最容易一直没人断言的那一类：
// **一句读起来像文案的英文短语**。所有人都会以为它「肯定被测过」，
// 而按字符串去找，一次都没有。
//
// 为什么值得单独钉：这三个工具在「id 打错了」时都落到同一句话，
// 而它们的补救完全不同（重试另一个 id / 查另一个 id / 把它派给别人）。
// 一旦有人为了「更友好」把其中一处改成 `task_not_found`，只有断言能发现。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_9th_err";
const USER = "u_9th_owner";
const ALIAS = "9th-node";

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

beforeEach(seed);
afterAll(cleanup);

describe('#3309 「task not found」：三个工具共用同一句话', () => {
  test("三个工具在不存在的 id 上给出**同一句**（逐字相同）", async () => {
    const missing = "task_9th_does_not_exist";
    const got = [
      await call("get_task", { task_id: missing }),
      await call("retry_task", { task_id: missing }),
      await call("reassign_task", { task_id: missing, to_name: "someone-else" }),
    ];
    for (const [i, r] of got.entries()) {
      expect(r.ok, `第 ${i + 1} 个工具应当拒绝`).toBe(false);
      // 逐字相同是**故意的**：调用方按这一句分支；改一处就多出一种拼写。
      expect(r.error, `第 ${i + 1} 个工具的 error 应当是同一句`).toBe("task not found");
    }
    // 三处必须真的同一个字符串 —— 任何一个被「统一成 code」都会让这条红。
    expect(new Set(got.map((r) => r.error)).size, "三个工具不该给出不同拼写").toBe(1);
  });

  test("这句话**带空格**（不是 code 风格）—— 现状，记下来", async () => {
    const r = await call("get_task", { task_id: "task_9th_missing" });
    // 带空格的值最容易被当成文案而没人断言；这条测试存在的理由是把它钉成契约。
    expect(String(r.error)).toContain(" ");
    expect(String(r.error)).not.toMatch(/^[a-z0-9_]+$/);
  });
});
