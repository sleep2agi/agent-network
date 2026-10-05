// #594 step 1 — health.codex_login: non-secret fingerprint + "shared with N".
//
// Hermetic: every check gets its own temp root and an injected host index, so
// nothing here reads or writes the real `~/.anet` or `~/.codex`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLoginCheckIntervalFromEnv, createCodexLoginHealth } from "./codex-login-health";
import { fingerprintRefreshToken } from "./codex-auth-fingerprint";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "codex-login-health-"));
  roots.push(r);
  return r;
}

/** Clearly fake, but shaped like the real codex layout. Distinct per `tag`. */
function authBody(tag: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `fake-id-${tag}`,
      access_token: `fake-access-${tag}`,
      refresh_token: `FAKE-REFRESH-TOKEN-${tag}-do-not-leak`,
      account_id: "acct-same-for-everyone",
    },
  });
}

function node(r: string, name: string, opts: { auth?: string; codexHome?: string } = {}) {
  const nodeDir = join(r, "ws", ".anet", "nodes", name);
  const codexHome = opts.codexHome ?? join(nodeDir, "codex-home");
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  if (opts.auth !== undefined) writeFileSync(join(codexHome, "auth.json"), opts.auth, { mode: 0o600 });
  return { nodeDir, codexHome };
}

function healthFor(r: string, n: { nodeDir: string; codexHome: string }, alias: string, said: string[] = [], clock = { t: 0 }) {
  return createCodexLoginHealth({
    nodeDir: n.nodeDir, alias, codexHome: n.codexHome,
    indexDir: join(r, "index"), say: (m) => said.push(m),
    minIntervalMs: 60_000, now: () => clock.t,
  });
}

