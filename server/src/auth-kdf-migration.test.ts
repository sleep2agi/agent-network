// Round-6 A1 — salted KDF password hash + lazy migration.
//
// Pins the 5 behaviours called out in the dispatch:
//   1. old-format hash verifies + auto-rehashes to new on login
//   2. new-format hash round-trips
//   3. wrong password rejected (both old and new format paths)
//   4. after a successful login against a legacy hash, the legacy
//      hash NO LONGER EXISTS in the DB (single source of truth)
//   5. bootstrap admin (register flow) writes new format from row 1
//
// Plus regression pins:
//   - timing-safe verify path doesn't throw on adversarial input
//   - malformed new-format string is rejected (not silently accepted)
//
// All COMMHUB_SCRYPT_N=10 to keep the suite fast (~5ms/scrypt vs
// 50ms at production N=14).

import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { db, hashPassword, verifyPassword } from "./db.js";
import { register, login } from "./auth.js";

// Fast scrypt for tests — 2^10 = 1024 iter is ~5ms. Production stays at N=14.
beforeAll(() => {
  process.env.COMMHUB_SCRYPT_N = "10";
});

beforeEach(() => {
  db.run("DELETE FROM users");
  db.run("DELETE FROM api_tokens");
  db.run("DELETE FROM network_members");
  db.run("DELETE FROM networks");
  db.run("DELETE FROM audit_log");
});

// Mimic the pre-A1 unsalted SHA-256 path. Used to seed legacy rows.
function legacyHash(plain: string): string {
  return new Bun.CryptoHasher("sha256").update(`anet:${plain}`).digest("hex");
}

function getStoredHash(username: string): string | null {
  const row = db.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE username = ?1",
    username
  );
  return row?.password_hash ?? null;
}

