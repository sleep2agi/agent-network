// #513(#502 anet CLI 审计):`anet logout` 要在 Hub 上撤销登录会话,`anet init` /
// `anet login --hub` 换 Hub 时不能把旧 Hub 的 token 带过去。
//
// 全部对着进程内的假 Hub(随机端口)+ 临时 HOME 跑真 CLI,断言落在假 Hub 的请求日志上。
// 🔴 不碰真实 HOME、不碰任何真实 Hub。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLocalCredentials, describeRevokeOutcome, normalizeHubUrl, revokeCurrentLoginSession, sameHub,
} from "./cli-auth-session";

type Mode = "modern" | "old" | "api-token" | "expired";
type Logged = { method: string; path: string; auth: string };

const SESSION_TOKEN = "utok_" + "s".repeat(40);
const OTHER_TOKEN = "utok_" + "o".repeat(40);

function fakeHub(mode: Mode) {
  const log: Logged[] = [];
  const revoked = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("Authorization") ?? "";
      log.push({ method: req.method, path: url.pathname, auth });
      const token = auth.replace(/^Bearer /, "");
      const tokenId = token ? `tok_${token.slice(5, 9)}` : "";
      if (url.pathname === "/health") return Response.json({ ok: true, version: "0.0.0-fake", sessions_count: 0, sse_connections: 0 });
      if (mode === "old") return new Response("Not Found", { status: 404 });
      if (mode === "expired" || revoked.has(token) || !token) {
        return Response.json({ ok: false, error: "token_expired" }, { status: 401 });
      }
      if (url.pathname === "/api/auth/me") return Response.json({ ok: true, user: { username: "u", user_id: "usr_1" }, current_network: null });
      if (url.pathname === "/api/auth/sessions" && req.method === "GET") {
        return Response.json({ ok: true, current_token_id: tokenId, sessions: [], idle_timeout_days: 30 });
      }
      const m = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        if (mode === "api-token" || m[1] !== tokenId) return Response.json({ ok: false, error: "session_not_found" }, { status: 404 });
        revoked.add(token);
        return Response.json({ ok: true, was_current: true });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, log, revoked, stop: () => server.stop(true) };
}

async function deadHubUrl(): Promise<string> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tempHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "anet-513-"));
  temps.push(home);
  mkdirSync(join(home, ".anet"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".anet", "config.json"), JSON.stringify(config), { mode: 0o600 });
  return home;
}
const readConfig = (home: string) => JSON.parse(readFileSync(join(home, ".anet", "config.json"), "utf8"));

const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;

async function runCli(home: string, args: string[], cli = CLI) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANET_|COMMHUB_)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home; env.USERPROFILE = home; env.NO_COLOR = "1";
  const p = Bun.spawn(["bun", cli, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, all: out + err, code };
}

