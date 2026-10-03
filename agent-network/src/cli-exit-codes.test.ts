// #515(#502 anet CLI 审计)—— 命令 × 错误条件 → 退出码。
//
// 约定(src/cli-exit.ts):0 成功 / 1 失败 / 2 用法错误。
// 每一行都 spawn 真 CLI(bin/cli.ts),临时 HOME + 进程内假 Hub(随机端口)。
// 🔴 不碰真实 HOME、不碰任何真实 Hub;这里没有一条会起或停 hub 进程
//    (`anet hub <未知子命令>` 只打帮助;裸 `anet hub` 会起 hub,所以表里没有它)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANET_EXIT, finalExitCode } from "./cli-exit";

const GOOD = "utok_" + "g".repeat(40);
const EXPIRED = "utok_" + "e".repeat(40);

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
      if (tok !== GOOD) return Response.json({ ok: false, error: "token_expired" }, { status: 401 });
      if (url.pathname === "/api/auth/me") return Response.json({ ok: true, user: { username: "u", user_id: "usr_1", role: "user" }, networks: [] });
      if (url.pathname === "/api/networks" && req.method === "GET") {
        return Response.json({ ok: true, networks: [{ network_id: "net_aaaaaaaaaaaa", network_name: "alpha", member_role: "owner" }] });
      }
      if (url.pathname === "/api/networks" && req.method === "POST") return Response.json({ ok: false, error: "name_taken" }, { status: 409 });
      if (url.pathname === "/api/auth/tokens" && req.method === "GET") return Response.json({ ok: true, tokens: [] });
      if (url.pathname.startsWith("/api/auth/tokens/") && req.method === "DELETE") return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      if (url.pathname === "/api/auth/password") return Response.json({ ok: false, error: "invalid_old_password" }, { status: 400 });
      if (url.pathname === "/api/license/activate") return Response.json({ ok: false, error: "invalid_key" }, { status: 400 });
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

function tempHome(config: Record<string, unknown> | null): string {
  const home = mkdtempSync(join(tmpdir(), "anet-515-"));
  temps.push(home);
  mkdirSync(join(home, ".anet"), { recursive: true, mode: 0o700 });
  if (config) writeFileSync(join(home, ".anet", "config.json"), JSON.stringify(config), { mode: 0o600 });
  return home;
}

const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;

