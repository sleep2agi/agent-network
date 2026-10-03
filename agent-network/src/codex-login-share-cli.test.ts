// #514 — the real CLI (`anet node start <alias> --copresence`) against a temp
// HOME, a fake in-process hub and FAKE auth.json bodies.
//
// 🔴 Docker only (/.dockerenv): this path probes for `tmux` / `codex` / `bunx` and, past
//    the gate, would go on to start them. Here both are stub scripts that exit 1
//    and come first on PATH, tmux additionally gets a private ANET_TMUX_SOCKET,
//    and TMUX/TMUX_PANE are removed — but none of that is a reason to run it on
//    a host with a live fleet. On the host every test here is skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkCodexCredentialSharing } from "./codex-auth-fingerprint";
import { CODEX_AUTH_ORIGIN_FILE } from "./codex-login-share-guard";

const IN_DOCKER = existsSync("/.dockerenv");
const t = IN_DOCKER ? test : test.skip;

const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;
const SECRET = "fake-refresh-SECRET-514-cli";
const fakeAuth = (refresh: string) => JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { id_token: "fake-id", access_token: "fake-access", refresh_token: refresh, account_id: "00000000-0000-4000-8000-000000000000" },
});

let hub: ReturnType<typeof Bun.serve> | null = null;
let HUB = "";
const temps: string[] = [];

beforeAll(() => {
  if (!IN_DOCKER) return;
  hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, version: "0.0.0-fake" });
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
  HUB = `http://127.0.0.1:${hub.port}`;
});
afterAll(() => {
  hub?.stop(true);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface World { home: string; ws: string; stubs: string; index: string; hostAuth: string }

function world(hostRefresh: string | null): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anet-514-cli-")));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".anet"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".anet", "config.json"), JSON.stringify({ hub: HUB }), { mode: 0o600 });
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  const hostAuth = join(home, ".codex", "auth.json");
  if (hostRefresh) writeFileSync(hostAuth, fakeAuth(hostRefresh), { mode: 0o600 });
  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  // Every command the co-presence dependency preflight probes (src/copresence-deps.ts),
  // so the run reaches the staging gate on any image — bunx is absent from some.
  // The hub is the in-process fake, so bunx is never actually used.
  for (const name of ["tmux", "codex", "bunx"]) {
    writeFileSync(join(stubs, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(stubs, name), 0o755);
  }
  const ws = join(root, "ws-target");
  return { home, ws, stubs, index: join(home, ".anet", "codex-auth-fingerprints"), hostAuth };
}

/** A codex co-presence node config under <ws>/.anet/nodes/<alias>. */
function codexNode(ws: string, alias: string, refresh?: string): { dir: string; home: string } {
  const dir = join(ws, ".anet", "nodes", alias);
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    node_name: alias, node_id: `n_${alias}`, runtime: "codex-app-server", codexCopresence: true,
    token: `ntok_${alias}_${"x".repeat(24)}`, hub: HUB, network_id: "net_aaaaaaaaaaaa",
  }), { mode: 0o600 });
  if (refresh) writeFileSync(join(home, "auth.json"), fakeAuth(refresh), { mode: 0o600 });
  return { dir, home };
}

/** Run the CLI until it exits, or until `stopAt` shows up on stderr (then kill it — past the gate we do not care). */
async function runStart(w: World, alias: string, extra: string[] = [], stopAt?: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANET_|COMMHUB_|CODEX_|TMUX)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = w.home; env.USERPROFILE = w.home; env.NO_COLOR = "1";
  env.PATH = `${w.stubs}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  env.ANET_TMUX_SOCKET = join(w.home, "tmux.sock");
  const p = Bun.spawn(["bun", CLI, "node", "start", alias, "--copresence", ...extra], { env, cwd: w.ws, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let err = "";
  const reader = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stderr as ReadableStream<Uint8Array>) {
      err += dec.decode(chunk);
      if (stopAt && err.includes(stopAt)) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
    }
  })();
  const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 60_000);
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(killer);
  await reader;
  return { out, err, code };
}

describe("#514 anet node start --copresence (real CLI, Docker only)", () => {
  t("refuses (exit 1) to stage the host login into a NEW node when another node already uses it", async () => {
    const w = world(SECRET);
    const holder = codexNode(join(w.home, "..", "ws-holder"), "holder", SECRET);
    checkCodexCredentialSharing({ nodeDir: holder.dir, alias: "holder", codexHome: holder.home, indexDir: w.index, say: () => {} });
    const n = codexNode(w.ws, "fresh");
    const r = await runStart(w, "fresh");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to give fresh the host login");
    expect(r.err).toContain("already used by: holder");
    expect(r.err).toContain(`CODEX_HOME=${n.home} codex login --device-auth`);
    expect(r.err).toContain("--allow-shared-codex-login");
    expect(existsSync(join(n.home, "auth.json"))).toBe(false);          // nothing was copied
    expect(existsSync(join(n.dir, CODEX_AUTH_ORIGIN_FILE))).toBe(false);
    expect(`${r.out}\n${r.err}`).not.toContain(SECRET);
  }, 90_000);

  t("--allow-shared-codex-login stages it anyway, loudly", async () => {
    const w = world(SECRET);
    const holder = codexNode(join(w.home, "..", "ws-holder"), "holder", SECRET);
    checkCodexCredentialSharing({ nodeDir: holder.dir, alias: "holder", codexHome: holder.home, indexDir: w.index, say: () => {} });
    const n = codexNode(w.ws, "fresh");
    const r = await runStart(w, "fresh", ["--allow-shared-codex-login"], "shares its codex login with");
    expect(r.err).toContain("--allow-shared-codex-login: giving fresh the host login");
    expect(r.err).not.toContain("refusing to give");
    expect(readFileSync(join(n.home, "auth.json"), "utf-8")).toBe(readFileSync(w.hostAuth, "utf-8"));
    expect(`${r.out}\n${r.err}`).not.toContain(SECRET);
  }, 90_000);

  t("the first node to borrow the host login is allowed and its origin is recorded", async () => {
    const w = world(SECRET);
    const n = codexNode(w.ws, "first");
    const r = await runStart(w, "first", [], "One login per node");
    expect(r.err).toContain("first now uses the host codex login");
    expect(r.err).not.toContain("refusing to give");
    expect(existsSync(join(n.dir, CODEX_AUTH_ORIGIN_FILE))).toBe(true);
  }, 90_000);

  t("an EXISTING node that already shares is warned, not refused", async () => {
    const w = world(SECRET);
    const holder = codexNode(join(w.home, "..", "ws-holder"), "holder", SECRET);
    checkCodexCredentialSharing({ nodeDir: holder.dir, alias: "holder", codexHome: holder.home, indexDir: w.index, say: () => {} });
    const n = codexNode(w.ws, "legacy", SECRET);                   // predates #514: already has the copy
    utimesSync(join(n.home, "auth.json"), new Date(1_000_000), new Date(1_000_000));   // host copy is newer → re-stage path
    const r = await runStart(w, "legacy", [], "shares its codex login with");
    expect(r.err).not.toContain("refusing to give");
    expect(r.err).toContain("legacy shares its codex login with: holder");
    expect(r.code).not.toBe(1);   // killed at the warning (SIGKILL), never the refusal exit
  }, 90_000);
});