describe("revokeCurrentLoginSession(判据)", () => {
  test("modern hub:GET sessions 拿 current_token_id → DELETE 那一条,两次都带同一个 token", async () => {
    const hub = fakeHub("modern");
    try {
      const o = await revokeCurrentLoginSession(hub.url + "/", SESSION_TOKEN);
      expect(o).toEqual({ kind: "revoked", tokenId: "tok_ssss" });
      expect(hub.log.map(l => `${l.method} ${l.path}`)).toEqual(["GET /api/auth/sessions", "DELETE /api/auth/sessions/tok_ssss"]);
      expect(hub.log.every(l => l.auth === `Bearer ${SESSION_TOKEN}`)).toBe(true);
      expect(hub.revoked.has(SESSION_TOKEN)).toBe(true);
    } finally { hub.stop(); }
  });

  test("旧 Hub(没有 /api/auth/sessions → 404)= unsupported,不是 revoked", async () => {
    const hub = fakeHub("old");
    try { expect(await revokeCurrentLoginSession(hub.url, SESSION_TOKEN)).toEqual({ kind: "unsupported", status: 404 }); }
    finally { hub.stop(); }
  });

  test("API 令牌:DELETE 回 404 session_not_found = not_a_session(仍有效)", async () => {
    const hub = fakeHub("api-token");
    try {
      const o = await revokeCurrentLoginSession(hub.url, SESSION_TOKEN);
      expect(o.kind).toBe("not_a_session");
      expect(describeRevokeOutcome(o, hub.url).ok).toBe(false);
    } finally { hub.stop(); }
  });

  test("401 = already_invalid(算成功,没东西可撤)", async () => {
    const hub = fakeHub("expired");
    try {
      const o = await revokeCurrentLoginSession(hub.url, SESSION_TOKEN);
      expect(o).toEqual({ kind: "already_invalid" });
      expect(describeRevokeOutcome(o, hub.url).ok).toBe(true);
    } finally { hub.stop(); }
  });

  test("连不上 = unreachable", async () => {
    const o = await revokeCurrentLoginSession(await deadHubUrl(), SESSION_TOKEN);
    expect(o.kind).toBe("unreachable");
  });

  test("任何结果的文案都不含 token 本身", () => {
    const outcomes = [
      { kind: "revoked", tokenId: "tok_1" }, { kind: "already_invalid" }, { kind: "not_a_session" },
      { kind: "unsupported", status: 404 }, { kind: "unreachable", error: "ECONNREFUSED" }, { kind: "failed", status: 500, error: "x" },
    ] as const;
    for (const o of outcomes) expect(describeRevokeOutcome(o, "http://h").lines.join("\n")).not.toContain("utok_");
  });

  test("辅助函数", () => {
    expect(normalizeHubUrl(" http://a:1// ")).toBe("http://a:1");
    expect(sameHub("http://a:1/", "http://a:1")).toBe(true);
    expect(sameHub("http://a:1", "http://b:1")).toBe(false);
    expect(clearLocalCredentials({ hub: "h", token: "t", user: {}, network_id: "n", network_name: "x", other: 1 }))
      .toEqual({ hub: "h", other: 1 });
  });
});

describe("anet logout(真 CLI · 临时 HOME · 假 Hub)", () => {
  test("撤销服务端会话(用的就是保存的那个 token)并删除本地登录态,exit 0", async () => {
    const hub = fakeHub("modern");
    try {
      const home = tempHome({ hub: hub.url, token: SESSION_TOKEN, user: { username: "u" }, network_id: "net_1", network_name: "n" });
      const r = await runCli(home, ["logout"]);
      expect(r.code).toBe(0);
      const del = hub.log.filter(l => l.method === "DELETE");
      expect(del).toEqual([{ method: "DELETE", path: "/api/auth/sessions/tok_ssss", auth: `Bearer ${SESSION_TOKEN}` }]);
      expect(hub.revoked.has(SESSION_TOKEN)).toBe(true);
      expect(readConfig(home)).toEqual({ hub: hub.url });
      expect(r.all).toContain("Revoked the login session");
      expect(r.all).not.toContain(SESSION_TOKEN);
    } finally { hub.stop(); }
  }, 30_000);

  test("旧 Hub 404:本地照删,警告「服务端仍有效」+ 怎么撤,exit 0", async () => {
    const hub = fakeHub("old");
    try {
      const home = tempHome({ hub: hub.url, token: SESSION_TOKEN });
      const r = await runCli(home, ["logout"]);
      expect(r.code).toBe(0);
      expect(readConfig(home).token).toBeUndefined();
      expect(r.err).toContain("STILL VALID");
      expect(r.err).toContain("登录设备");
      expect(r.all).not.toContain(SESSION_TOKEN);
    } finally { hub.stop(); }
  }, 30_000);

  test("Hub 连不上:本地照删,警告「服务端仍有效」,exit 0", async () => {
    const home = tempHome({ hub: await deadHubUrl(), token: SESSION_TOKEN });
    const r = await runCli(home, ["logout"]);
    expect(r.code).toBe(0);
    expect(readConfig(home).token).toBeUndefined();
    expect(r.err).toContain("Could not reach");
    expect(r.err).toContain("STILL VALID");
    expect(r.all).not.toContain(SESSION_TOKEN);
  }, 30_000);

  test("🔴 变异:去掉撤销调用 → Hub 收不到 DELETE(证明上面那条断言会红)", async () => {
    const src = readFileSync(CLI, "utf8");
    const anchor = "if (token && hub) report = describeRevokeOutcome(await revokeCurrentLoginSession(hub, token), hub);";
    expect(src.split(anchor).length).toBe(2);
    const mutantPath = join(new URL("../bin/", import.meta.url).pathname, `.cli-mutant-513-${process.pid}.ts`);
    writeFileSync(mutantPath, src.replace(anchor, "if (false) report = null;"));
    const hub = fakeHub("modern");
    try {
      const home = tempHome({ hub: hub.url, token: SESSION_TOKEN });
      const r = await runCli(home, ["logout"], mutantPath);
      expect(r.code).toBe(0);
      expect(readConfig(home).token).toBeUndefined(); // 本地照删 —— 只看本地的测试分不出变异
      expect(hub.log.filter(l => l.method === "DELETE")).toEqual([]); // 而服务端断言能
      expect(hub.revoked.size).toBe(0);
    } finally {
      hub.stop();
      if (existsSync(mutantPath)) unlinkSync(mutantPath);
    }
  }, 30_000);
});

