// 鉴权层的**形状**：同一条未认证请求，最终是谁答的。
//
// ## 为什么要钉这个
//
// 2026-11-01（#3374）：34 条写路由逐条发未认证请求，响应体分三种：
//
//     {"error":"unauthorized"}                ⇒ 全局鉴权层先答 ⇒ handler 内那条 401 分支**从不执行**
//     {"ok":false,"error":"auth required"}    ⇒ handler 自己就是门
//     {"ok":false,"error":"token required"}   ⇒ handler 自己就是门（另一句文案）
//
// 这三者对外都是「401」，对内却决定「那条分支是否可达」。差别不是风格：
// 把第二种当成第一种删掉，就等于删掉一道真的门（实测 18 条是这种）。
//
// ## 这张表断言什么
//
// 每行：一条路由 + 它今天由谁答。它钉的是**分层**，不是措辞：
// 措辞变了不算破坏契约，但**答话的人变了**是 —— 那意味着有一道门换了位置。
//
// ## 它是抽样（12 条），不是全集
//
// 全集的分档要么逐条请求（脚本 report-inner-auth-branches.py 记录方法），
// 要么需要可枚举的中间件栈（本仓没有）。这张表选的是**每类各取几条**，
// 目的是让「分层被改动」这件事变红，而不是声称覆盖率。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "./auth.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-auth-layer-"));
const PW = "AuthLayerPassw0rd!";
let BASE = "";
let hub: any = null;
let NET = "";

type Shape = "global_unauthorized" | "handler_auth" | "handler_token" | "public_input";

const classify = (status: number, body: string): Shape => {
  if (body.includes('"unauthorized"')) return "global_unauthorized";
  if (body.includes('"auth required"')) return "handler_auth";
  if (body.includes('"token required"')) return "handler_token";
  return "public_input"; // 公开路由：直接进入参数校验
};

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`al_${Date.now()}`, PW);
  NET = a.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// [方法, 路径, 今天由谁答, 备注]
const TABLE: Array<[string, string, Shape, string]> = [
  ["GET", "/api/nodes", "global_unauthorized", "读路由，全局层先答"],
  ["GET", "/api/providers", "global_unauthorized", "读路由"],
  ["PUT", "/api/providers", "global_unauthorized", "写路由，全局层先答"],
  ["GET", "/api/networks/:NET/node-permission-report", "global_unauthorized", "报表"],
  ["POST", "/api/auth/tokens", "handler_auth", "handler 自己就是门（换令牌的入口不能被别的层替它把关）"],
  ["POST", "/api/node-rename/prepare", "handler_auth", "同上"],
  ["POST", "/api/node-rename/commit", "handler_auth", "同上"],
  ["DELETE", "/api/auth/tokens/tok_x", "handler_auth", "同上"],
  ["PUT", "/api/auth/me", "handler_token", "handler 取 token 并给出 token required"],
  ["POST", "/api/networks", "handler_token", "同上"],
  ["POST", "/api/auth/register", "public_input", "按设计公开：直接进参数校验"],
  ["POST", "/api/auth/login", "public_input", "按设计公开"],
];

describe("鉴权层形状（谁答这条未认证请求）", () => {
  for (const [method, rawPath, expected, why] of TABLE) {
    const path = rawPath.replace(":NET", "net_placeholder");
    test(`${method} ${rawPath} ⇒ ${expected}（${why}）`, async () => {
      const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}network_id=${NET}`;
      const r = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      const body = await r.text();
      expect(classify(r.status, body)).toBe(expected);
    });
  }

  // 分层被改动时，最容易被误判的是这两条：它们**不是**全局层答的。
  test("抽查：handler 就是门的那几条，响应体里带 ok:false（不是裸 error）", async () => {
    const r = await fetch(`${BASE}/api/auth/tokens?network_id=${NET}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const body = await r.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth required");
  });
});
