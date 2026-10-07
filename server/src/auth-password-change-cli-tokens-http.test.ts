// #711 改密码只让浏览器 / app 的登录会话下线,命令行和脚本令牌默认保留。
//
// main 上 POST /api/auth/password 跑的是 `DELETE FROM api_tokens WHERE user_id = ? AND network_id IS NULL
// AND token_id != ?` —— 每台机器上 `anet login` 拿到的令牌、POST /api/auth/tokens 建的具名脚本令牌,
// 跟浏览器会话一起被删光。这里每条都钉住新行为:
//   · 默认(旧 app 不带字段):只撤其他 kind='login' 会话;kind='cli' 照常可用;
//   · revoke_cli_tokens=true:连 kind='cli' 一起撤;
//   · 当前会话(换发后的新令牌)永远可用,而且沿用当前令牌的种类;
//   · 节点 / 网络令牌永远不动;
//   · 启动迁移按 client_label / scope 回填存量令牌的 kind(夹具库,跑两遍幂等)。
// SQLite 由 test798 自动收进;PostgreSQL 由 tests/test2123-hub-postgres-ladder 的 run_pg_tests_rc 跑同一个文件。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { register, createNetworkTokenForNode, createToken, changePassword } from "./auth.js";
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

describe("POST /api/auth/password (default: old app, no flag)", () => {
  test("other login sessions are signed out, CLI/script tokens and node tokens keep working", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // 其他 login 会话 = 注册时签发的那条 + appB
    expect(r.body.revoked_login).toBe(2);
    expect(r.body.revoked_cli).toBe(0);
    expect(r.body.revoked).toBe(2);
    expect(await works(f.regToken)).toBe(false);
    expect(await works(f.appB)).toBe(false);
    expect(await works(f.cliByLabel)).toBe(true);
    expect(await works(f.cliByKind)).toBe(true);
    expect(await works(f.apiToken)).toBe(true);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(f.netToken)).toBe(true);
    // 当前会话:换发的新令牌可用,旧的被换掉(既有行为),种类沿用 'login'
    expect(await works(r.body.token)).toBe(true);
    expect(kindOf(r.body.token)).toBe("login");
    expect(await works(f.app)).toBe(false);
  });

  test("a non-boolean flag value is not an opt-in", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_cli_tokens: "true" });
    expect(r.status).toBe(200);
    expect(r.body.revoked_cli).toBe(0);
    expect(await works(f.cliByLabel)).toBe(true);
    expect(await works(f.apiToken)).toBe(true);
  });

  test("changing the password from a CLI token keeps the rotated token a CLI token", async () => {
    const f = await fleet();
    const r = await call(f.cliByLabel, "POST", "/api/auth/password", { old_password: PW, new_password: PW2 });
    expect(r.status).toBe(200);
    expect(r.body.revoked_login).toBe(3); // reg + app + appB
    expect(r.body.revoked_cli).toBe(0);
    expect(await works(r.body.token)).toBe(true);
    expect(kindOf(r.body.token)).toBe("cli");
    expect(await works(f.cliByKind)).toBe(true);
    expect(await works(f.apiToken)).toBe(true);
    // 再改一次密码(默认):换发出来的命令行令牌仍然保留
    const r2 = await call(r.body.token, "POST", "/api/auth/password", { old_password: PW2, new_password: PW });
    expect(r2.status).toBe(200);
    expect(await works(r2.body.token)).toBe(true);
    expect(await works(f.cliByKind)).toBe(true);
  });
});

describe("POST /api/auth/password with revoke_cli_tokens=true", () => {
  test("CLI/script tokens are revoked too; current session and node tokens survive", async () => {
    const f = await fleet();
    const r = await call(f.app, "POST", "/api/auth/password", { old_password: PW, new_password: PW2, revoke_cli_tokens: true });
    expect(r.status).toBe(200);
    expect(r.body.revoked_login).toBe(2);
    expect(r.body.revoked_cli).toBe(3);
    expect(r.body.revoked).toBe(5);
    for (const t of [f.regToken, f.appB, f.cliByLabel, f.cliByKind, f.apiToken]) expect(await works(t)).toBe(false);
    expect(await works(f.nodeToken)).toBe(true);
    expect(await works(f.netToken)).toBe(true);
    expect(await works(r.body.token)).toBe(true);
  });
});

describe("changePassword() keeps the current token row in both modes", () => {
  for (const revokeCliTokens of [false, true]) {
    test(`revokeCliTokens=${revokeCliTokens}: current login token kept`, async () => {
      const f = await fleet();
      const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.app)).token_id;
      const r = changePassword(f.userId, PW, PW2, cur, { revokeCliTokens });
      expect(r.ok).toBe(true);
      expect(await works(f.app)).toBe(true);
      expect(await works(f.appB)).toBe(false);
      expect(await works(f.cliByLabel)).toBe(!revokeCliTokens);
      expect(await works(f.nodeToken)).toBe(true);
    });
    test(`revokeCliTokens=${revokeCliTokens}: current CLI token kept`, async () => {
      const f = await fleet();
      const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.cliByKind)).token_id;
      const r = changePassword(f.userId, PW, PW2, cur, { revokeCliTokens });
      expect(r.ok).toBe(true);
      expect(await works(f.cliByKind)).toBe(true);
      expect(await works(f.app)).toBe(false);
      expect(await works(f.apiToken)).toBe(!revokeCliTokens);
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

    // 迁移后的库上,默认改密码照样保留回填成 cli 的存量令牌
    const cur = db.get<any>("SELECT token_id FROM api_tokens WHERE token_hash = ?1", hashToken(f.app)).token_id;
    const r = changePassword(f.userId, PW, PW2, cur);
    expect(r.ok).toBe(true);
    expect(k("named")).toBe("cli");
    expect(k("cli_demo")).toBe("cli");
    expect(k("browser")).toBe(null); // 被撤销(行已删除)
    expect(k("node")).toBe(null);
    expect(Number(db.get<any>("SELECT COUNT(*) AS n FROM api_tokens WHERE token_id = ?1", id("node")).n)).toBe(1);
  }, 120_000);
});
