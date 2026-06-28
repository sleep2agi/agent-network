// UT-01 — server/src/db.ts token generation + hashing pure functions
// L0 unit test, code view.
//
// Importing ./db.js triggers schema bootstrap (db.exec(CREATE TABLE ...) at
// module load). To avoid touching real state, run with:
//   COMMHUB_DB=/tmp/qa-ut-01.db bun test src/auth-tokens.test.ts
// (Dockerfile / qa.sh set this env.)
import { describe, expect, it } from "bun:test";
import {
  uuidv4,
  generateId,
  generateToken,
  generateUserToken,
  generateNetworkToken,
  hashToken,
  hashPassword,
} from "./db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

describe("uuidv4", () => {
  it("returns RFC 4122 v4 UUID", () => {
    for (let i = 0; i < 50; i++) {
      expect(uuidv4()).toMatch(UUID_RE);
    }
  });
  it("returns unique values across 1000 invocations", () => {
    const s = new Set<string>();
    for (let i = 0; i < 1000; i++) s.add(uuidv4());
    expect(s.size).toBe(1000);
  });
});

describe("generateId(prefix)", () => {
  it("returns `<prefix>_<12 hex>`", () => {
    const id = generateId("tok");
    expect(id).toMatch(/^tok_[0-9a-f]{12}$/);
  });
  it("respects arbitrary prefix", () => {
    expect(generateId("u")).toMatch(/^u_[0-9a-f]{12}$/);
    expect(generateId("net")).toMatch(/^net_[0-9a-f]{12}$/);
  });
});

describe("token generators — prefix + length contract", () => {
  // ALL THREE strip UUID dashes → 32 hex chars after prefix.
  // If you ever change crypto.randomUUID() implementation, this asserts the
  // shape stays the same — SDK regexes parse these.
  it("atok_<32hex>", () => {
    expect(generateToken()).toMatch(/^atok_[0-9a-f]{32}$/);
  });
  it("utok_<32hex>", () => {
    expect(generateUserToken()).toMatch(/^utok_[0-9a-f]{32}$/);
  });
  it("ntok_<32hex>", () => {
    expect(generateNetworkToken()).toMatch(/^ntok_[0-9a-f]{32}$/);
  });
});

describe("token generators — prefixes are distinct", () => {
  // Pin the three-way discrimination that resolveToken / SDK clients rely on.
  it("utok / ntok / atok prefixes never collide", () => {
    const u = generateUserToken();
    const n = generateNetworkToken();
    const a = generateToken();
    expect(u.startsWith("utok_")).toBe(true);
    expect(n.startsWith("ntok_")).toBe(true);
    expect(a.startsWith("atok_")).toBe(true);
    expect(u.startsWith("ntok_")).toBe(false);
    expect(n.startsWith("utok_")).toBe(false);
  });
});

describe("token uniqueness (no collisions over 1000)", () => {
  for (const [name, gen] of [
    ["generateToken", generateToken],
    ["generateUserToken", generateUserToken],
    ["generateNetworkToken", generateNetworkToken],
  ] as const) {
    it(`${name} — 1000 invocations unique`, () => {
      const s = new Set<string>();
      for (let i = 0; i < 1000; i++) s.add(gen());
      expect(s.size).toBe(1000);
    });
  }
});

describe("hashToken — deterministic sha256", () => {
  it("returns 64-char lowercase hex", () => {
    expect(hashToken("anything")).toMatch(HEX_RE(64));
  });
  it("deterministic — same input same output", () => {
    expect(hashToken("utok_abc")).toBe(hashToken("utok_abc"));
  });
  it("similar inputs produce DIFFERENT hashes (no truncation/collision)", () => {
    expect(hashToken("utok_abc")).not.toBe(hashToken("ntok_abc"));
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
  it("known fixture — sha256('test') = 9f86...", () => {
    expect(hashToken("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});

describe("hashPassword — salted scrypt (round-6 A1)", () => {
  it("returns scrypt$N$salt$hash self-describing format", () => {
    const stored = hashPassword("StrongPassw0rd");
    expect(stored).toMatch(/^scrypt\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("NON-deterministic — same password produces different salts (the whole point)", () => {
    // The pre-A1 hashPassword was deterministic SHA-256 — rainbow-
    // table vulnerable. Salted scrypt MUST produce different output
    // for repeated calls. If this fails, the salt isn't random.
    const a = hashPassword("foo");
    const b = hashPassword("foo");
    expect(a).not.toBe(b);
  });

  it("does not collide with hashToken's surface (separate concerns)", () => {
    // Pin the separation. Pre-A1 had hashPassword("foo") === hashToken("anet:foo"),
    // which was an accidental coincidence of unsalted hashes; post-A1 the
    // password hash carries randomness and never equals a token hash.
    expect(hashPassword("foo")).not.toBe(hashToken("foo"));
    expect(hashPassword("foo")).not.toBe(hashToken("anet:foo"));
  });
});

describe("safety — full-token vs prefix-only hash", () => {
  // If somewhere we ever hashed only the prefix or only the body, resolveToken
  // would return the wrong user. Pin "hashToken takes the WHOLE string".
  it("hashToken(prefix) != hashToken(full)", () => {
    const utok = generateUserToken();
    const prefix = "utok_";
    const body = utok.slice(5);
    expect(hashToken(utok)).not.toBe(hashToken(prefix));
    expect(hashToken(utok)).not.toBe(hashToken(body));
  });
});
