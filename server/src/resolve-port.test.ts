import { expect, test } from "bun:test";
import { DEFAULT_PORT, resolvePort } from "./resolve-port";

// The whole reason this module exists.
test("PORT=0 means an ephemeral port, not the production default", () => {
  expect(resolvePort("0")).toBe(0);
  expect(resolvePort("0")).not.toBe(DEFAULT_PORT);
});

test("unset or empty falls back to the default", () => {
  expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
  expect(resolvePort("")).toBe(DEFAULT_PORT);
  expect(resolvePort("   ")).toBe(DEFAULT_PORT);
});

test("surrounding whitespace is tolerated — it is trimmed, not treated as malformed", () => {
  expect(resolvePort(" 9201 ")).toBe(9201);
  expect(resolvePort("\t0\n")).toBe(0);
});

test("an explicit port is used verbatim", () => {
  expect(resolvePort("9201")).toBe(9201);
  expect(resolvePort("1")).toBe(1);
  expect(resolvePort("65535")).toBe(65535);
});

// Defaulting on a malformed value means a typo silently starts the server on
// the production port — on this fleet, on top of the running Hub.
test("a malformed value is rejected, never quietly defaulted", () => {
  for (const bad of ["abc", "80a", "-1", "65536", "1.5", "0x10", "NaN", "Infinity", "9 200", "+80"]) {
    expect(() => resolvePort(bad)).toThrow();
  }
});

test("the rejection names the value and the accepted range", () => {
  try {
    resolvePort("abc");
    throw new Error("should have thrown");
  } catch (e: any) {
    expect(e.message).toContain("abc");
    expect(e.message).toContain("0 and 65535");
    expect(e.message).toContain("ephemeral");
  }
});

test("a caller can override the fallback without touching the default", () => {
  expect(resolvePort(undefined, 3000)).toBe(3000);
  expect(resolvePort("0", 3000)).toBe(0);
});

test("server.ts resolves PORT through this module, not through `|| DEFAULT`", () => {
  const src = require("fs").readFileSync(require("path").join(import.meta.dir, "server.ts"), "utf8");
  const code = src.split("\n").filter((l: string) => !l.trim().startsWith("//")).join("\n");
  expect(code).toContain("resolvePort(process.env.PORT)");
  // `Number(env) || default` is the exact shape that swallowed the 0.
  expect(code).not.toMatch(/Number\(process\.env\.PORT\)\s*\|\|/);
});
