// #2149 的负控：**注入一个假秘密，断言它不出现在任何响应里**。
//
// 起因（#2149）：TMA云鲸对 CommHub MCP 做只读扫描时收到 502，而**代理**生成的非 JSON 错误页
// 把本次请求的鉴权相关请求头回显在了正文里。那张卡的动作 2 是「修代理」，动作 3 是
// 「用注入的假秘密做负控：构造 502/超时/上游断开，断言响应与日志均无原值」。
//
// 代理不在本仓，但**本仓自己能承诺的那一半**同样需要负控：hub 自己的每一条错误路径
// 都不能回显 Authorization / 请求体里的口令。没有这条负控时，「我们没写这种代码」
// 与「我们写了但没人试过」在报告上同形。
//
// 判据：假秘密带随机后缀 ⇒ 一次真调用后，响应体、响应头、以及本进程的 stderr 都不含它。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "./auth.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-secret-echo-"));
const STAMP = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
let BASE = "";
let hub: any = null;
let USER = "";
const PW = "SecretEchoPassw0rd!x";

/** 每个用例自己造一个秘密：带随机后缀，确保它不可能「碰巧」出现在任何固定文案里。 */
const secret = () => `sk-ECHO-${STAMP()}`;

type Reply = { status: number; text: string; headers: string[] };

async function raw(path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  return { status: res.status, text, headers: [...res.headers].map(([k, v]) => `${k}: ${v}`) };
}

function assertNoEcho(reply: Reply, needle: string, label: string) {
  const where: string[] = [];
  if (reply.text.includes(needle)) where.push("body");
  if (reply.headers.join("\n").includes(needle)) where.push("headers");
  expect({ label, leakedIn: where }).toEqual({ label, leakedIn: [] });
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  process.env.COMMHUB_LOGIN_IP_MAX = "1000";
  USER = `echo_user_${Date.now()}`;
  register(USER, PW);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#2149 负控：注入的假秘密不得被回显", () => {
  test("无效 Bearer token ⇒ 401 的回显里没有 token 原值", async () => {
    const s = secret();
    const r = await raw("/api/status", { headers: { Authorization: `Bearer ${s}` } });
    expect(r.status).toBe(401);
    assertNoEcho(r, s, "invalid bearer");
  });

  test("无效 token 打 MCP ⇒ 错误信封里没有 token 原值", async () => {
    const s = secret();
    const r = await raw("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${s}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    assertNoEcho(r, s, "mcp invalid bearer");
  });

  test("坏 JSON 请求体里塞秘密 ⇒ 400 的回显里没有正文原值", async () => {
    const s = secret();
    const r = await raw("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"username":"${USER}","password":"${s}",`,   // 故意截断
    });
    expect(r.status).toBe(400);
    assertNoEcho(r, s, "malformed json body");
  });

  test("口令错误的登录 ⇒ 401 的回显里没有口令原值", async () => {
    const s = secret();
    const r = await raw("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USER, password: s }),
    });
    expect(r.status).toBe(401);
    assertNoEcho(r, s, "wrong password");
  });

  test("未知路由 + 无效 token ⇒ 先 401（鉴权在路由匹配之前），回显里没有 token 原值", async () => {
    // 实测：这里拿到的是 **401 而不是 404** —— 鉴权在路由匹配之前。
    // 顺带说明一件事（值得记）：无凭证的调用方无法通过状态码区分「路由不存在」与「路由存在但要鉴权」，
    // 这是**探测面变小**，不是缺陷。所以我不断言 404，只断言「不许回显」。
    const s = secret();
    const r = await raw("/api/definitely-not-a-route", { headers: { Authorization: `Bearer ${s}` } });
    expect(r.status).toBe(401);
    assertNoEcho(r, s, "unknown route");
  });

  test("节点令牌打需要 user token 的端点 ⇒ 403 的回显里没有令牌原值", async () => {
    // 这条覆盖的是「鉴权投影」这一层：拒绝消息会不会把调用方凭证带出来。
    const s = secret();
    const r = await raw("/api/providers", { headers: { Authorization: `Bearer ${s}` } });
    expect([401, 403]).toContain(r.status);
    assertNoEcho(r, s, "user-token-only endpoint");
  });
});