describe("#594 codex_login health", () => {
  test("two nodes holding a copy of one auth.json: same fingerprint, both report shared_with=1", () => {
    const r = root();
    const body = authBody("shared");
    const a = node(r, "alpha", { auth: body });
    const b = node(r, "beta", { auth: body });
    const clock = { t: 0 };
    const ha = healthFor(r, a, "alpha", [], clock);
    const hb = healthFor(r, b, "beta", [], clock);

    // alpha starts first: nobody else has published yet.
    expect(ha.refresh()?.shared_with).toBe(0);
    const rb = hb.refresh()!;
    expect(rb.shared_with).toBe(1);
    expect(rb.shared_home_with).toBe(0);

    // 🔴 The node that started FIRST must learn about the second one too —
    // a start-up-only snapshot would leave it at 0 forever.
    clock.t += 60_000;
    const ra = ha.current()!;
    expect(ra.shared_with).toBe(1);
    expect(ra.fingerprint).toBe(rb.fingerprint);
    expect(ra.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(ra.fingerprint).toBe(fingerprintRefreshToken(body)!);
    expect(ra.codex_home).toBe(a.codexHome);
  });

  test("separate logins (same account, different refresh tokens): different fingerprints, shared_with=0", () => {
    const r = root();
    const a = node(r, "alpha", { auth: authBody("one") });
    const b = node(r, "beta", { auth: authBody("two") });
    const ra = healthFor(r, a, "alpha").refresh()!;
    const rb = healthFor(r, b, "beta").refresh()!;
    expect(ra.fingerprint).not.toBe(rb.fingerprint);
    expect(ra.shared_with).toBe(0);
    expect(rb.shared_with).toBe(0);
  });

  test("two nodes pointed at one CODEX_HOME directory: shared_home_with counts it (different fix)", () => {
    const r = root();
    const shared = join(r, "one-codex-home");
    const a = node(r, "alpha", { codexHome: shared, auth: authBody("dir") });
    const b = node(r, "beta", { codexHome: shared });
    healthFor(r, a, "alpha").refresh();
    const rb = healthFor(r, b, "beta").refresh()!;
    expect(rb.shared_with).toBe(1);
    expect(rb.shared_home_with).toBe(1);
  });

  test("no auth.json / unreadable / api-key login: null (field omitted), never a guess", () => {
    const r = root();
    expect(healthFor(r, node(r, "none"), "none").refresh()).toBeNull();
    expect(healthFor(r, node(r, "junk", { auth: "{not json" }), "junk").refresh()).toBeNull();
    expect(healthFor(r, node(r, "key", { auth: JSON.stringify({ OPENAI_API_KEY: "sk-fake" }) }), "key").refresh()).toBeNull();
  });

  test("🔴 no token appears in the reported field, the warnings, or any file it writes", () => {
    const r = root();
    const body = authBody("leakcheck");
    const a = node(r, "alpha", { auth: body });
    const b = node(r, "beta", { auth: body });
    const said: string[] = [];
    healthFor(r, a, "alpha", said).refresh();
    const report = healthFor(r, b, "beta", said).refresh()!;

    const secrets = ["FAKE-REFRESH-TOKEN-leakcheck-do-not-leak", "fake-access-leakcheck", "fake-id-leakcheck"];
    // Positive control: the needles really are in the fixture, so a
    // not.toContain below cannot pass vacuously.
    for (const s of secrets) expect(body).toContain(s);
    expect(said.length).toBeGreaterThan(0); // the warning did fire

    const written = [
      ...readdirSync(join(r, "index")).map((f) => readFileSync(join(r, "index", f), "utf-8")),
      readFileSync(join(a.nodeDir, ".codex-auth-fingerprint.json"), "utf-8"),
      readFileSync(join(b.nodeDir, ".codex-auth-fingerprint.json"), "utf-8"),
    ];
    const surfaces = [JSON.stringify(report), ...said, ...written];
    for (const surface of surfaces) for (const s of secrets) expect(surface).not.toContain(s);
    // Only these keys leave the process.
    expect(Object.keys(report).sort()).toEqual(["codex_home", "fingerprint", "shared_home_with", "shared_with"]);
  });

  test("rate-limited recompute; warning printed once per change of the colliding set, not every heartbeat", () => {
    const r = root();
    const body = authBody("rate");
    const a = node(r, "alpha", { auth: body });
    const b = node(r, "beta", { auth: body });
    const clock = { t: 0 };
    healthFor(r, a, "alpha", [], clock).refresh();
    const said: string[] = [];
    const hb = healthFor(r, b, "beta", said, clock);
    hb.refresh();
    const first = said.length;
    expect(first).toBeGreaterThan(0);
    clock.t += 60_000;
    hb.current();
    clock.t += 60_000;
    hb.current();
    expect(said.length).toBe(first);

    // Within the interval, current() returns the cached value without re-reading.
    writeFileSync(join(b.codexHome, "auth.json"), authBody("relogged"));
    clock.t += 1;
    expect(hb.current()!.shared_with).toBe(1);
    clock.t += 60_000;
    expect(hb.current()!.shared_with).toBe(0);
  });

  test("tick() says when the reported value changed, so the first node re-reports without waiting for a heartbeat", () => {
    const r = root();
    const body = authBody("tick");
    const a = node(r, "alpha", { auth: body });
    const ha = healthFor(r, a, "alpha");
    ha.refresh();
    expect(ha.tick()).toBe(false);
    healthFor(r, node(r, "beta", { auth: body }), "beta").refresh();
    expect(ha.tick()).toBe(true);
    expect(ha.current()!.shared_with).toBe(1);
    expect(ha.tick()).toBe(false);
  });

  test("interval env: default 60 s, test override >= 1000 only", () => {
    expect(codexLoginCheckIntervalFromEnv({})).toBe(60_000);
    expect(codexLoginCheckIntervalFromEnv({ ANET_CODEX_LOGIN_CHECK_INTERVAL_MS: "1500" })).toBe(1_500);
    expect(codexLoginCheckIntervalFromEnv({ ANET_CODEX_LOGIN_CHECK_INTERVAL_MS: "5" })).toBe(60_000);
    expect(codexLoginCheckIntervalFromEnv({ ANET_CODEX_LOGIN_CHECK_INTERVAL_MS: "x" })).toBe(60_000);
  });
});
