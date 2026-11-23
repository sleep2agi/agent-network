// McpServer 复用池（2026-11-23 生产卡顿修复的回归闸门）。
//
// 背景：每条 POST /mcp 原本都 `new McpServer()` + 注册 105 个工具（zod → JSON Schema），
// 本地 455 会话库实测「只发 JSON-RPC ping、完全不跑工具」也要 ~30 ms CPU/请求；
// 线上 ≈28 req/s 的节点轮询下这一项就吃满一个核。现在按调用方上下文复用同一台 server，
// 复用只在 **上下文完全相同** 时发生（身份 / 网络 / 别名 / 是否节点令牌 / 是否要协议工具），
// 复用时仍走 connect → handleRequest → close，所以协议行为不变。
//
// 这个套件钉住：
//   ① 连续同上下文请求会复用（reused 增长，created 不跟着涨）；
//   ② 换一个身份不会被复用（键不同 ⇒ created 继续增），即不会有越权状态串台；
//   ③ 复用之前先出过一次错误（未知工具 / 非法 JSON）也不影响下一次请求；
//   ④ tools/list 在复用后仍然完整（证明工具注册在 close/reconnect 之后还在）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-mcp-pool-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "McpPoolPassw0rd!";
let BASE = "";
let hub: any = null;
let adminToken = "";
let otherToken = "";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };

async function mcpRaw(token: string, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, ...MCP_HEADERS }, body });
  return { status: res.status, text: await res.text() };
}

function rpc(text: string): any {
  const lines = text.split("\n").filter(x => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(text);
}

const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register } = await import("./auth.js");
  const { db } = await import("./db.js");
  const a = register(`pool_admin_${Date.now()}`, PW);
  adminToken = a.token!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  const b = register(`pool_other_${Date.now()}`, PW);
  otherToken = b.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("McpServer 复用池", () => {
  test("同上下文连续请求：复用而不是每请求重建", async () => {
    const { mcpServerPoolStats } = await import("./server.js");
    // 先打一次建立该上下文的 server（可能是池里第一条）
    const first = await mcpRaw(adminToken, toolCall("get_all_status"));
    expect(first.status).toBe(200);
    expect(rpc(first.text).result).toBeDefined();
    const after1 = mcpServerPoolStats();
    // 再打两次同样的调用：不该再新建，应该复用
    for (let i = 0; i < 2; i++) {
      const r = await mcpRaw(adminToken, toolCall("get_all_status"));
      expect(r.status).toBe(200);
      expect(rpc(r.text).result).toBeDefined();
    }
    const after3 = mcpServerPoolStats();
    expect(after3.reused).toBeGreaterThan(after1.reused);
    expect(after3.created).toBe(after1.created);
  });

  test("换一个身份不会复用上一身份的 server（键含身份）", async () => {
    const { mcpServerPoolStats } = await import("./server.js");
    const before = mcpServerPoolStats();
    const r = await mcpRaw(otherToken, toolCall("get_all_status"));
    expect(r.status).toBe(200);
    const after = mcpServerPoolStats();
    expect(after.created).toBeGreaterThan(before.created);
  });

  test("并发同上下文请求：都用得上、池子不会被并发搞坏", async () => {
    const { mcpServerPoolStats } = await import("./server.js");
    const before = mcpServerPoolStats();
    const results = await Promise.all(Array.from({ length: 10 }, () => mcpRaw(adminToken, toolCall("get_all_status", { filter_alias: "nobody-" + Math.random() }))));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(rpc(r.text).error).toBeUndefined();
    }
    const after = mcpServerPoolStats();
    // 并发时同一台不能同时接两条（connect 会拒），所以最多新建并发数量级；关键是别超过并发数。
    expect(after.created - before.created).toBeLessThanOrEqual(10);
  });

  test("出过错的那台 server 复用后仍能正常服务，工具注册没丢", async () => {
    const bad = await mcpRaw(adminToken, toolCall("__definitely_not_a_tool__"));
    expect(bad.status).toBe(200);
    const badBody = rpc(bad.text);
    // MCP 的「工具不存在」是 result.isError（协议层不是 error），两种都算作「出过错」。
    expect(badBody.error ?? badBody.result?.isError).toBeDefined();
    const broken = await mcpRaw(adminToken, `{"jsonrpc":"2.0","method":"tools/list",`);
    expect(broken.text.length).toBeGreaterThan(0);
    const good = await mcpRaw(adminToken, toolCall("get_all_status", { filter_alias: "nobody-at-all" }));
    expect(good.status).toBe(200);
    const body = rpc(good.text);
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const list = await mcpRaw(adminToken, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    const tools = rpc(list.text).result.tools as any[];
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.some(t => t.name === "get_all_status")).toBe(true);
  });
});
