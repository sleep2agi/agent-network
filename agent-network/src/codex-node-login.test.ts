// #529 — per-node codex login: the next step printed at create/clone, and
// `anet node codex login-status`.
//
// Fixture logins only: auth.json bodies with dummy tokens, in temp dirs. No
// real `codex login`, no real ~/.codex, no real ~/.anet, no real hub (an
// in-process fake on a random port). The CLI tests spawn bin/cli.ts with
// HOME=<mktemp> and only run inside Docker (/.dockerenv); the pure tests run
// anywhere because they only touch their own temp dirs.
//
// Every test that prints asserts that no token value — nor its body without a
// prefix — appears anywhere in stdout+stderr.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexCreateLoginGap,
  codexLoginFactsFromText,
  codexLoginNextStepLines,
  codexNodeLoginStatus,
  formatCodexLoginStatus,
} from "./codex-node-login";

const IN_DOCKER = existsSync("/.dockerenv");
const dockerOnly = IN_DOCKER ? test : test.skip;

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.FAKEsigFAKEsigFAKEsig529`;

/** Every token-ish value a fixture writes; none may ever be printed. */
const SECRETS: string[] = [];
function fakeAuth(tag: string, account: string, email: string): string {
  const refresh = `rt_FAKErefresh529${tag}0123456789abcdefghij`;
  const access = `at_FAKEaccess529${tag}0123456789abcdefghij`;
  const id = jwt({ email, sub: `user-${tag}`, "https://api.openai.com/auth": { chatgpt_account_id: account } });
  SECRETS.push(refresh, access, id, id.split(".")[1], account);
  return JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: id, access_token: access, refresh_token: refresh, account_id: account }, last_refresh: "2026-10-01T00:00:00Z" });
}
const API_KEY = "sk-FAKEapikey529-0123456789abcdefghijklmnop";
SECRETS.push(API_KEY);
const NTOK = "ntok_FAKEnode529-0123456789abcdefghijklmnopq";
const UTOK = "utok_FAKEuser529-0123456789abcdefghijklmnopq";
SECRETS.push(NTOK, UTOK);

function leaked(all: string): string[] {
  const hits: string[] = [];
  for (const s of SECRETS) {
    if (all.includes(s)) hits.push(s.slice(0, 12));
    const body = s.replace(/^(rt_|at_|sk-|ntok_|utok_)/, "");
    if (body !== s && all.includes(body)) hits.push(`body:${s.slice(0, 12)}`);
  }
  return hits;
}

const temps: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

/** A node config under <ws>/.anet/nodes/<alias>, optionally with its own codex-home login. */
function node(ws: string, alias: string, cfg: Record<string, unknown>, auth?: string): { dir: string; home: string } {
  const dir = join(ws, ".anet", "nodes", alias);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ node_name: alias, node_id: `n_${alias}`, token: NTOK, ...cfg }), { mode: 0o600 });
  const home = join(dir, "codex-home");
  if (auth !== undefined) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "auth.json"), auth, { mode: 0o600 });
  }
  return { dir, home };
}
const COPRESENCE = { runtime: "codex-app-server", codexCopresence: true };

afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("#529 login facts (pure)", () => {
  test("a ChatGPT login: logged in, fingerprints and e-mail, no token in the result", () => {
    const f = codexLoginFactsFromText(fakeAuth("facts", ACCOUNT_A, "fixture-a@example.invalid"));
    expect(f.loggedIn).toBe(true);
    expect(f.kind).toBe("chatgpt");
    expect(f.loginFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(f.accountFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(f.email).toBe("fixture-a@example.invalid");
    expect(leaked(JSON.stringify(f))).toEqual([]);
  });
  test("missing, empty, unreadable and API-key auth.json", () => {
    expect(codexLoginFactsFromText(null)).toMatchObject({ loggedIn: false, kind: "none" });
    expect(codexLoginFactsFromText("{}")).toMatchObject({ loggedIn: false, kind: "none" });
    expect(codexLoginFactsFromText("{not json")).toMatchObject({ loggedIn: false, kind: "unreadable" });
    const k = codexLoginFactsFromText(JSON.stringify({ OPENAI_API_KEY: API_KEY }));
    expect(k).toMatchObject({ loggedIn: true, kind: "api-key", loginFingerprint: null });
    expect(leaked(JSON.stringify(k))).toEqual([]);
  });
});

describe("#529 login-status rows (pure, temp dirs)", () => {
  function fleet() {
    const root = tmp("anet-529-fleet-");
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    const ws = join(root, "ws");
    const shared = fakeAuth("shared", ACCOUNT_A, "fixture-a@example.invalid");
    node(ws, "alpha", COPRESENCE, shared);
    node(ws, "beta", COPRESENCE, shared);                                       // same file content → same refresh chain
    node(ws, "gamma", COPRESENCE, fakeAuth("gamma", ACCOUNT_A, "fixture-a@example.invalid")); // same account, own login
    node(ws, "delta", COPRESENCE, fakeAuth("delta", ACCOUNT_B, "fixture-b@example.invalid"));
    node(ws, "epsilon", COPRESENCE);                                            // no login
    node(ws, "sdk", { runtime: "codex-sdk" });                                  // default home, no login
    node(ws, "claude", { runtime: "claude-agent-sdk" });                        // not a codex node
    return { root, home, ws };
  }

  test("one row per codex node; shared refresh chain detected; same account with own login is not 'shared'", () => {
    const { home, ws } = fleet();
    const rows = codexNodeLoginStatus({ nodesRoot: join(ws, ".anet", "nodes"), env: {}, home });
    const by = Object.fromEntries(rows.map((r) => [r.alias, r]));
    expect(rows.map((r) => r.alias).sort()).toEqual(["alpha", "beta", "delta", "epsilon", "gamma", "sdk"]);
    expect(by.alpha.shared_with).toEqual(["beta"]);
    expect(by.beta.shared_with).toEqual(["alpha"]);
    expect(by.gamma.shared_with).toEqual([]);
    expect(by.gamma.same_account_as).toEqual(["alpha", "beta"]);
    expect(by.delta.shared_with).toEqual([]);
    expect(by.delta.same_account_as).toEqual([]);
    expect(by.alpha.account_fingerprint).toBe(by.gamma.account_fingerprint!);
    expect(by.alpha.login_fingerprint).not.toBe(by.gamma.login_fingerprint);
    expect(by.epsilon).toMatchObject({ logged_in: false, codex_home: join(ws, ".anet", "nodes", "epsilon", "codex-home"), codex_home_source: "node-codex-home" });
    expect(by.sdk).toMatchObject({ logged_in: false, codex_home: join(home, ".codex"), codex_home_source: "default" });
    expect(by.delta.email).toBe("fixture-b@example.invalid");
    const text = formatCodexLoginStatus(rows, ws).join("\n");
    expect(text).toContain("⚠ beta");
    expect(text).toContain("share a codex login");
    expect(text).toContain(`epsilon: CODEX_HOME=${join(ws, ".anet", "nodes", "epsilon", "codex-home")} codex login`);
    expect(leaked(JSON.stringify(rows) + text)).toEqual([]);
  });

  test("two codex-sdk nodes on the default home share it", () => {
    const root = tmp("anet-529-sdk-");
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), fakeAuth("host", ACCOUNT_A, "fixture-a@example.invalid"));
    const ws = join(root, "ws");
    node(ws, "s1", { runtime: "codex-sdk" });
    node(ws, "s2", { runtime: "codex-sdk" });
    const rows = codexNodeLoginStatus({ nodesRoot: join(ws, ".anet", "nodes"), env: {}, home });
    expect(rows.map((r) => [r.alias, r.logged_in, r.shared_with])).toEqual([["s1", true, ["s2"]], ["s2", true, ["s1"]]]);
  });
});

describe("#529 create-time next step (pure)", () => {
  test("the line is the exact command for this node's own CODEX_HOME, with --device-auth offered", () => {
    const lines = codexLoginNextStepLines({ alias: "n1", codexHome: "/w/.anet/nodes/n1/codex-home", homeExists: false, then: "anet node start n1" }).join("\n");
    expect(lines).toContain("mkdir -p -m 700 /w/.anet/nodes/n1/codex-home && CODEX_HOME=/w/.anet/nodes/n1/codex-home codex login\n");
    expect(lines).toContain("CODEX_HOME=/w/.anet/nodes/n1/codex-home codex login --device-auth");
    expect(lines).toContain("Then: anet node start n1");
    const quoted = codexLoginNextStepLines({ alias: "n 2", codexHome: "/w s/codex-home", homeExists: true }).join("\n");
    expect(quoted).toContain("    CODEX_HOME='/w s/codex-home' codex login");
    expect(quoted).not.toContain("mkdir");
  });

  test("gap decisions: own login / host login stageable / host login held / none", () => {
    const root = tmp("anet-529-gap-");
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const ws = join(root, "ws");
    const cfgOf = (n: { dir: string }) => JSON.parse(readFileSync(join(n.dir, "config.json"), "utf-8"));
    const own = node(ws, "own", COPRESENCE, fakeAuth("own", ACCOUNT_A, "fixture-a@example.invalid"));
    const bare = node(ws, "bare", COPRESENCE);
    const sdk = node(ws, "sdk", { runtime: "codex-sdk" });
    const gap = (n: { dir: string }, stageable: boolean) =>
      codexCreateLoginGap({ nodeDir: n.dir, config: cfgOf(n), env: {}, home, hostLoginWouldBeStaged: () => stageable });
    expect(gap(own, false)).toBeNull();
    expect(gap(bare, true)).toEqual({ codexHome: bare.home, homeExists: false });  // no host login at all
    expect(gap(sdk, true)).toEqual({ codexHome: join(home, ".codex"), homeExists: true });
    writeFileSync(join(home, ".codex", "auth.json"), fakeAuth("host2", ACCOUNT_A, "fixture-a@example.invalid"));
    expect(gap(bare, true)).toBeNull();                                             // first start stages the host login
    expect(gap(bare, false)).toEqual({ codexHome: bare.home, homeExists: false });  // #514 would refuse it
    expect(gap(sdk, true)).toBeNull();                                              // codex-sdk uses ~/.codex
    expect(codexCreateLoginGap({ nodeDir: join(ws, "x"), config: { runtime: "claude-agent-sdk" }, env: {}, home, hostLoginWouldBeStaged: () => false })).toBeNull();
  });
});

// ── real CLI, Docker only ────────────────────────────────────────────────────
let hub: ReturnType<typeof Bun.serve> | null = null;
let HUB = "";
let minted = 0;
beforeAll(() => {
  if (!IN_DOCKER) return;
  hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, version: "0.0.0-fake" });
      if (url.pathname === "/api/auth/me") return Response.json({ ok: true, user: { username: "u", user_id: "usr_1", role: "user" }, networks: [{ network_id: "net_aaaaaaaaaaaa", network_name: "alpha" }] });
      if (url.pathname === "/api/auth/node-token" && req.method === "POST") return Response.json({ ok: true, token: `${NTOK}${++minted}` });
      if (url.pathname === "/api/networks") return Response.json({ ok: true, networks: [{ network_id: "net_aaaaaaaaaaaa", network_name: "alpha", member_role: "owner" }] });
      return Response.json({ ok: true });
    },
  });
  HUB = `http://127.0.0.1:${hub.port}`;
});
afterAll(() => { hub?.stop(true); });

