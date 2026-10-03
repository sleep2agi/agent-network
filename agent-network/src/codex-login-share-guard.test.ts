// #514 (child of #502) — one codex login per node: the gate in front of every
// path that hands a node a credential. Temp dirs + FAKE auth.json bodies only;
// nothing here reads a real ~/.codex or ~/.anet (the host index is injected).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodexCredentialSharing, fingerprintRefreshToken } from "./codex-auth-fingerprint";
import { codexHomeStagePlan } from "./codex-copresence-preflight";
import {
  ALLOW_SHARED_CODEX_LOGIN_FLAG,
  CODEX_AUTH_ORIGIN_FILE,
  codexLoginFingerprintOfFile,
  decideCodexLoginStaging,
  evaluateCodexLoginStaging,
  findCodexLoginHolders,
  homeCheckPendingOwnLogin,
  newLoginStep,
  recordCodexLoginOrigin,
  sharedCodexLoginGroups,
} from "./codex-login-share-guard";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Fake values only. The refresh token string is what must never be printed. */
const fakeAuth = (refresh: string) => JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "fake-id", access_token: "fake-access", refresh_token: refresh, account_id: "00000000-0000-4000-8000-000000000000" },
  last_refresh: "2026-10-04T00:00:00Z",
});

interface Host { root: string; index: string; hostHome: string }
function host(): Host {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anet-514-")));
  temps.push(root);
  const index = join(root, "home", ".anet", "codex-auth-fingerprints");
  const hostHome = join(root, "home", ".codex");
  mkdirSync(hostHome, { recursive: true });
  return { root, index, hostHome };
}

/** A node dir under <workspace>/.anet/nodes/<alias>, optionally with its own auth.json. */
function node(h: Host, workspace: string, alias: string, refresh?: string): { dir: string; home: string } {
  const dir = join(h.root, workspace, ".anet", "nodes", alias);
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (refresh) writeFileSync(join(home, "auth.json"), fakeAuth(refresh), { mode: 0o600 });
  return { dir, home };
}

/** What #1918 publishes when a node starts: the real writer, with the index injected. */
function publish(h: Host, n: { dir: string; home: string }, alias: string): void {
  checkCodexCredentialSharing({ nodeDir: n.dir, alias, codexHome: n.home, indexDir: h.index, say: () => {} });
}

const SECRET = "fake-refresh-SECRET-do-not-print";

