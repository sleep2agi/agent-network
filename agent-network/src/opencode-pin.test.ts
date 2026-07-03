// RFC-029 PR③ — pin-file override tests.
//
// The runtime path (assertStartCompatibility reads the effective
// pin) is exercised via docker; here we lock the pure IO shape
// and the "unvalidated file is refused" guarantee.

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  OPENCODE_BUILTIN_PIN,
  readEffectivePin,
  writePinOverride,
  opencodePinFilePath,
} from "./opencode-pin";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "anet-pin-"));
});

describe("opencode-pin — built-in fallback", () => {
  test("returns the built-in constant when no override file exists", () => {
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("builtin");
    expect(pin.smokePassedAt).toBeUndefined();
  });
});

describe("opencode-pin — override file write + read round-trip", () => {
  test("writePinOverride then readEffectivePin returns the new version", () => {
    writePinOverride("1.18.0", "2026-07-04T00:00:00.000Z", "smoke: initialize + session/new", fakeHome);
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe("1.18.0");
    expect(pin.source).toBe("override-file");
    expect(pin.smokePassedAt).toBe("2026-07-04T00:00:00.000Z");
  });
});

describe("opencode-pin — validation refuses malformed / unvalidated overrides", () => {
  test("hand-edited file with version but NO smokePassedAt → falls back to built-in", () => {
    const path = opencodePinFilePath(fakeHome);
    mkdirSync(join(fakeHome, ".anet"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: "9.9.9" }));
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("builtin");
  });

  test("version string doesn't match semver → falls back to built-in", () => {
    writePinOverride("nightly", "2026-07-04T00:00:00.000Z", undefined, fakeHome);
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
  });

  test("smokePassedAt not an ISO timestamp → falls back to built-in", () => {
    const path = opencodePinFilePath(fakeHome);
    mkdirSync(join(fakeHome, ".anet"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: "1.18.0", smokePassedAt: "yesterday" }));
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
  });

  test("malformed JSON → falls back to built-in without throwing", () => {
    const path = opencodePinFilePath(fakeHome);
    mkdirSync(join(fakeHome, ".anet"), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("builtin");
  });
});
