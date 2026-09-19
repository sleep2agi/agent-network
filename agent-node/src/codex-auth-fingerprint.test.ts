import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  CODEX_AUTH_FINGERPRINT_FILE,
  accessTokenExpiry,
  checkCodexCredentialSharing,
  sharedCredentialWarningLines,
} from "./codex-auth-fingerprint";

// 🔴 这个文件测的是**不经 anet CLI** 的那条路:自定义脚本直起 agent-node。
// 那正是 #1918 第一版覆盖不到的那一格 —— 某 35 台机群里 31 台如此启动,
// 而共用同一个 codex 账号的节点全在这 31 台里。只测 CLI 那条路等于
// 只证明「我惯用的入口能用」。

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf-8").toString("base64url");
  return `h.${payload}.sig`;
}

/** 造一个节点目录 + 它自己的 CODEX_HOME,返回两者路径。 */
function makeNode(root: string, dirName: string, refreshToken: string, expSeconds?: number) {
  const nodeDir = join(root, dirName);
  const codexHome = join(nodeDir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const auth: Record<string, unknown> = { auth_mode: "chatgpt", tokens: { refresh_token: refreshToken } };
  if (expSeconds !== undefined) {
    (auth.tokens as Record<string, unknown>).access_token = jwt(expSeconds);
  }
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return { nodeDir, codexHome };
}

describe("#1918 the no-CLI path — agent-node alone publishes and compares", () => {
  test("🔴 a node started WITHOUT the CLI writes its fingerprint record, mode 600", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-nocli-"));
    const a = makeNode(root, "n_alpha", "rt-shared-1");

    const said: string[] = [];
    const colliding = checkCodexCredentialSharing({
      nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: (m) => said.push(m),
    });

    const recordPath = join(a.nodeDir, CODEX_AUTH_FINGERPRINT_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf-8"));
    expect(record.alias).toBe("alpha");
    expect(record.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    // Alone on the root, nothing to collide with — and silence is the assertion.
    expect(colliding).toEqual([]);
    expect(said).toEqual([]);
  });

  test("🔴 the record never contains the token itself", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-secret-"));
    const token = "rt-do-not-leak-me-9f2b";
    const a = makeNode(root, "n_alpha", token);
    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });
    const raw = readFileSync(join(a.nodeDir, CODEX_AUTH_FINGERPRINT_FILE), "utf-8");
    expect(raw).not.toContain(token);
  });

  test("🔴 two no-CLI nodes on one credential: the second names the first", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-pair-"));
    const a = makeNode(root, "n_alpha", "rt-shared-1");
    const b = makeNode(root, "n_beta", "rt-shared-1");

    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });
    const said: string[] = [];
    const colliding = checkCodexCredentialSharing({
      nodeDir: b.nodeDir, alias: "beta", codexHome: b.codexHome, say: (m) => said.push(m),
    });

    expect(colliding.map((c) => c.alias)).toEqual(["alpha"]);
    expect(said.join("\n")).toContain("beta shares its codex login with: alpha");
  });

  test("🔴 the quiet side: different credentials produce no output at all", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-distinct-"));
    const a = makeNode(root, "n_alpha", "rt-one");
    const b = makeNode(root, "n_beta", "rt-two");

    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });
    const said: string[] = [];
    const colliding = checkCodexCredentialSharing({
      nodeDir: b.nodeDir, alias: "beta", codexHome: b.codexHome, say: (m) => said.push(m),
    });
    expect(colliding).toEqual([]);
    expect(said).toEqual([]);
  });

  test("recomputes rather than trusting its own stale record", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-rotate-"));
    const a = makeNode(root, "n_alpha", "rt-before");
    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });
    const before = JSON.parse(readFileSync(join(a.nodeDir, CODEX_AUTH_FINGERPRINT_FILE), "utf-8")).fingerprint;

    // codex refreshed in place — the chain identity changed under us.
    writeFileSync(join(a.codexHome, "auth.json"), JSON.stringify({ tokens: { refresh_token: "rt-after" } }));
    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });
    const after = JSON.parse(readFileSync(join(a.nodeDir, CODEX_AUTH_FINGERPRINT_FILE), "utf-8")).fingerprint;

    expect(after).not.toBe(before);
  });

  test("a missing auth.json is silence, not a guess", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-noauth-"));
    const nodeDir = join(root, "n_alpha");
    mkdirSync(join(nodeDir, "codex-home"), { recursive: true });
    const said: string[] = [];
    const colliding = checkCodexCredentialSharing({
      nodeDir, alias: "alpha", codexHome: join(nodeDir, "codex-home"), say: (m) => said.push(m),
    });
    expect(colliding).toEqual([]);
    expect(said).toEqual([]);
  });

  test("a neighbour's credentials are never opened — only its published record", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-1918-peek-"));
    const a = makeNode(root, "n_alpha", "rt-shared-1");
    const b = makeNode(root, "n_beta", "rt-shared-1");
    checkCodexCredentialSharing({ nodeDir: a.nodeDir, alias: "alpha", codexHome: a.codexHome, say: () => {} });

    // Make alpha's auth.json unreadable; beta must still detect the collision
    // from the published fingerprint, proving it never went for the credential.
    writeFileSync(join(a.codexHome, "auth.json"), "{}", { mode: 0o000 });
    const colliding = checkCodexCredentialSharing({
      nodeDir: b.nodeDir, alias: "beta", codexHome: b.codexHome, say: () => {},
    });
    expect(colliding.map((c) => c.alias)).toEqual(["alpha"]);
  });
});