describe("#514 host staging (anet node start --copresence into a node with no auth.json)", () => {
  test("first node to borrow the host login is allowed, told the rule, and its origin is recorded", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth(SECRET));
    const n = node(h, "ws-a", "alpha");
    const r = evaluateCodexLoginStaging({
      nodeDir: n.dir, alias: "alpha", targetCodexHome: n.home, sourceAuthPath: join(h.hostHome, "auth.json"),
      source: { kind: "host", path: join(h.hostHome, "auth.json") }, allowShared: false, indexDir: h.index,
    });
    expect(r.kind).toBe("ok");
    expect(r.holders).toEqual([]);
    expect(r.lines.join("\n")).toContain("One login per node");
    expect(r.fingerprint).toBe(fingerprintRefreshToken(fakeAuth(SECRET))!);
    expect(recordCodexLoginOrigin({ nodeDir: n.dir, alias: "alpha", fingerprint: r.fingerprint!, source: { kind: "host", path: "x" }, indexDir: h.index })).toBeNull();
    const rec = readFileSync(join(n.dir, CODEX_AUTH_ORIGIN_FILE), "utf-8");
    expect(JSON.parse(rec).origin_fingerprint).toBe(r.fingerprint);
    // 🔴 The origin record must not look like a #1918 record (no `fingerprint` key),
    //    and must never carry the token.
    expect(JSON.parse(rec).fingerprint).toBeUndefined();
    expect(rec).not.toContain(SECRET);
    expect(statSync(join(n.dir, CODEX_AUTH_ORIGIN_FILE)).mode & 0o777).toBe(0o600);
  });

  test("second node in ANOTHER workspace is refused, naming the holder by alias, with fix + override", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth(SECRET));
    const a = node(h, "ws-a", "alpha", SECRET);   // already staged from the host
    publish(h, a, "alpha");
    const b = node(h, "ws-b", "beta");
    const r = evaluateCodexLoginStaging({
      nodeDir: b.dir, alias: "beta", targetCodexHome: b.home, sourceAuthPath: join(h.hostHome, "auth.json"),
      source: { kind: "host", path: join(h.hostHome, "auth.json") }, allowShared: false, indexDir: h.index,
    });
    expect(r.kind).toBe("refuse");
    expect(r.holders.map((x) => x.alias)).toEqual(["alpha"]);
    const text = r.lines.join("\n");
    expect(text).toContain("already used by: alpha");
    expect(text).toContain(`CODEX_HOME=${b.home} codex login --device-auth`);
    expect(text).toContain(ALLOW_SHARED_CODEX_LOGIN_FLAG);
    expect(text).toContain("token_revoked");
    // Positive control first, so the not.toContain below cannot pass on an empty string.
    expect(text.length).toBeGreaterThan(200);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(a.home);           // aliases only for other nodes
  });

  test(`${ALLOW_SHARED_CODEX_LOGIN_FLAG} turns the refusal into a loud override`, () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth(SECRET));
    const a = node(h, "ws-a", "alpha", SECRET);
    publish(h, a, "alpha");
    const b = node(h, "ws-b", "beta");
    const r = evaluateCodexLoginStaging({
      nodeDir: b.dir, alias: "beta", targetCodexHome: b.home, sourceAuthPath: join(h.hostHome, "auth.json"),
      source: { kind: "host", path: join(h.hostHome, "auth.json") }, allowShared: true, indexDir: h.index,
    });
    expect(r.kind).toBe("override");
    expect(r.lines[0]).toContain("already used by: alpha");
  });

  test("a node that already rotated away from the host copy still blocks it (origin record)", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth("rt-0"));
    const a = node(h, "ws-a", "alpha", "rt-1");      // alpha refreshed: rt-0 → rt-1
    publish(h, a, "alpha");                          // current fingerprint = rt-1
    recordCodexLoginOrigin({ nodeDir: a.dir, alias: "alpha", fingerprint: fingerprintRefreshToken(fakeAuth("rt-0"))!, source: { kind: "host", path: "x" }, indexDir: h.index });
    const b = node(h, "ws-b", "beta");
    const r = evaluateCodexLoginStaging({
      nodeDir: b.dir, alias: "beta", targetCodexHome: b.home, sourceAuthPath: join(h.hostHome, "auth.json"),
      source: { kind: "host", path: join(h.hostHome, "auth.json") }, allowShared: false, indexDir: h.index,
    });
    expect(r.kind).toBe("refuse");
    expect(r.holders).toEqual([{ alias: "alpha", nodeDir: a.dir, via: "origin" }]);
  });

  test("a different login, a gone node, and the node itself are not holders", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth(SECRET));
    const other = node(h, "ws-a", "other", "rt-different");
    publish(h, other, "other");
    const gone = node(h, "ws-g", "gone", SECRET);
    publish(h, gone, "gone");
    rmSync(join(h.root, "ws-g"), { recursive: true, force: true });  // node deleted; its index record stays
    const self = node(h, "ws-s", "self", SECRET);
    publish(h, self, "self");                                        // a restart of itself
    const holders = findCodexLoginHolders({ fingerprint: fingerprintRefreshToken(fakeAuth(SECRET))!, selfNodeDir: self.dir, indexDir: h.index });
    expect(holders).toEqual([]);
  });

  test("an API-key / unparsable auth.json is not a rotating login — no gate, no lines", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fake-key" }));
    const a = node(h, "ws-a", "alpha", SECRET);
    publish(h, a, "alpha");
    const b = node(h, "ws-b", "beta");
    const r = evaluateCodexLoginStaging({
      nodeDir: b.dir, alias: "beta", targetCodexHome: b.home, sourceAuthPath: join(h.hostHome, "auth.json"),
      source: { kind: "host", path: join(h.hostHome, "auth.json") }, allowShared: false, indexDir: h.index,
      knownHolders: [{ alias: "alpha", nodeDir: a.dir, via: "current" }],
    });
    expect(r).toMatchObject({ kind: "ok", lines: [], fingerprint: null, holders: [] });
  });

  test("the scan is read-only: the host index is byte-identical afterwards (no ghost cleanup, no writes)", () => {
    const h = host();
    const a = node(h, "ws-a", "alpha", SECRET);
    publish(h, a, "alpha");
    const gone = node(h, "ws-g", "gone", SECRET);
    publish(h, gone, "gone");
    rmSync(join(h.root, "ws-g"), { recursive: true, force: true });
    const snap = () => readdirSync(h.index).sort().map((f) => `${f}:${readFileSync(join(h.index, f), "utf-8")}`);
    const before = snap();
    expect(before.length).toBe(2);
    findCodexLoginHolders({ fingerprint: fingerprintRefreshToken(fakeAuth(SECRET))!, selfNodeDir: join(h.root, "x", ".anet", "nodes", "x"), indexDir: h.index });
    expect(snap()).toEqual(before);
  });
});

