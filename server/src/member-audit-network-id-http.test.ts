// 成员增 / 改角色 / 移出 的审计行必须带 network_id —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 之前这三条 logAudit 没传 networkId,audit_log.network_id 恒为 NULL:
// 按网络归属审计时它们整批丢失,而同一组路由里的 member_agent_grants_changed 一直带着。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-member-audit-"));
let BASE = "";
let hub: any = null;

const PW = "AuditTestPassw0rd!x";
let ownerToken = "";
let NET = "";
let bobId = "";

async function send(token: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

const auditRow = (action: string) =>
  db.get("SELECT network_id, target_id FROM audit_log WHERE action = ?1 ORDER BY id DESC LIMIT 1", action) as
    { network_id: string | null; target_id: string | null } | null;

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const owner = register(`audit_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  NET = owner.network_id!;
  const bob = register(`audit_bob_${Date.now()}`, PW, undefined, "Bob");
  expect(bob.ok).toBe(true);
  bobId = bob.user!.user_id;

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("成员审计行带 network_id", () => {
  test("member_added", async () => {
    const r = await send(ownerToken, "POST", `/api/networks/${NET}/members`, { user_id: bobId, role: "member" });
    expect(r.status).toBe(200);
    const row = auditRow("member_added");
    expect(row).toBeTruthy();
    expect(row!.network_id).toBe(NET);
  });

  test("member_role_changed", async () => {
    const r = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, { role: "viewer" });
    expect(r.status).toBe(200);
    const row = auditRow("member_role_changed");
    expect(row).toBeTruthy();
    expect(row!.network_id).toBe(NET);
  });

  test("member_removed", async () => {
    const r = await send(ownerToken, "DELETE", `/api/networks/${NET}/members/${bobId}`);
    expect(r.status).toBe(200);
    const row = auditRow("member_removed");
    expect(row).toBeTruthy();
    expect(row!.network_id).toBe(NET);
  });

  test("GET /api/audit-log(本人的审计)里这三条的 network_id 都是该网络", async () => {
    const r = await send(ownerToken, "GET", "/api/audit-log?limit=200");
    expect(r.status).toBe(200);
    const mine = (r.body.logs as any[]).filter(e => ["member_added", "member_role_changed", "member_removed"].includes(e.action));
    expect(mine.map(e => e.action).sort()).toEqual(["member_added", "member_removed", "member_role_changed"]);
    for (const e of mine) expect(e.network_id).toBe(NET);
  });
});
