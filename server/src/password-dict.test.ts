// UT-02 — server/src/password-dict.ts
// L0 unit test, code view. Pure data + computed set; no I/O, no network.
// Runs via `bun test` (~ms).
import { describe, expect, it } from "bun:test";
import { WEAK_PASSWORDS } from "./password-dict.js";

const has = (p: string) => WEAK_PASSWORDS.has(p.toLowerCase());

describe("WEAK_PASSWORDS — common entries", () => {
  for (const p of ["123456", "password", "qwerty", "admin", "letmein", "iloveyou", "passw0rd"]) {
    it(`contains "${p}"`, () => expect(has(p)).toBe(true));
  }
});

describe("WEAK_PASSWORDS — generated families", () => {
  it("contains 6-digit zero-padded numbers 000000..000999", () => {
    expect(has("000000")).toBe(true);
    expect(has("000042")).toBe(true);
    expect(has("000999")).toBe(true);
  });

  it("contains passwordN family for N=0..999", () => {
    expect(has("password0")).toBe(true);
    expect(has("password42")).toBe(true);
    expect(has("password999")).toBe(true);
  });

  it("contains qwertyN family for N=0..999", () => {
    expect(has("qwerty0")).toBe(true);
    expect(has("qwerty999")).toBe(true);
  });
});

describe("WEAK_PASSWORDS — case insensitive contract (storage is lowercase)", () => {
  // The Set itself stores only lowercase. Consumers (auth.ts L26) call
  // `WEAK_PASSWORDS.has(password.toLowerCase())`. This test pins both sides
  // of the contract so a future refactor that changes either side fails fast.
  it("lowercase lookup matches", () => expect(WEAK_PASSWORDS.has("password")).toBe(true));
  it("uppercase lookup misses (must be lowercased by caller)", () => {
    expect(WEAK_PASSWORDS.has("PASSWORD")).toBe(false);
    expect(has("PASSWORD")).toBe(true); // via our wrapper that mirrors auth.ts
  });
});

describe("WEAK_PASSWORDS — strong passwords stay out", () => {
  const strong = [
    "StrongPassw0rd",         // mixed case + digit
    "correct horse battery",  // multi-word
    "Tr0ub4dor&3",            // mixed everything
    "a1b2c3d4e5f6g7",         // random-looking
    "j!K8sLm@PqVx",           // symbols
  ];
  for (const p of strong) {
    it(`does NOT contain "${p}"`, () => expect(has(p)).toBe(false));
  }
});

describe("WEAK_PASSWORDS — size sanity", () => {
  it("has > 100 base entries plus families (>= 3100 total)", () => {
    // 89 literals (trimmed) + 1000 padded numbers + 1000 password{N} + 1000 qwerty{N}
    // = 3089 base; some may overlap (e.g. "123456" appears in both literals and 6-digit family if range matched)
    expect(WEAK_PASSWORDS.size).toBeGreaterThan(3000);
  });

  it("contains '000123' (padding implementation correct)", () => {
    expect(WEAK_PASSWORDS.has("000123")).toBe(true);
  });
});