describe("#514 which staging steps are gated: new sharing only, existing nodes warn", () => {
  const stat = (m: Record<string, number>) => (p: string) => (p in m ? { mtimeMs: m[p] } : null);
  const j = (a: string, b: string) => `${a}/${b}`;

  test("auth.json missing in the node → gated", () => {
    const plan = codexHomeStagePlan("/h", "/n", stat({ "/h/auth.json": 2, "/h/version.json": 2 }), j);
    expect(newLoginStep(plan)?.src).toBe("/h/auth.json");
  });

  test("auth.json present but older (re-stage of an existing node) → NOT gated", () => {
    const plan = codexHomeStagePlan("/h", "/n", stat({ "/h/auth.json": 5, "/n/auth.json": 1 }), j);
    expect(plan.map((s) => s.reason)).toEqual(["host-newer"]);
    expect(newLoginStep(plan)).toBeUndefined();
  });

  test("an existing shared node still starts and gets the #1918 warning (not a refusal)", () => {
    const h = host();
    writeFileSync(join(h.hostHome, "auth.json"), fakeAuth(SECRET));
    const a = node(h, "ws-a", "alpha", SECRET);
    publish(h, a, "alpha");
    const b = node(h, "ws-b", "beta", SECRET);     // already shares — predates #514
    const nodeAuth = join(b.home, "auth.json");
    utimesSync(nodeAuth, new Date(1_000_000), new Date(1_000_000));
    const plan = codexHomeStagePlan(h.hostHome, b.home, (p) => { try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; } }, join);
    expect(newLoginStep(plan)).toBeUndefined();
    const said: string[] = [];
    const peers = checkCodexCredentialSharing({ nodeDir: b.dir, alias: "beta", codexHome: b.home, indexDir: h.index, say: (m) => said.push(m) });
    expect(peers.map((p) => p.alias)).toEqual(["alpha"]);
    expect(said.join("\n")).toContain("shares its codex login with: alpha");
  });
});

