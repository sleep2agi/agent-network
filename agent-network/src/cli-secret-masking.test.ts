// #516(#502 anet CLI 审计,第 1 片)—— 打印配置 / 登录态 / 节点信息的命令,
// 以及它们的报错,**一个字节的完整密钥都不许出现**。
//
// 每一行都 spawn 真 CLI(bin/cli.ts),临时 HOME + 进程内假 Hub(随机端口)。
// 🔴 不碰真实 HOME、真实 Hub、tmux、pm2;没有一条会起 hub 或节点进程。
//
// 判据:全部 stdout+stderr 里不含任何一个夹具密钥的**完整字符串**,
// 也不含去掉前缀后的主体(防止换个前缀照样泄漏)。
// 见证红:tests/test516-anet-secret-masking/run.sh 把掩码改成恒等,这里必须变红。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCliError, errorText, formatTopLevelError, hubErrorText, maskSecret, redactSecretFields, redactSecrets } from "./cli-errors";

// 夹具密钥:形状像真的,内容一看就是假的。主体足够长,任何截断都看得出来。
const UTOK = "utok_FAKEuser0123456789abcdefghijklmnopQRST";
const NTOK = "ntok_FAKEnode0123456789abcdefghijklmnopWXYZ";
const VENDOR_KEY = "sk-ant-FAKEvendor0123456789abcdefghijklmnUVWX";
const NODE_ENV_KEY = "sk-FAKEnodeenv0123456789abcdefghijklmnYZAB";
const SECRETS = [UTOK, NTOK, VENDOR_KEY, NODE_ENV_KEY];
const bodyOf = (s: string) => s.replace(/^(utok_|ntok_|sk-ant-|sk-)/, "");

let hub: ReturnType<typeof Bun.serve>;
let HUB = "";
let DEAD = "";

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      if (url.pathname === "/health") return Response.json({ ok: true, version: "0.0.0-fake" });
      // a hub 500 in the shape server/src/serve-error.ts produces — and it echoes the caller's token
      if (url.pathname === "/api/auth/tokens" && req.method === "POST") {
        return Response.json({ jsonrpc: "2.0", id: null, ok: false, error: { code: -32603, message: `boom for Bearer ${tok}` }, message: `boom for Bearer ${tok}` }, { status: 500 });
      }
      if (tok !== UTOK && tok !== NTOK) return Response.json({ ok: false, error: "token_expired" }, { status: 401 });
      if (url.pathname === "/api/auth/me") {
        return Response.json({ ok: true, user: { username: "u", user_id: "usr_1", role: "user" }, networks: [{ network_id: "net_aaaaaaaaaaaa", network_name: "alpha" }] });
      }
      if (url.pathname === "/api/auth/node-token" && req.method === "POST") return Response.json({ ok: true, token: NTOK });
      if (url.pathname === "/api/networks") return Response.json({ ok: true, networks: [{ network_id: "net_aaaaaaaaaaaa", network_name: "alpha", member_role: "owner" }] });
      if (url.pathname === "/api/status") return Response.json({ ok: true, sessions: [] });
      if (url.pathname === "/api/tasks") return Response.json({ ok: true, tasks: [] });
      if (url.pathname === "/api/auth/tokens") return Response.json({ ok: true, tokens: [] });
      return new Response("Not Found", { status: 404 });
    },
  });
  HUB = `http://127.0.0.1:${hub.port}`;
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  DEAD = `http://127.0.0.1:${dead.port}`;
  dead.stop(true);
});

const temps: string[] = [];
afterAll(() => {
  hub?.stop(true);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** 临时 HOME:登录文件带 UTOK;cwd 下有一个节点,config 里有 NTOK + 一个明文 vendor key。 */
function fixtureHome(hubUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), "anet-516-"));
  temps.push(home);
  mkdirSync(join(home, ".anet"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".anet", "config.json"), JSON.stringify({
    hub: hubUrl, token: UTOK, network_id: "net_aaaaaaaaaaaa", network_name: "alpha",
    user: { user_id: "usr_1", username: "u", role: "user" },
  }), { mode: 0o600 });
  const nodeDir = join(home, ".anet", "nodes", "n1");
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({
    node_id: "n_11111111", node_name: "n1", runtime: "claude-agent-sdk", hub: hubUrl,
    network_id: "net_aaaaaaaaaaaa", token: NTOK, env: { MY_SERVICE_TOKEN: NODE_ENV_KEY },
  }), { mode: 0o600 });
  return home;
}

const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;

async function runCli(home: string, argv: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANET_|COMMHUB_|MINIMAX_|ANTHROPIC_|OPENAI_|DEBUG$)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1", ANET_NO_UPDATE_CHECK: "1" }, extraEnv);
  const p = Bun.spawn(["bun", CLI, ...argv], { env, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, all: out + err };
}

function leaked(all: string): string[] {
  const hits: string[] = [];
  for (const s of SECRETS) {
    if (all.includes(s)) hits.push(s);
    else if (all.includes(bodyOf(s))) hits.push(`body of ${s.slice(0, 7)}`);
  }
  return hits;
}

