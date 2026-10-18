import { describe, expect, test } from "bun:test";
import { collectOsUser, MAX_OS_USER_LENGTH, normalizeOsUser } from "./os-user";

describe("authoritative process OS user collection", () => {
  test.each([
    ["Linux", "deploy", "deploy"],
    ["macOS", "vincent", "vincent"],
    ["Windows local", "BuildAgent", "BuildAgent"],
    ["Windows domain", "DOMAIN\\runner", "DOMAIN\\runner"],
  ])("accepts %s platform username", (_platform, input, expected) => {
    expect(collectOsUser(() => ({ username: input }))).toBe(expected);
  });

  test("platform lookup failure is null and never falls back to a path or environment", () => {
    expect(collectOsUser(() => { throw new Error("unsupported"); })).toBeNull();
    expect(collectOsUser(() => ({ username: undefined }))).toBeNull();
  });

  test("rejects empty, control-character, and overlong identities", () => {
    expect(normalizeOsUser("  ")).toBeNull();
    expect(normalizeOsUser("root\nforged")).toBeNull();
    expect(normalizeOsUser(`safe\u007fname`)).toBeNull();
    expect(normalizeOsUser("x".repeat(MAX_OS_USER_LENGTH + 1))).toBeNull();
    expect(normalizeOsUser("x".repeat(MAX_OS_USER_LENGTH))).toHaveLength(MAX_OS_USER_LENGTH);
  });
});
