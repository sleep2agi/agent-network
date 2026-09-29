// 登录会话:闲置过期 + 「登录设备」列表 + 退出其他设备。
//
// 生产上 user-login 令牌一次登录一条、从不过期也不回收,泄漏任何一条就等于那个账号(多为管理员)。
// 这里的每一条在 main 上都是红的:main 没有闲置过期(旧令牌永远有效)、登录响应不带 token_id、
// /api/auth/sessions* 端点不存在。正控:在用的会话、显式 API 令牌、节点令牌照常可用。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode, createToken } from "./auth.js";
import { db, hashToken } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-sessions-"));
let BASE = "";
let hub: any = null;
const PW = "SessionsPassw0rd!";
let USER = "", userId = "", NET = "", ntok = "", apiToken = "";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function call(token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? auth(token) : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function loginAs(label?: string, ua = "anet-test-agent/1.0") {
  const r = await call("", "POST", "/api/auth/login", { username: USER, password: PW, ...(label ? { client_label: label } : {}) }, { "User-Agent": ua });
  expect(r.status).toBe(200);
  return r.body as { token: string; token_id: string };
}
// 把某条令牌的「最近使用」拨回 days 天前(created_at 一起拨,模拟一条很早签发、之后没再用过的令牌)。
function ageToken(token: string, days: number) {
  db.run(
    "UPDATE api_tokens SET last_used_at = datetime('now', ?1), created_at = datetime('now', ?1) WHERE token_hash = ?2",
    [`-${days} days`, hashToken(token)],
  );
}
function neverUsed(token: string, days: number) {
  db.run("UPDATE api_tokens SET last_used_at = NULL, created_at = datetime('now', ?1) WHERE token_hash = ?2", [`-${days} days`, hashToken(token)]);
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  // 这里每个用例都真走 POST /api/auth/login 签发会话;默认的每 IP 登录限流会在第 ~20 次开始 429。
  process.env.COMMHUB_LOGIN_IP_MAX = "1000";
  delete process.env.COMMHUB_SESSION_IDLE_DAYS;
  USER = `sess_user_${Date.now()}`;
  const reg = register(USER, PW);
  userId = reg.user!.user_id; NET = reg.network_id!;
  const minted = createNetworkTokenForNode(userId, NET, "sess-node", "node_sess_1");
  expect(minted.ok).toBe(true);
  ntok = minted.token!;
  const api = createToken(userId, "ci-script");
  expect(api.ok).toBe(true);
  apiToken = api.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("login / register identify the issued token", () => {
  test("login returns token_id of the token it returned (and stays backward-compatible)", async () => {
    const r = await call("", "POST", "/api/auth/login", { username: USER, password: PW });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.token).toBe("string");
    expect(r.body.token_id).toMatch(/^tok_/);
    const row = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(r.body.token));
    expect(row.token_id).toBe(r.body.token_id);
  });
  test("register returns token_id", async () => {
    const r = await call("", "POST", "/api/auth/register", { username: `sess_reg_${Date.now()}`, password: PW });
    expect(r.status).toBe(200);
    expect(r.body.token_id).toMatch(/^tok_/);
    const row = db.get<any>("SELECT token_id, name FROM api_tokens WHERE token_hash = ?1", hashToken(r.body.token));
    expect(row.token_id).toBe(r.body.token_id);
    expect(row.name).toBe("user-login");
  });
});