describe("#1918 B — the warning branches on whether the copy is still being refreshed", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  const self = (expiresAt: Date | null) => ({
    alias: "beta",
    fingerprint: "64cd5ec4",
    accessExpiresAt: expiresAt,
    codexHome: "/w/beta/codex-home",
  });
  const peer = { alias: "alpha", fingerprint: "64cd5ec4", codexHome: "/w/alpha/codex-home" };

  test("🔴 still-live copy ⇒ 'first to refresh' wording, and NOT 'stops together'", () => {
    const out = sharedCredentialWarningLines(
      self(new Date(now.getTime() + 9 * 86_400_000)), [peer], now,
    ).join("\n");
    expect(out).toContain("whichever node refreshes first keeps working");
    expect(out).not.toContain("stops together");
    expect(out).toContain("expires in 9d");
  });

  test("🔴 expired copy ⇒ 'stops together' wording, and NOT 'first to refresh'", () => {
    // The field case: three nodes on one byte-identical file, all expired 23.9h.
    const out = sharedCredentialWarningLines(
      self(new Date(now.getTime() - 23.9 * 3_600_000)), [peer], now,
    ).join("\n");
    expect(out).toContain("stops together");
    expect(out).toContain("expired 23h");
    expect(out).toContain("restore egress to the token endpoint");
    expect(out).not.toContain("whichever node refreshes first keeps working");
  });

  test("🔴 the two wordings are mutually exclusive — neither can print both", () => {
    const live = sharedCredentialWarningLines(self(new Date(now.getTime() + 86_400_000)), [peer], now).join("\n");
    const dead = sharedCredentialWarningLines(self(new Date(now.getTime() - 86_400_000)), [peer], now).join("\n");
    const firstToRefresh = (s: string) => s.includes("whichever node refreshes first keeps working");
    const together = (s: string) => s.includes("stops together");
    expect(firstToRefresh(live)).toBe(true);
    expect(together(live)).toBe(false);
    expect(firstToRefresh(dead)).toBe(false);
    expect(together(dead)).toBe(true);
  });

  test("unknown expiry keeps the default wording — we do not probe, and do not guess", () => {
    const out = sharedCredentialWarningLines(self(null), [peer], now).join("\n");
    expect(out).toContain("whichever node refreshes first keeps working");
    expect(out).not.toContain("stops together");
    expect(out).not.toContain("expires in");
  });

  test("nodes sharing ONE codex home are told to split the home, not to log in inside it", () => {
    const shared = { alias: "beta", fingerprint: "64cd5ec4", accessExpiresAt: null, codexHome: "/shared/.codex" };
    const out = sharedCredentialWarningLines(
      shared, [{ alias: "alpha", fingerprint: "64cd5ec4", codexHome: "/shared/.codex" }], now,
    ).join("\n");
    expect(out).toContain("share one CODEX_HOME");
    expect(out).toContain("would");
    // The per-node login advice is wrong for this shape and must not appear.
    expect(out).not.toContain("codex login --device-auth inside its CODEX_HOME");
  });

  test("the expiry that drives the branch is read from the token's own payload", () => {
    const exp = Math.floor(new Date("2026-09-28T12:32:25Z").getTime() / 1000);
    const auth = JSON.stringify({ tokens: { refresh_token: "rt", access_token: jwt(exp) } });
    expect(accessTokenExpiry(auth)?.toISOString()).toBe("2026-09-28T12:32:25.000Z");
    expect(accessTokenExpiry(JSON.stringify({ tokens: { access_token: "not-a-jwt" } }))).toBeNull();
    expect(accessTokenExpiry("{")).toBeNull();
  });

  test("the measured access-token lifetime is stated once, not re-derived per caller", () => {
    expect(ACCESS_TOKEN_LIFETIME_SECONDS).toBe(864_000);
  });
});

describe("#1918 agent-node actually calls it (source contract)", () => {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8").replace(/\r\n?/g, "\n");

  test("the startup path runs the check for codex runtimes", () => {
    expect(src).toContain("checkCodexCredentialSharing({");
    expect(src).toContain('RUNTIME === "codex" || RUNTIME === "codex-app-server"');
  });

  test("🔴 it warns and never exits — a shared login must not take the host down", () => {
    const block = src.slice(src.indexOf("checkCodexCredentialSharing({") - 900, src.indexOf("checkCodexCredentialSharing({") + 600);
    expect(block).not.toContain("process.exit");
  });
});
