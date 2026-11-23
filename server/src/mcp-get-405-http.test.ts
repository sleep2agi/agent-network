// GET /mcp = 405（2026-11-23）：stateless Hub 不提供 MCP standalone SSE 流。
//
// 为什么钉住：线上 `GET /mcp` 曾是 8 次/秒、单次 14ms —— 每条都先建一台 McpServer
// （105 个工具的注册）才被 SDK 判掉，而这条流本身**从来推不出任何东西**（transport 每请求
// 新建、响应后即 close）。现在改成在建实例之前直接 405（MCP 规范允许；SDK 客户端对 405
// 的处理是「正常情况、直接返回、不重连」）。
//
// 这个套件钉住四件事：
//   ① 带 Accept: text/event-stream 的 GET 也是 405 + Allow（不再开流）；
//   ② 不带的 GET 同样 405 + Allow；
//   ③ 这两种请求都**不增加** MCP 在飞计数（短路在 enterMcpInflight() 之前），也不产生 SSE 流；
//   ④ 紧接着的 POST /mcp tools/call 照常工作（短路没有波及正常请求）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-mcp-get405-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "McpGet405Passw0rd!";
let BASE = "";
let hub: any = null;
let token = "";

const BASE_HEADERS = { "MCP-Protocol-Version": "2025-03-26" };

async function getMcp(accept?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...BASE_HEADERS };
  if (accept !== undefined) headers.Accept = accept;
  const res = await fetch(`${BASE}/mcp`, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, allow: res.headers.get("allow"), text };
}

async function postToolCall() {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...BASE_HEADERS },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_all_status", arguments: {} } }),
  });
  const text = await res.text();
  const line = text.split("\n").filter(l => l.startsWith("data:")).pop() ?? text;
  return { status: res.status, body: JSON.parse(line.replace(/^data:\s*/, "")) };
}

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register } = await import("./auth.js");
  const { db } = await import("./db.js");
  const a = register(`mcp405_${Date.now()}`, PW);
  token = a.token!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /mcp 一律 405（建实例之前）", () => {
  test("带 Accept: text/event-stream 也是 405 + Allow，且不计入在飞、不开流", async () => {
    const { getMcpInflightStats } = await import("./mcp-inflight.js");
    const before = getMcpInflightStats().inflight;
    const r = await getMcp("text/event-stream");
    expect(r.status).toBe(405);
    expect(r.allow ?? "").toContain("POST");
    // 短路发生在 enterMcpInflight() 之前 ⇒ 在飞计数不变；且响应是普通 JSON 而不是 SSE 流。
    expect(getMcpInflightStats().inflight).toBe(before);
    expect(r.text).toContain("-32000");
    expect(r.text).not.toContain("event: message");
  });

  test("不带 Accept 的 GET 同样 405 + Allow，同样不进入在飞计数", async () => {
    const { getMcpInflightStats } = await import("./mcp-inflight.js");
    const before = getMcpInflightStats().inflight;
    const r = await getMcp();
    expect(r.status).toBe(405);
    expect(r.allow ?? "").toContain("POST");
    expect(getMcpInflightStats().inflight).toBe(before);
  });

  test("紧接着 POST /mcp tools/call 照常工作", async () => {
    const r = await postToolCall();
    expect(r.status).toBe(200);
    expect(r.body.error).toBeUndefined();
    expect(r.body.result).toBeDefined();
  });
});
