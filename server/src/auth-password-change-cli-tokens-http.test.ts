// #711 改密码只让浏览器 / app 的登录会话下线,命令行和脚本令牌默认保留。
//
// main 上 POST /api/auth/password 跑的是 `DELETE FROM api_tokens WHERE user_id = ? AND network_id IS NULL
// AND token_id != ?` —— 每台机器上 `anet login` 拿到的令牌、POST /api/auth/tokens 建的具名脚本令牌,
// 跟浏览器会话一起被删光。安全复审定的形状:默认不变,保留是显式选项。这里每条都钉住:
//   · 默认(旧 app、dashboard 代理不带字段):撤销全部不绑网络的令牌 —— 客户端自报的 cli 也活不下来;
//   · keep_cli_tokens=true(anet passwd 默认带):只撤其他 kind='login' 会话,保留的 cli 令牌列在响应里、不含令牌值;
//   · 当前会话(换发后的新令牌)永远可用,而且沿用当前令牌的种类;
//   · 节点令牌不动;具名网络令牌默认保留,可显式revoke_network_tokens;
//   · 启动迁移按 client_label / scope 回填存量令牌的 kind(夹具库,跑两遍幂等)。
// SQLite 由 test798 自动收进;PostgreSQL 由 tests/test2123-hub-postgres-ladder 的 run_pg_tests_rc 跑同一个文件。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { register, createNetworkTokenForNode, createToken, createNetwork, changePassword } from "./auth.js";
import { db, hashToken } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-pwchange-kind-"));
let BASE = "";
let hub: any = null;
const PW = "PwChangeKindPassw0rd!";
const PW2 = "PwChangeKindPassw0rd!2";
const CLI_LABEL = "anet 2.5.0 · test-box · login";

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const works = async (token: string) => (await call(token, "GET", "/api/auth/me")).status === 200;
const kindOf = (token: string) => db.get<any>("SELECT kind FROM api_tokens WHERE token_hash = ?1", hashToken(token))?.kind ?? null;

type Fleet = {
  user: string; userId: string; net: string;
  app: string; appB: string; regToken: string;
  cliByLabel: string; cliByKind: string; apiToken: string;
  nodeToken: string; netToken: string;
};