describe("换 Hub 不带旧 token(真 CLI · 临时 HOME · 两个假 Hub)", () => {
  test("anet init --hub <新 Hub>:旧 token 在旧 Hub 上撤销、从配置删掉、从未发给新 Hub", async () => {
    const oldHub = fakeHub("modern");
    const newHub = fakeHub("modern");
    try {
      const home = tempHome({ hub: oldHub.url, token: SESSION_TOKEN, user: { username: "u" }, network_id: "net_old", network_name: "old" });
      const r = await runCli(home, ["init", "--hub", newHub.url]);
      expect(r.code).toBe(0);
      expect(newHub.log.length).toBeGreaterThan(0); // 新 Hub 确实被访问过(/health)—— 否则「没发过」是空真
      expect(newHub.log.some(l => l.auth.includes(SESSION_TOKEN))).toBe(false);
      expect(oldHub.log.some(l => l.method === "DELETE" && l.auth === `Bearer ${SESSION_TOKEN}`)).toBe(true);
      expect(readConfig(home)).toEqual({ hub: newHub.url });
      expect(r.all).not.toContain(SESSION_TOKEN);
    } finally { oldHub.stop(); newHub.stop(); }
  }, 30_000);

  test("anet init --hub <同一个 Hub,带尾斜杠>:不算换 Hub,token 保留、不撤销", async () => {
    const hub = fakeHub("modern");
    try {
      const home = tempHome({ hub: hub.url, token: SESSION_TOKEN });
      const r = await runCli(home, ["init", "--hub", hub.url + "/"]);
      expect(r.code).toBe(0);
      expect(readConfig(home).token).toBe(SESSION_TOKEN);
      expect(hub.log.some(l => l.method === "DELETE")).toBe(false);
    } finally { hub.stop(); }
  }, 30_000);

  test("anet init --hub <新 Hub> 而旧 Hub 已经连不上:旧 token 仍从配置删掉,不发给新 Hub", async () => {
    const newHub = fakeHub("modern");
    try {
      const home = tempHome({ hub: await deadHubUrl(), token: SESSION_TOKEN });
      const r = await runCli(home, ["init", "--hub", newHub.url]);
      expect(r.code).toBe(0);
      expect(newHub.log.some(l => l.auth.includes(SESSION_TOKEN))).toBe(false);
      expect(readConfig(home).token).toBeUndefined();
      expect(r.err).toContain("STILL VALID");
    } finally { newHub.stop(); }
  }, 30_000);

  test("anet login --hub <新 Hub> --token <新>:只把新 token 发给新 Hub", async () => {
    const oldHub = fakeHub("modern");
    const newHub = fakeHub("modern");
    try {
      const home = tempHome({ hub: oldHub.url, token: SESSION_TOKEN });
      const r = await runCli(home, ["login", "--hub", newHub.url, "--token", OTHER_TOKEN]);
      expect(r.code).toBe(0);
      expect(newHub.log.length).toBeGreaterThan(0);
      expect(newHub.log.some(l => l.auth.includes(SESSION_TOKEN))).toBe(false);
      expect(newHub.log.some(l => l.auth === `Bearer ${OTHER_TOKEN}`)).toBe(true);
      expect(oldHub.revoked.has(SESSION_TOKEN)).toBe(true);
      const cfg = readConfig(home);
      expect(cfg.hub).toBe(newHub.url);
      expect(cfg.token).toBe(OTHER_TOKEN);
    } finally { oldHub.stop(); newHub.stop(); }
  }, 30_000);
});