describe("#514 anet node codex fork", () => {
  test("refused by default: the source always holds its own login, even with no published record", () => {
    const h = host();
    const src = node(h, "ws-a", "src", SECRET);
    const tgtDir = join(h.root, "ws-b", ".anet", "nodes", "tgt");      // does not exist yet
    const r = evaluateCodexLoginStaging({
      nodeDir: tgtDir, alias: "tgt", targetCodexHome: join(tgtDir, "codex-home"), sourceAuthPath: join(src.home, "auth.json"),
      source: { kind: "fork", sourceAlias: "src" }, allowShared: false, indexDir: h.index,
      knownHolders: [{ alias: "src", nodeDir: src.dir, via: "current" }],
      extraFix: ["[anet]   For a fork: re-run with --no-codex-login"],
    });
    expect(r.kind).toBe("refuse");
    expect(r.lines.join("\n")).toContain("fork source src's auth.json");
    expect(r.lines.join("\n")).toContain("--no-codex-login");
    expect(r.lines.join("\n")).not.toContain(SECRET);
  });

  test("override still names the source", () => {
    const h = host();
    const src = node(h, "ws-a", "src", SECRET);
    const tgtDir = join(h.root, "ws-b", ".anet", "nodes", "tgt");
    const r = evaluateCodexLoginStaging({
      nodeDir: tgtDir, alias: "tgt", targetCodexHome: join(tgtDir, "codex-home"), sourceAuthPath: join(src.home, "auth.json"),
      source: { kind: "fork", sourceAlias: "src" }, allowShared: true, indexDir: h.index,
      knownHolders: [{ alias: "src", nodeDir: src.dir, via: "current" }],
    });
    expect(r.kind).toBe("override");
    expect(r.holders.map((x) => x.alias)).toEqual(["src"]);
  });

  test("--no-codex-login: home_isolated passes only when every other rule passes", () => {
    const pass = { key: "home_isolated", status: "pass", detail: "CODEX_HOME 0700, auth.json 0600 (1 B), token fp x" };
    const fail = { key: "home_isolated", status: "fail", detail: "node config carries no CommHub token" };
    const p = homeCheckPendingOwnLogin(pass, "/t/codex-home");
    expect(p.status).toBe("pass");
    expect(p.detail).toContain("CODEX_HOME=/t/codex-home codex login --device-auth");
    expect(homeCheckPendingOwnLogin(fail, "/t/codex-home")).toEqual(fail);
  });
});

describe("#514 anet node codex account install", () => {
  test("a profile whose chain another node holds is refused; reinstalling into the same node is not sharing", () => {
    const h = host();
    const profile = join(h.root, "home", ".anet", "codex-login", "profiles", "work", "auth.json");
    mkdirSync(join(profile, ".."), { recursive: true });
    writeFileSync(profile, fakeAuth(SECRET));
    const other = node(h, "ws-a", "other", SECRET);
    publish(h, other, "other");
    const tgt = node(h, "ws-b", "tgt", "rt-own");
    const args = { targetCodexHome: tgt.home, sourceAuthPath: profile, source: { kind: "account", profileId: "work" } as const, allowShared: false, indexDir: h.index };
    const r = evaluateCodexLoginStaging({ ...args, nodeDir: tgt.dir, alias: "tgt" });
    expect(r.kind).toBe("refuse");
    expect(r.lines[0]).toContain("registered profile codex-login:work");
    // The node that already holds it is "self" when it is the target.
    expect(evaluateCodexLoginStaging({ ...args, nodeDir: other.dir, alias: "other", targetCodexHome: other.home }).kind).toBe("ok");
  });
});

describe("#514 anet doctor: groups of nodes already sharing a login", () => {
  test("groups ≥2 live nodes by CURRENT fingerprint; origin records and gone nodes do not count", () => {
    const h = host();
    const a = node(h, "ws-a", "alpha", SECRET); publish(h, a, "alpha");
    const b = node(h, "ws-b", "beta", SECRET); publish(h, b, "beta");
    const c = node(h, "ws-c", "gamma", "rt-own"); publish(h, c, "gamma");
    recordCodexLoginOrigin({ nodeDir: c.dir, alias: "gamma", fingerprint: fingerprintRefreshToken(fakeAuth(SECRET))!, source: { kind: "host", path: "x" }, indexDir: h.index });
    const g = node(h, "ws-g", "gone", SECRET); publish(h, g, "gone");
    rmSync(join(h.root, "ws-g"), { recursive: true, force: true });
    const groups = sharedCodexLoginGroups({ indexDir: h.index });
    expect(groups).toEqual([{ fingerprint: fingerprintRefreshToken(fakeAuth(SECRET))!, aliases: ["alpha", "beta"] }]);
    expect(JSON.stringify(groups)).not.toContain(SECRET);
  });

  test("sibling records are found without an index", () => {
    const h = host();
    const a = node(h, "ws", "alpha", SECRET); publish(h, a, "alpha");
    const b = node(h, "ws", "beta", SECRET); publish(h, b, "beta");
    rmSync(h.index, { recursive: true, force: true });
    expect(sharedCodexLoginGroups({ indexDir: h.index, nodeRoots: [join(h.root, "ws", ".anet", "nodes")] })[0]?.aliases).toEqual(["alpha", "beta"]);
  });
});

