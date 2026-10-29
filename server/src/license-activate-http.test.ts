// `/api/license/activate` 的鉴权 —— 权限审计（2026-10-29）。
//
// 原来这条路由**没有任何鉴权**，而它做的第一件事是 `DELETE FROM licenses`：
// 任何能访问 Hub 的人（含未登录）POST 一个 "anet-" 开头的串就能替换整台 Hub 的授权记录。
//
// 这组用例钉住四件事：
//   1. 未登录 → 401（不能再是「随便一个串就能过」）
//   2. 普通用户 → 403 admin required
//   3. Hub 管理员 → 200，且 licenses 表被替换
//   4. key 形状仍然按原规则校验（400），鉴权不改变原来的输入规则
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-license-auth-"));
const PW = "LicenseAuthPassw0rd!xyz";
let BASE = "";
let hub: any = null;
const U: Record<string, string> = {};

async function send(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

const activate = (token: string | null, key: unknown) => send(token, "POST", "/api/license/activate", { key });
const licenseRows = () => db.all<{ id: string; license_key: string }>("SELECT id, license_key FROM licenses");

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const plain = register(`lic_plain_${stamp}`, PW, undefined, "Plain");
  U.plain = plain.token!;
  const admin = register(`lic_admin_${stamp}`, PW, undefined, "Admin");
  U.admin = admin.token!;
  U.adminId = admin.user!.user_id;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.adminId]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
});
afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

describe("/api/license/activate 鉴权", () => {
  test("未登录 → 401，且不动 licenses 表", async () => {
    const before = licenseRows().length;
    const r = await activate(null, "anet-0000000000000000");
    expect(r.status).toBe(401);
    expect(licenseRows().length).toBe(before);
  });

  test("普通用户 → 403 admin required", async () => {
    const r = await activate(U.plain, "anet-0000000000000000");
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe("admin required");
  });

  test("管理员 → 200，licenses 表被替换（不是叠加）", async () => {
    db.run("INSERT INTO licenses (id, license_key, activated_at) VALUES ('lic_old', 'anet-oldoldoldoldold', datetime('now'))");
    const r = await activate(U.admin, "anet-1111111111111111");
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    const rows = licenseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].license_key).toBe("anet-1111111111111111");
  });

  test("key 形状仍按原规则校验（鉴权不放宽输入）", async () => {
    const r = await activate(U.admin, "not-an-anet-key");
    expect(r.status).toBe(400);
  });
});
