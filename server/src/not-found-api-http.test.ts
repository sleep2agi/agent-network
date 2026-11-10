// #2946 —— 未匹配的 /api/* 必须 404，而不是 200 + 帮助页。
//
// 现场（.193）：带 token 打 /api/lang/status /api/hub/profile /api/nodes/department
// /api/schedules/failures（四个都不存在）→ 全部 200 + 652B 的帮助页文本，
// 字节数完全相同。探针会把「端点改名/拼错」读成「正常」—— 假绿。
// 这与 #2559（401 被伪装成空数据）同类：错误被伪装成成功。
//
// 根路径 `/` 仍然返回帮助页（那是给人/curl 看的入口说明），这条也要钉住，
// 否则修 #2946 时很容易把根路径一起改成 404。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "notfound-2946-"));
process.env.COMMHUB_DB ||= join(dir, "hub.db");
process.env.COMMHUB_AUTH_TOKEN ||= "notfound-2946-master-fixture";

let hub: { stop: (closeActiveConnections?: boolean) => void; port: number } | null = null;
let base = "";
let token = "";

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const { bootServer } = await import("./server.js");
  const a = register(`nf_owner_${Date.now()}`, "NotFou-2946-Strong1!");
  expect(a.ok).toBe(true);
  token = a.token!;
  hub = bootServer({ port: 0, hostname: "127.0.0.1" }) as any;
  base = `http://127.0.0.1:${hub!.port}`;
});

afterAll(() => { try { hub?.stop?.(true); } catch {} });

const call = async (path: string, withToken = true) => {
  const res = await fetch(base + path, {
    headers: withToken ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  return { status: res.status, text };
};

test("不存在的 /api/* 路径返回 404 not_found（不再 200 + 帮助页）", async () => {
  for (const path of ["/api/definitely-not-a-route", "/api/lang/status", "/api/hub/profile"]) {
    const r = await call(path);
    expect(r.status).toBe(404);
    const body = JSON.parse(r.text);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_found");
    expect(body.path).toBe(path);
    // 关键：不再把帮助页伪装成这个端点的返回
    expect(r.text).not.toContain("Streamable HTTP");
  }
});

test("已存在的端点不受影响", async () => {
  const r = await call("/health", false);
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text).ok).toBe(true);
});

test("根路径仍然返回帮助页（不能一起改成 404）", async () => {
  // 认证门在路由之前：/ 也要带 token 才看得到帮助页（不带是 401，本就不变）
  const r = await call("/", true);
  expect(r.status).toBe(200);
  expect(r.text).toContain("CommHub MCP Server");
});