describe("sliding idle expiry (default 30 days)", () => {
  test("a login token idle past the window is rejected with token_expired", async () => {
    const s = await loginAs();
    ageToken(s.token, 31);
    const r = await call(s.token, "GET", "/api/auth/me");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("token_expired");
    // 同一条 401 改写也覆盖走统一 requireAuth 的 REST 端点
    const r2 = await call(s.token, "GET", "/api/sessions");
    expect(r2.status).toBe(401);
    expect(r2.body.error).toBe("token_expired");
  });
  test("a login token that was never used counts idle time from created_at", async () => {
    const s = await loginAs();
    neverUsed(s.token, 45);
    const r = await call(s.token, "GET", "/api/auth/me");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("token_expired");
  });
  test("an old but recently used login token stays valid (the window slides)", async () => {
    const s = await loginAs();
    // 90 天前签发,2 天前还在用
    db.run("UPDATE api_tokens SET created_at = datetime('now', '-90 days'), last_used_at = datetime('now', '-2 days') WHERE token_hash = ?1", [hashToken(s.token)]);
    const r = await call(s.token, "GET", "/api/auth/me");
    expect(r.status).toBe(200);
    // 使用把 last_used_at 推到现在(超过节流间隔,必须写)
    const row = db.get<any>("SELECT last_used_at >= datetime('now', '-60 seconds') AS fresh FROM api_tokens WHERE token_hash = ?1", hashToken(s.token));
    expect(row.fresh).toBe(1);
  });
  test("last_used_at is written at most once per hour per token", async () => {
    const s = await loginAs();
    db.run("UPDATE api_tokens SET last_used_at = datetime('now', '-10 minutes') WHERE token_hash = ?1", [hashToken(s.token)]);
    const before = db.get<any>("SELECT last_used_at FROM api_tokens WHERE token_hash = ?1", hashToken(s.token)).last_used_at;
    expect((await call(s.token, "GET", "/api/auth/me")).status).toBe(200);
    const after = db.get<any>("SELECT last_used_at FROM api_tokens WHERE token_hash = ?1", hashToken(s.token)).last_used_at;
    expect(after).toBe(before);
  });
  test("a truly invalid token still says invalid, not expired", async () => {
    const r = await call("utok_00000000000000000000000000000000", "GET", "/api/auth/me");
    expect(r.status).toBe(401);
    expect(r.body.error).not.toBe("token_expired");
  });
  test("node tokens and explicit API tokens never idle-expire", async () => {
    neverUsed(ntok, 400);
    neverUsed(apiToken, 400);
    const n = await call(ntok, "GET", "/api/auth/me");
    expect(n.status).toBe(200);
    expect(n.body.credential.kind).toBe("node");
    expect((await call(apiToken, "GET", "/api/auth/me")).status).toBe(200);
  });
  test("COMMHUB_SESSION_IDLE_DAYS configures the window; 0 disables it", async () => {
    const s = await loginAs();
    ageToken(s.token, 10);
    process.env.COMMHUB_SESSION_IDLE_DAYS = "7";
    try {
      expect((await call(s.token, "GET", "/api/auth/me")).body.error).toBe("token_expired");
      process.env.COMMHUB_SESSION_IDLE_DAYS = "0";
      expect((await call(s.token, "GET", "/api/auth/me")).status).toBe(200);
    } finally {
      delete process.env.COMMHUB_SESSION_IDLE_DAYS;
    }
  });
});

describe("GET /api/auth/sessions", () => {
  test("lists my live login sessions with label, user agent and is_current", async () => {
    const a = await loginAs("Android · 0.2.150", "okhttp/4");
    const b = await loginAs("macOS · 0.2.150", "Mozilla/5.0 (Macintosh)");
    const dead = await loginAs("stale");
    ageToken(dead.token, 40);
    const r = await call(b.token, "GET", "/api/auth/sessions");
    expect(r.status).toBe(200);
    expect(r.body.idle_timeout_days).toBe(30);
    expect(r.body.current_token_id).toBe(b.token_id);
    const ids = r.body.sessions.map((x: any) => x.token_id);
    expect(ids).toContain(a.token_id);
    expect(ids).toContain(b.token_id);
    expect(ids).not.toContain(dead.token_id);
    const me = r.body.sessions.find((x: any) => x.token_id === b.token_id);
    expect(me.is_current).toBe(true);
    expect(me.client_label).toBe("macOS · 0.2.150");
    expect(me.user_agent).toBe("Mozilla/5.0 (Macintosh)");
    expect(typeof me.created_at).toBe("string");
    const other = r.body.sessions.find((x: any) => x.token_id === a.token_id);
    expect(other.is_current).toBe(false);
    expect(other.client_label).toBe("Android · 0.2.150");
    // 不泄漏令牌本身或哈希;API 令牌和节点令牌不在列表里
    expect(JSON.stringify(r.body)).not.toContain("token_hash");
    expect(JSON.stringify(r.body)).not.toContain(b.token);
    expect(r.body.sessions.every((x: any) => x.name !== "ci-script" && !String(x.name).startsWith("node:"))).toBe(true);
  });
  test("node tokens get 403 user_token_required", async () => {
    const r = await call(ntok, "GET", "/api/auth/sessions");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });
  test("no token → 401", async () => {
    expect((await call("", "GET", "/api/auth/sessions")).status).toBe(401);
  });
});

