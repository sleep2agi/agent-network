// #230 — unit tests for the explicit-delegation precheck.
//
// Coverage matrix:
//   1. Imperative delegation happy path — parsed alias is a real other
//      session → exists: true.
//   2. Descriptive-text false positive (the #230 incident) — parsed
//      alias is a garbage string that previously survived because the
//      calling node's own `task` field substring-reflected it back at
//      the JSON precheck. Now an alias-equality lookup correctly
//      reports it as missing.
//   3. Self-only match — the only row whose alias matches is the
//      calling node itself → exists: false, reason: "self_only" so
//      the caller can distinguish "you asked for yourself" from "no
//      such alias".
//   4. Typo alias → not_in_sessions.
//   5. Empty sessions array → empty_sessions.
//   6. Missing sessions field → no_sessions_field.
//   7. Empty target alias → not_in_sessions (defend against caller).
//   8. Whitespace trimming so accidental padding doesn't mask a hit.
//   9. Sessions with missing / non-string alias fields are skipped
//      defensively.
import { describe, expect, test } from "bun:test";
import { delegationTargetExists } from "./delegation-precheck";

const sess = (alias: string): { alias: string } => ({ alias });

describe("delegationTargetExists", () => {
  test("imperative happy path — real other session is found", () => {
    const result = delegationTargetExists(
      [sess("A站负责人"), sess("通信龙"), sess("self-agent")],
      "A站负责人",
      "self-agent",
    );
    expect(result).toEqual({ exists: true, source: "session" });
  });

  test("#230 — descriptive-text false positive no longer self-reflects", () => {
    // Reproduce the failure path: the calling node's `task` field
    // contains the parsed alias as a substring (because the parsed
    // alias was extracted from the task body), but no session row
    // ACTUALLY has that string as its alias. The old substring check
    // was tricked; the equality check is not.
    const garbageAlias = "Person 的 artifact 他打不开";
    const sessions = [
      // Self row — its `task` summary echoes the inbound task body
      // (with the parsed alias as a substring). The old substring
      // precheck would self-reflect via this row.
      { alias: "self-agent", task: `you previously sent ${garbageAlias} to a Person ...` },
      // Real other agents — none have an alias that exactly matches
      // the garbage string.
      sess("A站负责人"),
      sess("通信龙"),
    ];
    const result = delegationTargetExists(sessions, garbageAlias, "self-agent");
    expect(result.exists).toBe(false);
    expect(result.exists === false && result.reason).toBe("not_in_sessions");
  });

  test("self-only match — only the calling node has this alias", () => {
    // Edge case: the parsed alias happens to be exactly the caller's
    // own alias. Don't pass the precheck (would dispatch to self,
    // which is meaningless), but distinguish from "no such alias" so
    // the caller can produce a better log line.
    const result = delegationTargetExists(
      [sess("self-agent"), sess("alice"), sess("bob")],
      "self-agent",
      "self-agent",
    );
    expect(result.exists).toBe(false);
    expect(result.exists === false && result.reason).toBe("self_only");
  });

  test("typo alias — caller meant a real agent but mistyped", () => {
    const result = delegationTargetExists(
      [sess("alice"), sess("bob")],
      "alise", // typo
      "self-agent",
    );
    expect(result.exists).toBe(false);
    expect(result.exists === false && result.reason).toBe("not_in_sessions");
  });

  test("empty sessions array → empty_sessions", () => {
    const result = delegationTargetExists([], "anyone", "self-agent");
    expect(result.exists).toBe(false);
    expect(result.exists === false && result.reason).toBe("empty_sessions");
  });

  test("missing sessions field (caller did not destructure correctly) → no_sessions_field", () => {
    const r1 = delegationTargetExists(undefined, "anyone", "self-agent");
    expect(r1).toEqual({ exists: false, reason: "no_sessions_field" });
    const r2 = delegationTargetExists(null, "anyone", "self-agent");
    expect(r2).toEqual({ exists: false, reason: "no_sessions_field" });
  });

  test("empty target alias is defensively reported as not_in_sessions", () => {
    const result = delegationTargetExists([sess("alice")], "", "self-agent");
    expect(result.exists).toBe(false);
  });

  test("whitespace padding is trimmed before comparison", () => {
    const result = delegationTargetExists(
      [sess("alice")],
      "  alice  ",
      "self-agent",
    );
    expect(result).toEqual({ exists: true, source: "session" });
  });

  test("sessions with missing / non-string alias fields are skipped without throwing", () => {
    const sessions: any[] = [
      { task: "no alias here" },
      { alias: 42 },
      { alias: null },
      { alias: "alice" }, // the only real row
    ];
    const result = delegationTargetExists(sessions, "alice", "self-agent");
    expect(result).toEqual({ exists: true, source: "session" });
  });
});