let seq = 0;
async function fleet(): Promise<Fleet> {
  const user = `pwk_${Date.now()}_${++seq}`;
  const reg = register(user, PW);
  expect(reg.ok).toBe(true);
  const login = async (extra: Record<string, unknown>) => {
    const r = await call("", "POST", "/api/auth/login", { username: user, password: PW, ...extra });
    expect(r.status).toBe(200);
    return r.body.token as string;
  };
  const node = createNetworkTokenForNode(reg.user!.user_id, reg.network_id!, "pwk-node", `node_pwk_${seq}`);
  expect(node.ok).toBe(true);
  const api = createToken(reg.user!.user_id, "ci-script");
  expect(api.ok).toBe(true);
  const netTok = createToken(reg.user!.user_id, "net-script", reg.network_id!);
  expect(netTok.ok).toBe(true);
  return {
    user, userId: reg.user!.user_id, net: reg.network_id!,
    regToken: reg.token!,
    app: await login({ client_label: "Desktop app" }),
    appB: await login({}),
    cliByLabel: await login({ client_label: CLI_LABEL }),
    cliByKind: await login({ client_kind: "cli" }),
    apiToken: api.token!,
    nodeToken: node.token!,
    netToken: netTok.token!,
  };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  process.env.COMMHUB_LOGIN_IP_MAX = "1000";
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("new tokens are classified at issue time", () => {
  test("browser/app logins are 'login'; anet-labelled, client_kind=cli and named API tokens are 'cli'; node tokens unclassified", async () => {
    const f = await fleet();
    expect(kindOf(f.regToken)).toBe("login");
    expect(kindOf(f.app)).toBe("login");
    expect(kindOf(f.appB)).toBe("login");
    expect(kindOf(f.cliByLabel)).toBe("cli");
    expect(kindOf(f.cliByKind)).toBe("cli");
    expect(kindOf(f.apiToken)).toBe("cli");
    expect(kindOf(f.nodeToken)).toBe(null);
    expect(kindOf(f.netToken)).toBe(null);
  });
});

// 响应里出现任何令牌值都算泄漏:换发给调用方的那一条(body.token)除外,它本来就要交给调用方。
function assertNoTokenValues(body: any, f: Fleet) {
  const { token: _rotated, ...rest } = body;
  const text = JSON.stringify(rest);
  for (const t of [f.regToken, f.app, f.appB, f.cliByLabel, f.cliByKind, f.apiToken, f.nodeToken, f.netToken]) {
    expect(text.includes(t)).toBe(false);
  }
  expect(/\b(utok|atok|ntok)_[A-Za-z0-9]{8,}/.test(text)).toBe(false);
  expect(text.includes("token_hash")).toBe(false);
}

describe("POST /api/auth/password (default: old apps, dashboard proxy — no field)", () => {
  test("every other non-network token is revoked (pre-#711 behaviour); node tokens and the rotated current session survive", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.revoked_login).toBe(2); // reg + appB
    expect(r.body.revoked_cli).toBe(3);   // cliByLabel + cliByKind + apiToken
    expect(r.body.revoked).toBe(5);
    expect(r.body.kept_cli_tokens).toBeUndefined();
    for (const t of [f.regToken, f.appB, f.cliByLabel, f.cliByKind, f.apiToken]) expect(await works(t)).toBe(false);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(f.netToken)).toBe(true);
    expect(await works(r.body.token)).toBe(true);
    expect(kindOf(r.body.token)).toBe("login");
    expect(await works(f.app)).toBe(false);
  });

  test("a client-declared cli token (client_kind / anet label) does NOT survive a default password change", async () => {
    const f = await fleet();
    expect(kindOf(f.cliByKind)).toBe("cli");
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    expect(await works(f.cliByKind)).toBe(false);
    expect(await works(f.cliByLabel)).toBe(false);
  });

  test("a non-boolean keep_cli_tokens is not an opt-in; the removed revoke_cli_tokens field does nothing", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, keep_cli_tokens: "true", revoke_cli_tokens: false });
    expect(r.status).toBe(200);
    expect(r.body.revoked_cli).toBe(3);
    expect(await works(f.cliByLabel)).toBe(false);
    expect(await works(f.apiToken)).toBe(false);
  });
});

describe("POST /api/auth/password with keep_cli_tokens=true (anet passwd)", () => {
  test("only other login sessions are revoked; CLI/script tokens are kept and listed without token values", async () => {
    const f = await fleet();
    const r = await call(f.cliByLabel, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, keep_cli_tokens: true });
    expect(r.status).toBe(200);
    expect(r.body.revoked_login).toBe(3); // reg + app + appB
    expect(r.body.revoked_cli).toBe(0);
    expect(r.body.revoked).toBe(3);
    for (const t of [f.regToken, f.app, f.appB]) expect(await works(t)).toBe(false);
    expect(await works(f.cliByKind)).toBe(true);
    expect(await works(f.apiToken)).toBe(true);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(f.netToken)).toBe(true);
    // 当前会话:换发的新令牌可用,沿用 cli
    expect(await works(r.body.token)).toBe(true);
    expect(kindOf(r.body.token)).toBe("cli");
    // 保留清单:不含当前这条(它已被换掉),只含另外两条 cli;字段齐全、无令牌值
    const kept = r.body.kept_cli_tokens as any[];
    const idOf = (t: string) => db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(t)).token_id;
    expect(kept.map((k) => k.token_id).sort()).toEqual([idOf(f.cliByKind), idOf(f.apiToken)].sort());
    for (const k of kept) {
      expect(Object.keys(k).sort()).toEqual(["client_label", "created_at", "last_used_at", "name", "token_id"]);
      expect(k.token_id).toMatch(/^tok_[0-9a-f]{12}$/);
    }
    expect(kept.find((k) => k.token_id === idOf(f.apiToken)).name).toBe("ci-script");
    assertNoTokenValues(r.body, f);
    // 可以逐条撤销
    expect((await call(r.body.token, "DELETE", `/api/auth/tokens/${idOf(f.apiToken)}`)).status).toBe(200);
    expect(await works(f.apiToken)).toBe(false);
  });

  test("default response carries no token values either", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    assertNoTokenValues(r.body, f);
  });
});

