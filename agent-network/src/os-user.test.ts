import { describe, expect, test } from "bun:test";
import { collectOsUser } from "./os-user";

describe("legacy reporter OS user collection", () => {
  test("accepts a platform username including Windows domain form", () => {
    expect(collectOsUser(() => ({ username: "DOMAIN\\runner" }))).toBe("DOMAIN\\runner");
  });

  test("returns null on platform failure instead of consulting env or paths", () => {
    expect(collectOsUser(() => { throw new Error("unavailable"); })).toBeNull();
  });

  test("rejects control characters and overlong values", () => {
    expect(collectOsUser(() => ({ username: "root\nforged" }))).toBeNull();
    expect(collectOsUser(() => ({ username: "x".repeat(257) }))).toBeNull();
  });
});