// [argv, hub, what must still be shown (proves the command really ran its print path)]
type Row = [string[], "live" | "dead", RegExp, Record<string, string>?];
const ROWS: Row[] = [
  [["config"], "live", /token:\s+utok_…QRST/],
  [["config", "json"], "live", /"token": "utok_…QRST"/],
  [["config", "path"], "live", /config\.json/],
  [["whoami"], "live", /User: u/],
  [["whoami"], "dead", /Cannot connect/],
  [["whoami"], "live", /User: u/, { ANET_DEBUG: "1" }],
  [["login", "--hub", "HUB", "--token", UTOK], "live", /Logged in as u/],
  [["status"], "live", /CommHub/],
  [["network", "ls"], "live", /alpha/],
  [["token", "ls"], "live", /No tokens/],
  [["token", "create", "--name", "laptop"], "live", /boom for Bearer utok_…QRST/],
  [["info", "n1"], "live", /node_id:\s+n_11111111/],
  [["node", "ls"], "live", /n1/],
  [["node", "start", "nosuch"], "live", /not found/],
  [["node", "create", "n2", "--runtime", "claude-agent-sdk", "--env", `ANTHROPIC_API_KEY=${VENDOR_KEY}`], "live", /ANTHROPIC_API_KEY_\w+ = sk-ant-…UVWX/],
  [["node", "migrate-token-to-envref", "n1"], "live", /env\.MY_SERVICE_TOKEN = sk-…YZAB/],
];

describe("#516 no command prints a full secret (real CLI, temp HOME, fake hub)", () => {
  for (const [argv0, which, mustShow, extraEnv] of ROWS) {
    const label = `anet ${argv0.map(a => SECRETS.includes(a) ? "<fake-token>" : a.replace(VENDOR_KEY, "<fake-key>")).join(" ")} [${which}${extraEnv ? " " + Object.keys(extraEnv).join(",") : ""}]`;
    test(label, async () => {
      const hubUrl = which === "live" ? HUB : DEAD;
      const home = fixtureHome(hubUrl);
      const argv = argv0.map(a => (a === "HUB" ? HUB : a));
      const r = await runCli(home, argv, extraEnv);
      expect({ leaked: leaked(r.all), showsExpected: mustShow.test(r.all) }).toEqual({ leaked: [], showsExpected: true });
    }, 60_000);
  }

  test("migrate still stores the real value where `node start` reads it", async () => {
    const home = fixtureHome(HUB);
    const r = await runCli(home, ["node", "migrate-token-to-envref", "n1"]);
    expect(r.code).toBe(0);
    const dotenv = readFileSync(join(home, ".anet", "nodes", "n1", ".env"), "utf-8");
    expect(dotenv).toContain(`=${NODE_ENV_KEY}`);
    expect(leaked(r.all)).toEqual([]);
  }, 60_000);
});

describe("#516 masking helpers", () => {
  test("maskSecret keeps the type prefix and the last 4 only", () => {
    expect(maskSecret(UTOK)).toBe("utok_…QRST");
    expect(maskSecret(VENDOR_KEY)).toBe("sk-ant-…UVWX");
    expect(maskSecret("utok_short")).toBe("utok_…");
    expect(maskSecret("")).toBe("(not set)");
    expect(maskSecret(undefined)).toBe("(not set)");
  });

  test("redactSecrets catches prefixed tokens, Bearer headers and token= query params", () => {
    const text = `GET http://h/x?token=abcdefghijklmnop1234&a=1 Authorization: Bearer ${UTOK} raw ${NTOK}`;
    const out = redactSecrets(text);
    expect(leaked(out)).toEqual([]);
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out).toContain("token=…1234");
  });

  test("redactSecretFields masks token-like keys at any depth", () => {
    const out = redactSecretFields({ hub: "h", token: "opaque-value-without-prefix-9999", nested: { api_key: "zzzzzzzzzzzzzzzz1111", ok: "plain" } });
    expect(out).toEqual({ hub: "h", token: "…9999", nested: { api_key: "…1111", ok: "plain" } });
  });

  test("hub 500 bodies never print as [object Object]", () => {
    const body = { ok: false, error: { code: -32603, message: "database is locked" }, message: "database is locked" };
    expect(hubErrorText(body)).toBe("database is locked");
    expect(errorText({ foo: 1 })).not.toContain("[object Object]");
    expect(hubErrorText({ ok: false, error: "name_taken" })).toBe("name_taken");
  });

  test("top-level error: plain sentence + next command, stack only with ANET_DEBUG=1", () => {
    const err = new Error(`connect failed for Bearer ${UTOK}`);
    const quiet = formatTopLevelError(err, { env: {} }).join("\n");
    expect(quiet).not.toContain("    at ");
    expect(quiet).toContain("ANET_DEBUG=1");
    expect(leaked(quiet)).toEqual([]);
    const loud = formatTopLevelError(err, { env: { ANET_DEBUG: "1" } }).join("\n");
    expect(loud).toContain("    at ");
    expect(leaked(loud)).toEqual([]);
  });

  test("error-code messages keep the `[anet] FATAL: Error: CODE` line log parsers read", () => {
    const lines = formatTopLevelError(new Error("NODE_STOP_GENERATION_CHANGED"), { env: {} });
    expect(lines[0]).toBe("[anet] FATAL: Error: NODE_STOP_GENERATION_CHANGED");
  });

  test("classification: unreachable hub, EACCES, bad JSON, 401", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(describeCliError(refused, { hub: "http://127.0.0.1:1" }).summary).toContain("Cannot connect to the CommHub hub at http://127.0.0.1:1");
    const eacces = Object.assign(new Error("EACCES: permission denied, open '/h/.anet/config.json'"), { code: "EACCES", path: "/h/.anet/config.json" });
    const r = describeCliError(eacces);
    expect(r.summary).toBe("Permission denied on /h/.anet/config.json.");
    expect(r.next.join(" ")).toContain("ls -ld /h/.anet/config.json");
    let syntax: unknown;
    try { JSON.parse("{bad"); } catch (e) { syntax = e; }
    expect(describeCliError(syntax).summary).toContain("could not parse a JSON document");
    expect(describeCliError(Object.assign(new Error("HTTP 401"), { status: 401 })).next[0]).toContain("anet login");
  });
});