describe("changePassword() keeps the current token row in both modes", () => {
  test("no opts at all = default: CLI tokens revoked, current kept", async () => {
    const f = await fleet();
    const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.app)).token_id;
    const r = changePassword(f.userId, PW, PW2, cur);
    expect(r.ok).toBe(true);
    expect(r.revoked_cli).toBe(3);
    expect(r.kept_cli_tokens).toBeUndefined();
    expect(await works(f.app)).toBe(true);
    expect(await works(f.cliByKind)).toBe(false);
    expect(await works(f.apiToken)).toBe(false);
  });

  for (const keepCliTokens of [false, true]) {
    test(`keepCliTokens=${keepCliTokens}: current login token kept`, async () => {
      const f = await fleet();
      const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.app)).token_id;
      const r = changePassword(f.userId, PW, PW2, cur, { keepCliTokens });
      expect(r.ok).toBe(true);
      expect(await works(f.app)).toBe(true);
      expect(await works(f.appB)).toBe(false);
      expect(await works(f.cliByLabel)).toBe(keepCliTokens);
      expect(await works(f.nodeToken)).toBe(true);
    });
    test(`keepCliTokens=${keepCliTokens}: current CLI token kept`, async () => {
      const f = await fleet();
      const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.cliByKind)).token_id;
      const r = changePassword(f.userId, PW, PW2, cur, { keepCliTokens });
      expect(r.ok).toBe(true);
      expect(await works(f.cliByKind)).toBe(true);
      expect(await works(f.app)).toBe(false);
      expect(await works(f.apiToken)).toBe(keepCliTokens);
    });
  }
});