function insertLegacyUser(username: string, plain: string): string {
  const userId = `usr_${username}`;
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role)
     VALUES (?1, ?2, ?3, 'user')`,
    [userId, username, legacyHash(plain)]
  );
  return userId;
}

describe("hashPassword — new format shape", () => {
  test("produces scrypt$N$salt$hash with non-zero salt and hash", () => {
    const stored = hashPassword("PasswordWith8+");
    const parts = stored.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("scrypt");
    const N = parseInt(parts[1], 10);
    expect(N).toBeGreaterThanOrEqual(8);
    expect(N).toBeLessThanOrEqual(20);
    expect(Buffer.from(parts[2], "base64").length).toBeGreaterThan(0);
    expect(Buffer.from(parts[3], "base64").length).toBe(64); // SCRYPT_KEYLEN
  });

  test("salt + hash differ on every call (no static derivation)", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    const c = hashPassword("same");
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe("verifyPassword — new format round-trip", () => {
  test("hashPassword + verifyPassword round-trips, needsRehash=false", () => {
    const stored = hashPassword("MyPassw0rd!");
    const v = verifyPassword("MyPassw0rd!", stored);
    expect(v.ok).toBe(true);
    expect(v.needsRehash).toBe(false);
  });

  test("wrong password rejected, needsRehash=false", () => {
    const stored = hashPassword("MyPassw0rd!");
    const v = verifyPassword("wrong", stored);
    expect(v.ok).toBe(false);
    expect(v.needsRehash).toBe(false);
  });

  test("malformed new-format strings rejected (not silently passed)", () => {
    // Each of these tries to abuse the parser. None should yield ok=true.
    const bad = [
      "scrypt$$salt$hash",                       // missing N
      "scrypt$14$$hash",                         // empty salt
      "scrypt$14$c2FsdA==$",                     // empty hash
      "scrypt$abc$c2FsdA==$aGFzaA==",            // non-numeric N
      "scrypt$14$c2FsdA==$aGFzaA==$extra",       // 5 parts
      "scrypt$14$c2FsdA==",                      // 3 parts
      "argon2$1$c2FsdA==$aGFzaA==",              // unknown scheme
      "scrypt$5$c2FsdA==$aGFzaA==",              // N below floor (8)
      "scrypt$30$c2FsdA==$aGFzaA==",             // N above ceiling (20)
    ];
    for (const s of bad) {
      const v = verifyPassword("anything", s);
      expect(v.ok).toBe(false);
    }
  });
});

describe("verifyPassword — legacy format compatibility (A1's load-bearing claim)", () => {
  test("legacy unsalted SHA-256 hash verifies", () => {
    const plain = "OldUserPassw0rd";
    const stored = legacyHash(plain);
    const v = verifyPassword(plain, stored);
    expect(v.ok).toBe(true);
    expect(v.needsRehash).toBe(true); // ← KEY: caller MUST rehash
  });

  test("legacy wrong-password rejected, needsRehash=false", () => {
    const stored = legacyHash("OldUserPassw0rd");
    const v = verifyPassword("wrong", stored);
    expect(v.ok).toBe(false);
    expect(v.needsRehash).toBe(false);
  });

  test("legacy hash with wrong length rejected (not crash)", () => {
    const v = verifyPassword("anything", "deadbeef"); // 8 hex chars, not 64
    expect(v.ok).toBe(false);
    expect(v.needsRehash).toBe(false);
  });
});

describe("login() — lazy migration on success", () => {
  test("legacy user logs in successfully AND is auto-upgraded to new format", () => {
    insertLegacyUser("legacy-alice", "AliceP@ss123");

    // Sanity: the seeded hash IS bare-hex sha256 (no $).
    const before = getStoredHash("legacy-alice")!;
    expect(before).not.toContain("$");
    expect(before).toHaveLength(64);

    const result = login("legacy-alice", "AliceP@ss123");
    expect(result.ok).toBe(true);

    // The load-bearing assertion: after login, the legacy hash is GONE.
    const after = getStoredHash("legacy-alice")!;
    expect(after).toContain("$");
    expect(after.startsWith("scrypt$")).toBe(true);
    expect(after).not.toBe(before);
  });

  test("legacy user wrong-password fails AND legacy hash is preserved", () => {
    insertLegacyUser("legacy-bob", "BobP@ss123");
    const before = getStoredHash("legacy-bob")!;

    const result = login("legacy-bob", "wrong");
    expect(result.ok).toBe(false);

    // Failed login MUST NOT rehash (would leak info about format).
    const after = getStoredHash("legacy-bob")!;
    expect(after).toBe(before);
    expect(after).not.toContain("$");
  });

  test("new-format user logs in without rehash (already current)", () => {
    // First login auto-migrates; second login should not rewrite again.
    insertLegacyUser("legacy-charlie", "CharlieP@ss");
    const r1 = login("legacy-charlie", "CharlieP@ss");
    expect(r1.ok).toBe(true);
    const afterFirst = getStoredHash("legacy-charlie")!;

    const r2 = login("legacy-charlie", "CharlieP@ss");
    expect(r2.ok).toBe(true);
    const afterSecond = getStoredHash("legacy-charlie")!;

    // Same hash on consecutive logins — no spurious rewrites.
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("register() — new users always start in new format (bootstrap admin)", () => {
  test("freshly-registered user has scrypt$ format from row 1", () => {
    const r = register("dave", "DaveBootstr@p", "dave@example.com", "Dave");
    expect(r.ok).toBe(true);

    const stored = getStoredHash("dave")!;
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  test("registered user can log in (smoke for the whole pipeline)", () => {
    register("eve", "EveP@ssword99", undefined, "Eve");
    const login_r = login("eve", "EveP@ssword99");
    expect(login_r.ok).toBe(true);
  });

  test("registered user wrong-password fails (smoke for new-format reject)", () => {
    register("frank", "FrankP@ssword99", undefined, "Frank");
    const login_r = login("frank", "wrong");
    expect(login_r.ok).toBe(false);
  });
});

describe("login — username enumeration timing-oracle close (round-6 A1 hardening)", () => {
  // Independent pre-review on #285: post-A1 the user-exists +
  // wrong-password path runs ~50ms scrypt, the user-not-found path
  // returns sub-ms — that's a web-measurable oracle for "is this
  // username registered". Fix: run a throwaway verifyPassword
  // against a module-constant dummy hash on the not-found branch
  // so wall-clock cost is comparable on both paths.
  //
  // The test asserts ORDER-OF-MAGNITUDE timing parity, not exact
  // equality — scrypt timings have natural jitter and we don't
  // want a flaky test that hammers CI on busy hosts. The check
  // is "both paths are slow" (both > some floor), proving the
  // dummy-verify codepath actually runs on the not-found branch.
  test("not-found user takes scrypt-class time (not sub-ms early-return)", () => {
    register("real-user-z", "RealUserZ123");

    // Warm the JIT + paging on both paths so the first call's
    // amortized cost doesn't skew the comparison.
    login("real-user-z", "wrong");
    login("does-not-exist-warmup", "wrong");

    // Sample multiple times and take the median so single-call
    // jitter doesn't dominate.
    const sample = (fn: () => void): number => {
      const N = 5;
      const xs: number[] = [];
      for (let i = 0; i < N; i++) {
        const start = performance.now();
        fn();
        xs.push(performance.now() - start);
      }
      xs.sort((a, b) => a - b);
      return xs[Math.floor(N / 2)];
    };

    const tExists = sample(() => { login("real-user-z", "wrong"); });
    const tMissing = sample(() => { login("nobody-here-" + Math.random(), "wrong"); });

    // The fix's load-bearing claim: BOTH paths run scrypt. At test
    // N=10 (~5ms per scrypt), an early-return path would be < 1ms.
    // Loose lower bound of 1ms catches an "early return" regression
    // without being flaky on slow CI runners.
    expect(tExists).toBeGreaterThan(1);
    expect(tMissing).toBeGreaterThan(1);

    // Ratio: both paths should be the same order of magnitude.
    // 5x is a generous bound to avoid CI flakiness from
    // co-scheduled scrypt workloads or paging. Pre-fix this would
    // be 50x+ trivially.
    const ratio = Math.max(tExists, tMissing) / Math.max(0.1, Math.min(tExists, tMissing));
    expect(ratio).toBeLessThan(5);
  });

  test("not-found user still returns the generic error string (no info leak)", () => {
    register("user-exists", "ExistsP@ss1");

    const a = login("user-exists", "wrong");
    const b = login("user-does-not-exist", "wrong");

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    // Both must return EXACTLY the same error string. If they
    // diverge, the username-enumeration oracle reopens at the
    // string-comparison layer regardless of timing.
    expect(a.error).toBe(b.error);
    expect(a.error).toBe("invalid username or password");
  });
});

describe("ordering invariant — single login transition (round-6 spec)", () => {
  // The dispatch's load-bearing post-condition: "post-upgrade 旧串
  // 不再存在 in DB". One concise pin.
  test("after first login, legacy hash is provably absent from the row", () => {
    const plain = "TransitionPw1";
    insertLegacyUser("legacy-tx", plain);
    const legacy = legacyHash(plain);

    login("legacy-tx", plain);

    const after = getStoredHash("legacy-tx")!;
    expect(after).not.toBe(legacy);          // not the same string
    expect(after.startsWith("scrypt$")).toBe(true);
    // The legacy string is exactly 64 hex chars. The new string is
    // markedly longer (scrypt$N$salt$hash). Verify length disjoint
    // so any future regression that re-stores a 64-char bare hex
    // would be caught.
    expect(after.length).toBeGreaterThan(64);
  });
});