describe("#514 decision text", () => {
  test("codexLoginFingerprintOfFile hashes and never returns the token", () => {
    const h = host();
    const p = join(h.root, "auth.json");
    writeFileSync(p, fakeAuth(SECRET));
    const fp = codexLoginFingerprintOfFile(p)!;
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(codexLoginFingerprintOfFile(join(h.root, "missing.json"))).toBeNull();
  });

  test("no holders + non-host source prints nothing", () => {
    expect(decideCodexLoginStaging({ alias: "a", targetCodexHome: "/x", fingerprint: "deadbeef", holders: [], source: { kind: "account", profileId: "p" }, allowShared: false })).toEqual({ kind: "ok", lines: [] });
  });
});

describe("#514 the CLI actually gates every staging path (source contract)", () => {
  // A pure module nothing calls is a fix that always takes its no-op branch.
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf-8").replace(/\r\n?/g, "\n");
  const at = (needle: string) => { const i = cli.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  test("three gate call sites: host staging, fork, account install", () => {
    expect(cli.match(/gateCodexLoginStaging\(\{/g)?.length).toBe(3);
  });

  test("a refusal is exit 1 (#2321: failure), not 2", () => {
    const fn = cli.slice(at("function gateCodexLoginStaging"), at("function recordCodexLoginOriginOrWarn"));
    expect(fn).toContain(`process.exit(1);`);
    expect(fn).not.toContain(`process.exit(2)`);
  });

  test("host staging: gated on a NEW login, before any file is copied", () => {
    expect(at("const authStep = newLoginStep(plan);")).toBeLessThan(at("copyFileSync(step.src, step.dst);"));
    expect(cli).toContain(`allowSharedCodexLogin: opts["allow-shared-codex-login"] === "true",`);
    // The origin record is written BEFORE the "now uses the host login" lines are
    // printed (CI flake on 3ea41aec: a kill at that line raced the write).
    const fn = cli.slice(at("function gateCodexLoginStaging"), at("function recordCodexLoginOriginOrWarn"));
    expect(fn.indexOf("beforeAnnounce?.(r);")).toBeGreaterThan(-1);
    expect(fn.indexOf("beforeAnnounce?.(r);")).toBeLessThan(fn.lastIndexOf("for (const l of r.lines) console.error(l);"));
    expect(cli).toContain("(gate) => recordCodexLoginOriginOrWarn(nodeDir, displayName, gate.fingerprint, source)");
  });

  test("fork: gated before the hub registration and the copy; --no-codex-login skips auth.json", () => {
    const g = at("const forkGate = forkNoLogin ? null : gateCodexLoginStaging({");
    expect(g).toBeLessThan(at("const withTok = await ensureNodeToken(draft, target);"));
    expect(g).toBeLessThan(at("for (const f of FORK_HOME_COPY) {"));
    expect(cli).toContain(`if (f.name === "auth.json" && forkNoLogin) continue;`);
    expect(cli).toContain(`knownHolders: [{ alias: sourceName, nodeDir: sourceDir, via: "current" }],`);
  });

  test("account install: gated before the install runs", () => {
    expect(at("const accountGate = gateCodexLoginStaging({")).toBeLessThan(at("const outcome = await runAccountInstall("));
  });

  test("doctor lists groups that already share (warning, never a refusal)", () => {
    const i = at("sharedCodexLoginGroups({ nodeRoots: [nodesDir()] })");
    expect(cli.slice(i, i + 600)).toContain(`warning(\n      "Shared codex login",`);
  });

  test("the flag is in the node start help", () => {
    expect(cli).toContain("  --allow-shared-codex-login  UNSAFE.");
  });
});
