// REST from_session identity binding.
//
// Run: COMMHUB_DB=/tmp/rest-identity-test.db bun test src/rest-identity.test.ts
// (COMMHUB_DB must be set explicitly — unset defaults to the production DB.)
//
// Assertion discipline: results are compared with toEqual against the whole
// object, so a widened accepted-set fails instead of silently passing.

import { describe, expect, test } from "bun:test";
import { nodeAliasForToken, resolveRestFromSession } from "./rest-identity.js";

const NTOK = "ntok_abc123";
const UTOK = "utok_abc123";

describe("REST from_session identity binding", () => {
  test("node token claiming another node's alias is refused", () => {
    expect(resolveRestFromSession({
      token: NTOK,
      tokenName: "node:通信IM牛",
      requestedFrom: "通信龙",
    })).toEqual({
      ok: false,
      error: "from_session_identity_mismatch",
      message: "network token from_session does not match token-bound node alias",
      tokenAlias: "通信IM牛",
      requestedFromSession: "通信龙",
    });
  });

  test("node token omitting from is bound to its own alias, not 'api'", () => {
    expect(resolveRestFromSession({
      token: NTOK,
      tokenName: "node:通信IM牛",
      requestedFrom: undefined,
    })).toEqual({ ok: true, fromSession: "通信IM牛" });
  });

  test("node token claiming its own alias is accepted", () => {
    expect(resolveRestFromSession({
      token: NTOK,
      tokenName: "node:通信IM牛",
      requestedFrom: "通信IM牛",
    })).toEqual({ ok: true, fromSession: "通信IM牛" });
  });

  test("whitespace padding does not defeat the comparison", () => {
    expect(resolveRestFromSession({
      token: NTOK,
      tokenName: "node:通信IM牛",
      requestedFrom: "  通信IM牛  ",
    })).toEqual({ ok: true, fromSession: "通信IM牛" });
  });

  // The Dashboard posts as its logged-in user; this path must not change.
  test("user token keeps the previous behaviour", () => {
    expect(resolveRestFromSession({
      token: UTOK,
      tokenName: "dashboard",
      requestedFrom: "admin",
    })).toEqual({ ok: true, fromSession: "admin" });
  });

  test("user token with no from still defaults to 'api'", () => {
    expect(resolveRestFromSession({
      token: UTOK,
      tokenName: null,
      requestedFrom: undefined,
    })).toEqual({ ok: true, fromSession: "api" });
  });

  // A non-string `from` must not be coerced into an identity.
  test("non-string from is not treated as a claim", () => {
    expect(resolveRestFromSession({
      token: NTOK,
      tokenName: "node:通信IM牛",
      requestedFrom: { toString: () => "通信龙" },
    })).toEqual({ ok: true, fromSession: "通信IM牛" });
  });

  describe("nodeAliasForToken", () => {
    test("only ntok_ + node: prefix yields an alias", () => {
      expect(nodeAliasForToken(NTOK, "node:X")).toBe("X");
      // A user token whose name merely looks node-shaped must not bind.
      expect(nodeAliasForToken(UTOK, "node:X")).toBeNull();
      // A node token whose name is not node-scoped must not bind.
      expect(nodeAliasForToken(NTOK, "dashboard")).toBeNull();
      expect(nodeAliasForToken(NTOK, null)).toBeNull();
      // `node:` with nothing after it is not an identity.
      expect(nodeAliasForToken(NTOK, "node:   ")).toBeNull();
    });
  });
});
