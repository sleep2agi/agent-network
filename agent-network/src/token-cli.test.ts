import { describe, expect, test } from "bun:test";
import { parseTokenCreateName } from "./token-cli";

describe("parseTokenCreateName", () => {
  test("keeps the legacy positional form", () => {
    expect(parseTokenCreateName(["legacy-name"])).toEqual({ ok: true, name: "legacy-name" });
  });

  test("accepts separated and equals --name forms", () => {
    expect(parseTokenCreateName(["--name", "flag-name"])).toEqual({ ok: true, name: "flag-name" });
    expect(parseTokenCreateName(["--name=equals-name"])).toEqual({ ok: true, name: "equals-name" });
  });

  test("fails closed for missing, empty, unknown, mixed, or extra operands", () => {
    for (const argv of [
      [],
      [""],
      ["--name"],
      ["--name="],
      ["--name", "--role"],
      ["--role", "admin"],
      ["positional", "extra"],
      ["positional", "--name", "other"],
    ]) {
      expect(parseTokenCreateName(argv).ok).toBeFalse();
    }
  });
});