async function runCli(home: string, argv: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANET_|COMMHUB_|MINIMAX_|ANTHROPIC_)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home; env.USERPROFILE = home; env.NO_COLOR = "1";
  const p = Bun.spawn(["bun", CLI, ...argv], { env, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

type Cfg = "none" | "hub-only" | "logged-in" | "expired" | "dead-hub";
const cfg = (c: Cfg): Record<string, unknown> | null =>
  c === "none" ? null
  : c === "hub-only" ? { hub: HUB }
  : c === "logged-in" ? { hub: HUB, token: GOOD, network_id: "net_aaaaaaaaaaaa", network_name: "alpha" }
  : c === "expired" ? { hub: HUB, token: EXPIRED, network_id: "net_aaaaaaaaaaaa" }
  : { hub: DEAD, token: GOOD, network_id: "net_aaaaaaaaaaaa" };

// [argv, config, expected exit, what the output must mention, exit before #515]
const TABLE: [string[], Cfg, number, RegExp, number][] = [
  // whoami
  [["whoami"], "none", 1, /Not logged in/, 0],
  [["whoami"], "expired", 1, /Session expired/, 0],
  [["whoami"], "dead-hub", 1, /./, 0],
  [["whoami"], "logged-in", 0, /User: u/, 0],
  // network
  [["network", "ls"], "none", 1, /anet init/, 0],
  [["network", "ls"], "hub-only", 1, /anet login/, 0],
  [["network", "ls"], "expired", 1, /token_expired/, 0],
  [["network", "ls"], "dead-hub", 1, /./, 0],
  [["network", "ls"], "logged-in", 0, /alpha/, 0],
  [["network", "create"], "logged-in", 2, /Usage: anet network create/, 0],
  [["network", "create", "alpha"], "logged-in", 1, /name_taken/, 0],
  [["network", "use"], "logged-in", 2, /Usage: anet network use/, 0],
  [["network", "use", "nope"], "logged-in", 1, /not found/, 0],
  [["network", "delete", "nope", "--force"], "logged-in", 1, /not found/, 0],
  [["network", "rename", "alpha"], "logged-in", 2, /Usage: anet network rename/, 0],
  [["network", "join"], "logged-in", 2, /Usage: anet network join/, 0],
  [["network", "bogus"], "logged-in", 2, /anet network <command>/, 0],
  [["network"], "none", 0, /anet network <command>/, 0],
  // token / passwd / activate
  [["token", "ls"], "none", 1, /Not logged in/, 0],
  [["token", "ls"], "logged-in", 0, /No tokens/, 0],
  [["token", "revoke"], "logged-in", 2, /Usage: anet token revoke/, 0],
  [["token", "revoke", "tok_x"], "logged-in", 1, /not_found/, 0],
  [["passwd", "--old-password", "a".repeat(10), "--new-password", "b".repeat(10)], "none", 1, /Not logged in/, 0],
  [["passwd", "--old-password", "a".repeat(10), "--new-password", "b".repeat(10)], "logged-in", 1, /invalid_old_password/, 0],
  [["activate", "anet-XXXX"], "none", 1, /anet init/, 0],
  [["activate"], "logged-in", 2, /Usage: anet activate/, 0],
  [["activate", "anet-XXXX"], "logged-in", 1, /invalid_key/, 0],
  // status / tasks
  [["status"], "none", 1, /No hub configured/, 0],
  [["tasks"], "none", 1, /No hub configured/, 0],
  // unknown subcommands = usage error; bare group = help = 0
  [["hub", "bogus"], "none", 2, /anet hub <command>/, 0],
  [["node", "bogus"], "none", 2, /Usage: anet node/, 0],
  [["node"], "none", 0, /Usage: anet node/, 0],
  [["session", "bogus"], "none", 2, /./, 0],
  [["batch", "bogus"], "none", 2, /Unknown batch verb/, 0],
  [["logs"], "none", 2, /anet logs <node-name>/, 0],
  [["node", "resume"], "none", 2, /Usage: anet node resume/, 0],
  [["hub", "stop", "--port", "notaport"], "none", 2, /invalid --port/, 0],
  // demos: preflight failures
  [["demo", "debate"], "none", 1, /没有 hub/, 0],
  [["demo", "socialmedia"], "hub-only", 1, /没有 token/, 0],
  // unchanged, already non-zero before #515 — kept as a guard
  [["bogus-top-level-cmd"], "none", 1, /Unknown/, 1],
  [["--version"], "none", 0, /anet/, 0],
];

describe("#515 exit codes: command × error condition (real CLI, temp HOME, fake hub)", () => {
  for (const [argv, c, want, mention, before] of TABLE) {
    const label = `anet ${argv.join(" ")} [${c}] → ${want}${before !== want ? ` (was ${before})` : ""}`;
    test(label, async () => {
      const home = tempHome(cfg(c));
      const r = await runCli(home, argv);
      const all = r.out + r.err;
      expect({ code: r.code, mentioned: mention.test(all) }).toEqual({ code: want, mentioned: true });
    }, 30_000);
  }
});

describe("finalExitCode()", () => {
  test("no code recorded → 0; recorded number/string → that code", () => {
    const saved = process.exitCode;
    try {
      process.exitCode = undefined;
      expect(finalExitCode()).toBe(ANET_EXIT.OK);
      process.exitCode = 1;
      expect(finalExitCode()).toBe(1);
      process.exitCode = 2;
      expect(finalExitCode()).toBe(ANET_EXIT.USAGE);
    } finally { process.exitCode = saved ?? 0; }
  });

  test("main() terminator exits with finalExitCode(), not a literal 0", async () => {
    const src = await Bun.file(CLI).text();
    const i = src.lastIndexOf("main().then(");
    const success = src.slice(i, src.indexOf("\n", src.indexOf("() =>", i)));
    expect(success).toContain("process.exit(finalExitCode())");
    expect(success).not.toMatch(/process\.exit\(0\)/);
  });
});
