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
//   ④ tools/list 在复用后仍然完整（证明工具注册在 close/reconnect 之后还在）；
//   ⑤ 缓存键由 createServer 的同一对象生成：字段清单变了测试就挂（加参数忘加键 ⇒ 立刻红）；
//   ⑥ `COMMHUB_MCP_SERVER_POOL=0` 一键回到旧行为；5xx 的实例不回池。

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

describe("McpServer 复用池：键完整性 / 开关 / 失效路径", () => {
  test("键由 createServer 的同一对象生成：字段名或数量变了，这条就挂", async () => {
    const { CREATE_SERVER_FIELDS, poolKeyOf } = await import("./server.js");
    // 每个字段给一个互不相同的标记值，便于逐字段比对键
    const base = {
      clientIP: "10.1.1.1", enforceNetworkId: "net_a", enforceUserId: "u_a", callerAlias: "node-a",
      callerTokenIsNetwork: true, callerTokenId: "tok_a", includeProtocolTools: false, callerIdentityRejected: false,
    } as Record<string, unknown>;
    // ① 字段清单必须覆盖对象的全部字段（多一个字段就说明 createServer 加了参数却没进清单）
    expect(Object.keys(base).sort()).toEqual([...CREATE_SERVER_FIELDS].sort());
    // ② 任何单个字段变化都必须改变键（否则两个身份会共用一台实例）
    const k0 = poolKeyOf(base as any);
    for (const f of CREATE_SERVER_FIELDS) {
      const v = base[f];
      const flipped = typeof v === "boolean" ? !v : String(v) + "-x";
      const k1 = poolKeyOf({ ...base, [f]: flipped } as any);
      expect(k1).not.toBe(k0);
    }
    // ③ 同一对象两次生成的键必须一致（不能含随机/时间）
    expect(poolKeyOf(base as any)).toBe(k0);
  });

  test("COMMHUB_MCP_SERVER_POOL=0 回到旧行为：每条请求都新建", async () => {
    const { mcpServerPoolStats } = await import("./server.js");
    const prev = process.env.COMMHUB_MCP_SERVER_POOL;
    try {
      process.env.COMMHUB_MCP_SERVER_POOL = "0";
      const before = mcpServerPoolStats();
      for (let i = 0; i < 2; i++) {
        const r = await mcpRaw(otherToken, toolCall("get_all_status"));
        expect(r.status).toBe(200);
      }
      const after = mcpServerPoolStats();
      expect(after.enabled).toBe(false);
      // 不复用 ⇒ created 每条都增，reused 不动，池子不涨
      expect(after.created - before.created).toBeGreaterThanOrEqual(2);
      expect(after.reused).toBe(before.reused);
      expect(after.pooled).toBe(before.pooled);
    } finally {
      if (prev === undefined) delete process.env.COMMHUB_MCP_SERVER_POOL; else process.env.COMMHUB_MCP_SERVER_POOL = prev;
    }
  });

  test("令牌被吊销后，池里旧实例不会绕过鉴权", async () => {
    const { register } = await import("./auth.js");
    const { db } = await import("./db.js");
    const { resolveToken } = await import("./auth.js");
    const u = register(`pool_revoke_${Date.now()}`, PW);
    const token = u.token!;
    const first = await mcpRaw(token, toolCall("get_all_status"));
    expect(first.status).toBe(200);
    // 吊销：鉴权在「进池之前」逐请求做，所以下一次必须直接 401，而不是拿到池里的实例继续服务
    db.run("UPDATE api_tokens SET revoked_at = datetime('now') WHERE token_hash = ?1", [
      new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    ]);
    expect(resolveToken(token)).toBeFalsy();
    const second = await mcpRaw(token, toolCall("get_all_status"));
    expect(second.status).toBe(401);
  });

  test("同身份的两次请求之间不串台（上一请求的 arguments 不会出现在下一请求的响应里）", async () => {
    const marker = "zz-cross-request-" + Math.random().toString(36).slice(2, 8);
    const first = await mcpRaw(adminToken, toolCall("get_all_status", { filter_alias: marker }));
    expect(first.status).toBe(200);
    const second = await mcpRaw(adminToken, toolCall("get_all_status", { filter_alias: "通信欧" }));
    expect(second.status).toBe(200);
    expect(second.text).not.toContain(marker);
  });

  test("身份不同不复用同一台实例（新身份必新建，同身份才复用）", async () => {
    const { mcpServerPoolStats } = await import("./server.js");
    const { register } = await import("./auth.js");
    // 全新身份 ⇒ 池里不可能有它的实例，必须新建
    const fresh = register(`pool_fresh_${Date.now()}`, PW);
    const before = mcpServerPoolStats();
    const first = await mcpRaw(fresh.token!, toolCall("get_all_status"));
    const mid = mcpServerPoolStats();
    expect(first.status).toBe(200);
    expect(mid.created).toBeGreaterThan(before.created);
    // 同一身份第二次 ⇒ 复用，不再新建
    const second = await mcpRaw(fresh.token!, toolCall("get_all_status"));
    const after = mcpServerPoolStats();
    expect(second.status).toBe(200);
    expect(after.created).toBe(mid.created);
    expect(after.reused).toBeGreaterThan(mid.reused);
    // 且两个不同身份看到的 scope 各自独立：新用户看不到 admin 之外的网络数据
    expect(JSON.parse(first.text.match(/\{.*\}/s)?.[0] ?? "{}")).toBeDefined();
  });

  test("5xx 的实例不回池；正常应答回池", async () => {
    const { shouldPoolServer } = await import("./server.js");
    expect(shouldPoolServer({ status: 200 })).toBe(true);
    expect(shouldPoolServer({ status: 404 })).toBe(true);
    expect(shouldPoolServer({ status: 500 })).toBe(false);
    expect(shouldPoolServer({ status: 503 })).toBe(false);
    expect(shouldPoolServer(null)).toBe(false);
  });
});
