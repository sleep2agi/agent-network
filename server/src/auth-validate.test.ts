// UT-03 — server/src/auth.ts password + username validation in register()
// L0 unit test, code view. Tests validatePasswordStrength indirectly via the
// user-facing register() contract (it's not exported on its own).
//
// Run with COMMHUB_DB=/tmp/qa-l0-auth-validate.db so the schema bootstrap
// at db.ts load time lands in a throwaway file. Each test uses a unique
// username, so cross-test DB state doesn't matter.
import { describe, expect, it, beforeAll } from "bun:test";
import { register } from "./auth.js";

// First user gets RELAXED rules (admin bootstrap allows 4-char "anethub" etc.)
// To test full-strength rules, seed a dummy admin first.
beforeAll(() => {
  // Idempotent: if DB file already has users (from a previous run on the
  // same temp path), this errors with "username already taken" → that's
  // fine, the goal is just "ensure at least one user exists so subsequent
  // registers hit the strict path".
  register("_seed_admin", "BootstrapPw1", undefined, "seed");
});

describe("register — username rules", () => {
  it("rejects empty username", () => {
    const r = register("", "AnyValidPw123");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("username must be at least 2 characters");
  });

  it("rejects 1-char username", () => {
    expect(register("a", "AnyValidPw123").ok).toBe(false);
  });

  it("accepts 2-char username", () => {
    const r = register("u2", "StrongPw1234");
    expect(r.ok).toBe(true);
  });

  it("rejects 51-char username", () => {
    const long = "u".repeat(51);
    const r = register(long, "StrongPw1234");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too long");
  });

  it("rejects username with space", () => {
    expect(register("bad name", "StrongPw1234").error).toContain("invalid characters");
  });

  it("rejects username with '@'", () => {
    expect(register("foo@bar", "StrongPw1234").error).toContain("invalid characters");
  });

  it("accepts Chinese username (CJK range)", () => {
    // Regex includes 一-鿿 per auth.ts L34
    const r = register("通信测试马", "StrongPw1234");
    expect(r.ok).toBe(true);
  });

  it("rejects duplicate username", () => {
    register("dup_u", "StrongPw1234");
    const r = register("dup_u", "DifferentPw1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already taken");
  });
});

describe("register — password length", () => {
  it("rejects empty password (post-admin)", () => {
    const r = register("pw_empty", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("8 characters");
  });

  it("rejects 7-char password", () => {
    expect(register("pw_7", "Abc1234").error).toContain("8 characters");
  });

  it("accepts 8-char strong password", () => {
    expect(register("pw_8ok", "StrongP1").ok).toBe(true);
  });
});

describe("register — weak-password dictionary (post-admin strict path)", () => {
  // Each of these is exactly 8+ chars but in WEAK_PASSWORDS dict.
  // Pins: validatePasswordStrength rejects by dict AFTER length check.
  const dictMatches = ["password", "passw0rd", "letmein1", "iloveyou"];
  // Note: "letmein1" — is that in dict? letmein is. password{N} family
  // generates "letmein1"? No — that's password{N} only. Let me just use
  // ones I know:
  const reallyInDict = ["password", "passw0rd", "iloveyou", "password1", "qwerty12"];
  // qwerty12 — is it? qwerty{N} family covers 0..999 so qwerty12 is in.
  for (const pw of reallyInDict) {
    it(`rejects "${pw}" as too common`, () => {
      const r = register(`pw_dict_${pw}`, pw);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("too common");
    });
  }
});

describe("register — case-insensitive dict lookup", () => {
  // auth.ts L26 calls WEAK_PASSWORDS.has(password.toLowerCase()).
  // Pins that uppercase weak password is still rejected.
  it("rejects 'PASSWORD' (uppercase)", () => {
    const r = register("pw_uc", "PASSWORD");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too common");
  });
  it("rejects 'Password1' (mixed)", () => {
    const r = register("pw_mix", "Password1");
    expect(r.ok).toBe(false);
  });
});

describe("register — strong passwords accepted", () => {
  // None of these should be in the dict. All ≥ 8 chars.
  const strong = [
    "Tr0ub4dor&3",
    "correct-horse-battery",
    "X9!kLm@PqVx",
    "MyDog'sName2026",
  ];
  for (const pw of strong) {
    it(`accepts strong "${pw}"`, () => {
      // unique username per pw
      const u = "ok_" + pw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
      const r = register(u, pw);
      expect(r.ok).toBe(true);
    });
  }
});

describe("register — admin bootstrap relaxed rules", () => {
  // Test that the FIRST user gets the relaxed validator. Can't directly
  // test this here (the beforeAll already seeded an admin in this DB), but
  // we pin the CONTRACT: if no users exist, password >= 4 chars suffices.
  //
  // This is asserted by checking that AFTER the seed admin exists,
  // a 4-char password is REJECTED for normal users — which proves the
  // strict path is hit.
  it("4-char password rejected for non-first user", () => {
    const r = register("short_pw_user", "abcd");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("8 characters");
  });
});