describe("revoking sessions", () => {
  test("revoke-others keeps the current token and leaves API and node tokens alone", async () => {
    const keep = await loginAs("keep");
    const other1 = await loginAs("other1");
    const other2 = await loginAs("other2");
    const r = await call(keep.token, "POST", "/api/auth/sessions/revoke-others");
    expect(r.status).toBe(200);
    expect(r.body.kept_token_id).toBe(keep.token_id);
    expect(r.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await call(keep.token, "GET", "/api/auth/me")).status).toBe(200);
    expect((await call(other1.token, "GET", "/api/auth/me")).status).toBe(401);
    expect((await call(other2.token, "GET", "/api/auth/me")).status).toBe(401);
    expect((await call(ntok, "GET", "/api/auth/me")).status).toBe(200);
    expect((await call(apiToken, "GET", "/api/auth/me")).status).toBe(200);
    const list = await call(keep.token, "GET", "/api/auth/sessions");
    expect(list.body.sessions.map((x: any) => x.token_id)).toEqual([keep.token_id]);
    const audit = db.get<any>("SELECT detail FROM audit_log WHERE action = 'sessions_revoked_others' AND target_id = ?1", keep.token_id);
    expect(audit?.detail).toMatch(/^revoked=\d+$/);
  });
  test("revoke-others refuses node tokens and non-session tokens", async () => {
    const r = await call(ntok, "POST", "/api/auth/sessions/revoke-others");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
    const s = await loginAs("survivor");
    const viaApi = await call(apiToken, "POST", "/api/auth/sessions/revoke-others");
    expect(viaApi.status).toBe(403);
    expect(viaApi.body.error).toBe("session_token_required");
    expect((await call(s.token, "GET", "/api/auth/me")).status).toBe(200);
  });
  test("DELETE /api/auth/sessions/:id revokes one other session", async () => {
    const me = await loginAs("me");
    const victim = await loginAs("victim");
    const r = await call(me.token, "DELETE", `/api/auth/sessions/${victim.token_id}`);
    expect(r.status).toBe(200);
    expect(r.body.was_current).toBe(false);
    expect((await call(victim.token, "GET", "/api/auth/me")).status).toBe(401);
    expect((await call(me.token, "GET", "/api/auth/me")).status).toBe(200);
    expect(db.get<any>("SELECT 1 AS x FROM audit_log WHERE action = 'session_revoked' AND target_id = ?1", victim.token_id)?.x).toBe(1);
  });
  test("DELETE of my own session is a logout", async () => {
    const me = await loginAs("logout");
    const r = await call(me.token, "DELETE", `/api/auth/sessions/${me.token_id}`);
    expect(r.status).toBe(200);
    expect(r.body.was_current).toBe(true);
    expect((await call(me.token, "GET", "/api/auth/me")).status).toBe(401);
  });
  test("DELETE cannot reach API tokens, node tokens, or another user's session", async () => {
    const me = await loginAs("guard");
    const apiRow = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(apiToken));
    const ntokRow = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(ntok));
    expect((await call(me.token, "DELETE", `/api/auth/sessions/${apiRow.token_id}`)).status).toBe(404);
    expect((await call(me.token, "DELETE", `/api/auth/sessions/${ntokRow.token_id}`)).status).toBe(404);
    const stranger = register(`sess_stranger_${Date.now()}`, PW);
    expect((await call(me.token, "DELETE", `/api/auth/sessions/${stranger.token_id}`)).status).toBe(404);
    expect((await call(stranger.token!, "GET", "/api/auth/me")).status).toBe(200);
    expect((await call(ntok, "DELETE", `/api/auth/sessions/${me.token_id}`)).status).toBe(403);
    expect((await call(me.token, "GET", "/api/auth/me")).status).toBe(200);
  });
});