describe("startup migration backfills api_tokens.kind on a fixture DB", () => {
  // 把 kind 列拿掉 = 回到 #711 之前的表结构;塞存量行;再起一个进程加载 db.ts(= Hub 启动迁移)。
  function bootMigration() {
    const r = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(join(import.meta.dir, "db.ts"))}); process.exit(0);`], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.status !== 0) console.log(String(r.stderr || "").slice(-2000));
    return r.status;
  }

  test("anet-labelled and named API tokens → cli, everything else → login, node tokens untouched; idempotent", async () => {
    const f = await fleet();
    db.exec("ALTER TABLE api_tokens DROP COLUMN kind");
    const ins = (id: string, net: string | null, scope: string, label: string | null) =>
      db.run(
        "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, client_label, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, 'fixture', ?5, ?6, 1)",
        [id, hashToken(`fixture-${id}`), f.userId, net, scope, label],
      );
    const id = (s: string) => `tok_fx_${seq}_${s}`;
    ins(id("cli_label"), null, "user", "anet 2.4.0 · old-box · login");
    ins(id("cli_demo"), null, "user", "anet dev · unknown-host · demo sci-team");
    ins(id("browser"), null, "user", "Chrome on macOS");
    ins(id("nolabel"), null, "user", null);
    ins(id("lookalike"), null, "user", "planet-anet dashboard");
    ins(id("upper"), null, "user", "ANET 2.4.0 · box · login");
    ins(id("padded"), null, "user", "  anet 2.4.0 · box · login");
    ins(id("named"), null, "full", null);
    ins(id("node"), f.net, "network", null);
    ins(id("netfull"), f.net, "full", null);

    expect(bootMigration()).toBe(0);
    const k = (s: string) => db.get<any>("SELECT kind FROM api_tokens WHERE token_id = ?1", id(s))?.kind ?? null;
    expect(k("cli_label")).toBe("cli");
    expect(k("cli_demo")).toBe("cli");
    expect(k("browser")).toBe("login");
    expect(k("nolabel")).toBe("login");
    expect(k("lookalike")).toBe("login");
    expect(k("upper")).toBe("login");   // 区分大小写:SQLite 的 LIKE 会把它当 cli,PG 不会 —— 两边必须一致
    expect(k("padded")).toBe("cli");    // 与运行时一样先 trim
    expect(k("named")).toBe("cli");
    expect(k("node")).toBe(null);
    expect(k("netfull")).toBe(null);
    // fleet() 的 live 令牌也被回填(列重建后原值丢了,按同一规则算回来)
    expect(kindOf(f.cliByLabel)).toBe("cli");
    expect(kindOf(f.apiToken)).toBe("cli");
    expect(kindOf(f.app)).toBe("login");

    // 幂等:已有值不被改写(手动改成 login 的 anet 行保持 login),再跑一次结果不变
    db.run("UPDATE api_tokens SET kind = 'login' WHERE token_id = ?1", [id("cli_label")]);
    expect(bootMigration()).toBe(0);
    expect(k("cli_label")).toBe("login");
    expect(k("named")).toBe("cli");
    expect(k("browser")).toBe("login");

    // 迁移后的库上,keep_cli_tokens 保留回填成 cli 的存量令牌
    const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.app)).token_id;
    const r = changePassword(f.userId, PW, PW2, cur, { keepCliTokens: true });
    expect(r.ok).toBe(true);
    expect(k("named")).toBe("cli");
    expect(k("cli_demo")).toBe("cli");
    expect(k("browser")).toBe(null); // 被撤销(行已删除)
    expect(k("node")).toBe(null);
    expect(Number(db.get<any>("SELECT COUNT(*) AS n FROM api_tokens WHERE token_id = ?1", id("node")).n)).toBe(1);
  }, 120_000);
});


describe("network password opt-in", () => {
  const id = (token: string) => db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash=?1", hashToken(token)).token_id;

  test("default lists only the caller's active named network tokens across networks, without credentials", async () => {
    const f = await fleet();
    const second = createNetwork(f.userId, `pwk-second-${seq}`);
    expect(second.ok).toBe(true);
    const extra = createToken(f.userId, "second-network-script", second.network_id);
    const other = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    expect(r.body.revoked_network).toBe(0);
    expect(r.body.revoked).toBe(5);
    expect(r.body.kept_network_tokens.map((x: any) => x.token_id).sort()).toEqual([id(f.netToken), id(extra.token!)].sort());
    for (const row of r.body.kept_network_tokens) {
      expect(Object.keys(row).sort()).toEqual(["created_at", "last_used_at", "name", "network_id", "token_id"]);
    }
    const body = JSON.stringify(r.body);
    expect(body.includes("token_hash")).toBe(false);
    for (const t of [f.netToken, extra.token!, f.nodeToken, other.netToken]) expect(body.includes(t)).toBe(false);
    expect(await works(f.netToken)).toBe(true);
    expect(await works(extra.token!)).toBe(true);
    expect(await works(other.netToken)).toBe(true);
    expect(await works(r.body.token)).toBe(true);
  });

  test("explicit boolean opt-in revokes only own named network tokens, independently of keep_cli_tokens", async () => {
    const f = await fleet();
    const other = await fleet();
    const second = createNetwork(f.userId, `pwk-revoke-second-${seq}`);
    const extra = createToken(f.userId, "second-network-script", second.network_id);
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, keep_cli_tokens: true, revoke_network_tokens: true });
    expect(r.status).toBe(200);
    expect(r.body.revoked_network).toBe(2);
    expect(r.body.revoked_login).toBe(2);
    expect(r.body.revoked_cli).toBe(0);
    expect(r.body.revoked).toBe(4);
    expect(r.body.kept_network_tokens).toEqual([]);
    expect(await works(f.netToken)).toBe(false);
    expect(await works(extra.token!)).toBe(false);
    expect(await works(other.netToken)).toBe(true);
    expect(await works(other.app)).toBe(true);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(f.apiToken)).toBe(true);
    expect(await works(r.body.token)).toBe(true);
    expect(await works(f.app)).toBe(false);
  });

  for (const value of [false, "true", 1, null, {}]) {
    test(`non-true option ${JSON.stringify(value)} cannot revoke network tokens`, async () => {
      const f = await fleet();
      const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_network_tokens: value });
      expect(r.status).toBe(200);
      expect(r.body.revoked_network).toBe(0);
      expect(r.body.kept_network_tokens).toHaveLength(1);
      expect(await works(f.netToken)).toBe(true);
    });
  }

  test("scope and binding protect node credentials; inactive rows are neither listed nor counted", async () => {
    const f = await fleet();
    const legacy = createNetworkTokenForNode(f.userId, f.net, `legacy-pwk-${seq}`);
    expect(legacy.ok).toBe(true);
    const bound = createToken(f.userId, "mislabelled-bound-node", f.net);
    db.run("UPDATE api_tokens SET bound_node_id=?1 WHERE token_id=?2", ["n-protected717", bound.token_id]);
    const expired = createToken(f.userId, "expired-script", f.net);
    db.run("UPDATE api_tokens SET expires_at=datetime('now','-1 day') WHERE token_id=?1", [expired.token_id]);
    const revoked = createToken(f.userId, "revoked-script", f.net);
    db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [revoked.token_id]);
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_network_tokens: true });
    expect(r.status).toBe(200);
    expect(r.body.revoked_network).toBe(1);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(bound.token!)).toBe(true);
    for (const t of [bound, expired, revoked, legacy]) expect(db.get("SELECT token_id FROM api_tokens WHERE token_id=?1", t.token_id)).not.toBeNull();
  });

  test("bad old password or weak new password has no token side effects", async () => {
    for (const body of [{ old_password: "wrong", new_password: PW2 }, { old_password: PW, new_password: "123" }]) {
      const f = await fleet();
      const r = await call(f.app, "POST", "/api/auth/password", { ...body, revoke_network_tokens: true });
      expect(r.status).toBe(400);
      for (const t of [f.app, f.netToken, f.apiToken, f.nodeToken]) expect(await works(t)).toBe(true);
      expect((await call("", "POST", "/api/auth/login", { username: f.user, password: PW })).status).toBe(200);
    }
  });

  test("network-scoped and unauthenticated credentials cannot invoke password change", async () => {
    const f = await fleet();
    for (const t of [f.netToken, f.nodeToken, ""]) {
      expect((await call(t, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_network_tokens: true })).status).toBe(t ? 403 : 401);
    }
    expect(await works(f.netToken)).toBe(true);
    expect(await works(f.app)).toBe(true);
  });

  test("a failed network revoke rolls back the password and earlier session deletions", async () => {
    const f = await fleet();
    const victim = id(f.netToken);
    const fn = `pw717_failure_${seq}`;
    const trigger = `pw717_trigger_${seq}`;
    if (db.dialect === "postgres") db.exec(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.token_id='${victim}' THEN RAISE EXCEPTION 'fixture717_delete_failure'; END IF; RETURN OLD; END; $$; CREATE TRIGGER ${trigger} BEFORE DELETE ON api_tokens FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    else db.exec(`CREATE TRIGGER ${trigger} BEFORE DELETE ON api_tokens WHEN OLD.token_id='${victim}' BEGIN SELECT RAISE(ABORT,'fixture717_delete_failure'); END`);
    try {
      expect((await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_network_tokens: true })).status).toBe(400);
      for (const t of [f.app, f.appB, f.apiToken, f.netToken, f.nodeToken]) expect(await works(t)).toBe(true);
      expect((await call("", "POST", "/api/auth/login", { username: f.user, password: PW })).status).toBe(200);
      expect((await call("", "POST", "/api/auth/login", { username: f.user, password: PW2 })).status).toBe(401);
    } finally {
      db.exec(db.dialect === "postgres" ? `DROP TRIGGER ${trigger} ON api_tokens; DROP FUNCTION ${fn}()` : `DROP TRIGGER ${trigger}`);
    }
  });

  test("direct changePassword keeps its current row and defaults to listing network tokens", async () => {
    const f = await fleet();
    const cur = id(f.app);
    const r = changePassword(f.userId, PW, PW2, cur);
    expect(r.ok).toBe(true);
    expect(r.kept_network_tokens).toHaveLength(1);
    expect(await works(f.app)).toBe(true);
    const r2 = changePassword(f.userId, PW2, PW, cur, { revokeNetworkTokens: true, keepCliTokens: true });
    expect(r2.ok).toBe(true);
    expect(r2.revoked_network).toBe(1);
    expect(await works(f.app)).toBe(true);
    expect(await works(f.nodeToken)).toBe(true);
  });
});