const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;
function cliWorld(hostAuth?: string) {
  const root = tmp("anet-529-cli-");
  const home = join(root, "home");
  mkdirSync(join(home, ".anet"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".anet", "config.json"), JSON.stringify({ hub: HUB, token: UTOK, network_id: "net_aaaaaaaaaaaa", network_name: "alpha", user: { user_id: "usr_1", username: "u", role: "user" } }), { mode: 0o600 });
  if (hostAuth) {
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".codex", "auth.json"), hostAuth, { mode: 0o600 });
  }
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  return { root, home, ws };
}
async function runCli(w: { home: string; ws: string }, argv: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANET_|COMMHUB_|CODEX_|OPENAI_|ANTHROPIC_|TMUX)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: w.home, USERPROFILE: w.home, NO_COLOR: "1", ANET_NO_UPDATE_CHECK: "1" });
  const p = Bun.spawn(["bun", CLI, ...argv], { env, cwd: w.ws, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 60_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(killer);
  return { out, err, code, all: out + err };
}

describe("#529 real CLI (Docker only)", () => {
  dockerOnly("create codex-sdk with no login ends with the login step for its CODEX_HOME", async () => {
    const w = cliWorld();
    const r = await runCli(w, ["node", "create", "fresh-sdk", "--runtime", "codex-sdk"]);
    expect(r.code).toBe(0);
    const tail = r.out.trimEnd().split("\n").slice(-8).join("\n");
    expect(tail).toContain("Next step — fresh-sdk has no codex login yet");
    expect(tail).toContain(`CODEX_HOME=${join(w.home, ".codex")} codex login --device-auth`);
    expect(tail).toContain("Then: anet node start fresh-sdk");
    expect(leaked(r.all)).toEqual([]);
  }, 90_000);

  dockerOnly("create a co-presence node: own codex-home in the command; nothing created or copied", async () => {
    const w = cliWorld();
    const r = await runCli(w, ["node", "create", "fresh-tui", "--runtime", "codex-app-server", "--copresence"]);
    expect(r.code).toBe(0);
    const ch = join(w.ws, ".anet", "nodes", "fresh-tui", "codex-home");
    // co-presence create seeds yolo config.toml (dir exists) — login hint skips mkdir.
    expect(r.out).toContain(`CODEX_HOME=${ch} codex login\n`);
    expect(existsSync(join(ch, "config.toml"))).toBe(true);
    expect(readFileSync(join(ch, "config.toml"), "utf8")).toContain('approval_policy = "never"');
    expect(existsSync(join(ch, "auth.json"))).toBe(false);
    expect(leaked(r.all)).toEqual([]);
  }, 90_000);

  dockerOnly("create codex-sdk WITH a host login prints no login step", async () => {
    const w = cliWorld(fakeAuth("cli-host", ACCOUNT_A, "fixture-a@example.invalid"));
    const r = await runCli(w, ["node", "create", "ready-sdk", "--runtime", "codex-sdk"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("has no codex login yet");
    expect(r.out).toContain("Start: anet node start ready-sdk");
    expect(leaked(r.all)).toEqual([]);
  }, 90_000);

  dockerOnly("clone of a logged-in co-presence node: the copy gets no login and the command ends with its own login step", async () => {
    const w = cliWorld();
    const src = node(w.ws, "origin", { ...COPRESENCE, hub: HUB, network_id: "net_aaaaaaaaaaaa" }, fakeAuth("cli-origin", ACCOUNT_A, "fixture-a@example.invalid"));
    const r = await runCli(w, ["node", "clone", "origin", "copy"]);
    expect(r.code).toBe(0);
    const ch = join(w.ws, ".anet", "nodes", "copy", "codex-home");
    const tail = r.out.trimEnd().split("\n").slice(-8).join("\n");
    expect(tail).toContain("Next step — copy has no codex login yet");
    expect(tail).toContain(`CODEX_HOME=${ch} codex login --device-auth`);
    expect(existsSync(join(ch, "auth.json"))).toBe(false);
    expect(existsSync(join(src.home, "auth.json"))).toBe(true);
    expect(leaked(r.all)).toEqual([]);
  }, 90_000);

  dockerOnly("login-status (table and --json) shows the shared login and never a token", async () => {
    const w = cliWorld();
    const shared = fakeAuth("cli-shared", ACCOUNT_A, "fixture-a@example.invalid");
    node(w.ws, "one", COPRESENCE, shared);
    node(w.ws, "two", COPRESENCE, shared);
    node(w.ws, "three", COPRESENCE);
    const t = await runCli(w, ["node", "codex", "login-status"]);
    expect(t.code).toBe(0);
    expect(t.out).toMatch(/^ALIAS\s+RUNTIME\s+LOGGED IN\s+ACCOUNT\s+SHARED WITH\s+CODEX_HOME/m);
    expect(t.out).toMatch(/^one\s.*\syes\s+fixture-a@example\.invalid\s+⚠ two\s/m);
    expect(t.out).toMatch(/^three\s.*\sno\s/m);
    const j = await runCli(w, ["node", "codex", "login-status", "--json"]);
    expect(j.code).toBe(0);
    const rows = JSON.parse(j.out);
    expect(rows.find((r: any) => r.alias === "two").shared_with).toEqual(["one"]);
    expect(rows.find((r: any) => r.alias === "three").logged_in).toBe(false);
    expect(leaked(t.all + j.all)).toEqual([]);
  }, 90_000);
});
