// #649: a successful login with a weak password flags the account.
//
// Accounts created before #261 (2026-06-28) added `must_change_password` sit at 0 even when they
// still use the bootstrap default. Login is the one place the plaintext is in hand, so a login that
// succeeds with a password failing validatePasswordStrength (too short / in WEAK_PASSWORDS) sets the
// flag and returns `must_change_password: true`. Changing the password clears it.
//
// Every case goes through the real HTTP route (bootServer + fetch POST /api/auth/login), not the
// module function, so the response shape is the one clients see. The aggregate runner gives this
// file its own COMMHUB_DB / HOME / TMPDIR; the hub listens on port 0.
// Mutation: drop the new block in login() and the weak cases go red (flag stays 0, field absent).

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { register } from "./auth.js";
import { db, hashPassword } from "./db.js";
import { WEAK_PASSWORDS } from "./password-dict.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-weakpw-"));
let BASE = "";
let hub: any = null;
const STRONG = "Str0ng-Fixture-Passw0rd!";
// Fixture plaintexts only (not anyone's real password).
const TOO_SHORT = "abc1234";          // 7 chars: fails the length rule (same shape as an old bootstrap default)
const IN_LIST = "password1";          // ≥ 8 chars but in WEAK_PASSWORDS

async function post(path: string, body: unknown, token = "") {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const login = (username: string, password: string) => post("/api/auth/login", { username, password });
const flag = (userId: string) => db.get<any>("SELECT must_change_password AS f FROM users WHERE user_id = ?1", userId)?.f;

let seq = 0;
/** A user created the normal way (strong password), then rewound to an "old account" state:
 *  its stored hash replaced by `password` and the flag forced to 0. */
function oldAccount(password: string, opts: { legacySha256?: boolean } = {}) {
  const username = `weakpw_${Date.now()}_${seq++}`;
  const reg = register(username, STRONG, undefined, undefined, { issueTokens: false });
  expect(reg.ok).toBe(true);
  const userId = reg.user!.user_id;
  const hash = opts.legacySha256 ? createHash("sha256").update(`anet:${password}`).digest("hex") : hashPassword(password); // legacy = pre-A1 `anet:`-prefixed sha256 (auth-kdf-migration.test.ts)
  db.run("UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE user_id = ?2", [hash, userId]);
  expect(flag(userId)).toBe(0);
  return { username, userId };
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

describe("fixtures are what they claim", () => {
  test("TOO_SHORT is < 8 chars and IN_LIST is >= 8 chars and in WEAK_PASSWORDS; STRONG is neither", () => {
    expect(TOO_SHORT.length).toBeLessThan(8);
    expect(IN_LIST.length).toBeGreaterThanOrEqual(8);
    expect(WEAK_PASSWORDS.has(IN_LIST)).toBe(true);
    expect(STRONG.length).toBeGreaterThanOrEqual(8);
    expect(WEAK_PASSWORDS.has(STRONG.toLowerCase())).toBe(false);
  });
});

describe("successful login with a weak password sets must_change_password", () => {
  test("too-short password, flag forced to 0 → login → flag 1 and response says must_change_password: true", async () => {
    const u = oldAccount(TOO_SHORT);
    const r = await login(u.username, TOO_SHORT);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.must_change_password).toBe(true);
    expect(flag(u.userId)).toBe(1);
  });

  test("password in WEAK_PASSWORDS (length OK) → flagged", async () => {
    const u = oldAccount(IN_LIST);
    const r = await login(u.username, IN_LIST);
    expect(r.status).toBe(200);
    expect(r.body.must_change_password).toBe(true);
    expect(flag(u.userId)).toBe(1);
  });

  test("weak-list match is case-insensitive like validatePasswordStrength", async () => {
    const upper = IN_LIST.toUpperCase();
    const u = oldAccount(upper);
    const r = await login(u.username, upper);
    expect(r.status).toBe(200);
    expect(r.body.must_change_password).toBe(true);
    expect(flag(u.userId)).toBe(1);
  });

  test("legacy sha256 hash + weak password → login succeeds, hash upgraded, flag set", async () => {
    const u = oldAccount(TOO_SHORT, { legacySha256: true });
    const r = await login(u.username, TOO_SHORT);
    expect(r.status).toBe(200);
    expect(r.body.must_change_password).toBe(true);
    expect(flag(u.userId)).toBe(1);
    const stored = db.get<any>("SELECT password_hash FROM users WHERE user_id = ?1", u.userId).password_hash;
    expect(stored.startsWith("scrypt$")).toBe(true);
  });
});

describe("no flag where it does not belong", () => {
  test("strong password → flag stays 0 and the field is absent", async () => {
    const u = oldAccount(STRONG);
    const r = await login(u.username, STRONG);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect("must_change_password" in r.body).toBe(false);
    expect(flag(u.userId)).toBe(0);
  });

  test("failed login against a weak-password account does not touch the flag", async () => {
    const u = oldAccount(TOO_SHORT);
    const r = await login(u.username, "wrong-password-xyz");
    expect(r.status).toBe(401);
    expect(r.body.must_change_password).toBeUndefined();
    expect(flag(u.userId)).toBe(0);
  });

  test("an already-flagged account with a strong password still reports the flag (#261 behaviour kept)", async () => {
    const u = oldAccount(STRONG);
    db.run("UPDATE users SET must_change_password = 1 WHERE user_id = ?1", [u.userId]);
    const r = await login(u.username, STRONG);
    expect(r.body.must_change_password).toBe(true);
    expect(flag(u.userId)).toBe(1);
  });
});

describe("changing the password clears the flag", () => {
  test("weak login flags → POST /api/auth/password to a strong one → flag 0 → next login has no field", async () => {
    const u = oldAccount(TOO_SHORT);
    const first = await login(u.username, TOO_SHORT);
    expect(first.body.must_change_password).toBe(true);
    const changed = await post("/api/auth/password", { old_password: TOO_SHORT, new_password: STRONG }, first.body.token);
    expect(changed.status).toBe(200);
    expect(changed.body.ok).toBe(true);
    expect(flag(u.userId)).toBe(0);
    const again = await login(u.username, STRONG);
    expect(again.status).toBe(200);
    expect("must_change_password" in again.body).toBe(false);
  });
});

describe("the plaintext is never logged", () => {
  test("console output during a weak-password login does not contain the password", async () => {
    const u = oldAccount(IN_LIST);
    const seen: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
      (console as any)[k] = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    }
    try {
      const r = await login(u.username, IN_LIST);
      expect(r.body.must_change_password).toBe(true);
    } finally {
      Object.assign(console, orig);
    }
    expect(seen.some(l => l.includes(IN_LIST))).toBe(false);
  });
});
