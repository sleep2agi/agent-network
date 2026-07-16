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
  formatOpencodePackageIdentityFailure,
  opencodeExactInstallCommand,
  readEffectivePin,
  writePinOverride,
  opencodePinFilePath,
} from "./opencode-pin";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "anet-pin-"));
});

describe("opencode-pin — built-in fallback", () => {
  test("release builtin pin is the revalidated opencode-ai@1.18.1", () => {
    expect(OPENCODE_BUILTIN_PIN).toBe("1.18.1");
  });

  test("returns the built-in constant when no override file exists", () => {
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("builtin");
    expect(pin.smokePassedAt).toBeUndefined();
  });

  test("missing/untrusted package hint preserves detail and exact install command", () => {
    const detail = "opencode package identity/version check failed: no trusted package on PATH";
    const hint = formatOpencodePackageIdentityFailure(OPENCODE_BUILTIN_PIN, detail);
    expect(hint).toContain(detail);
    expect(hint).toContain("Expected trusted opencode-ai@1.18.1");
    expect(hint).toContain("npm install -g opencode-ai@1.18.1");
    expect(opencodeExactInstallCommand()).toBe("npm install -g opencode-ai@1.18.1");
  });
});

describe("opencode-pin — override file write + read round-trip", () => {
  test("a smoke marker for the exact release pin is recognized", () => {
    writePinOverride(OPENCODE_BUILTIN_PIN, "2026-07-04T00:00:00.000Z", "smoke: initialize + session/new", fakeHome);
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("override-file");
    expect(pin.smokePassedAt).toBe("2026-07-04T00:00:00.000Z");
  });

  test("a locally-smoked different version cannot override the release pin", () => {
    writePinOverride("1.18.2", "2026-07-04T00:00:00.000Z", "lightweight smoke only", fakeHome);
    const pin = readEffectivePin(fakeHome);
    expect(pin.version).toBe(OPENCODE_BUILTIN_PIN);
    expect(pin.source).toBe("builtin");
    expect(pin.smokePassedAt).toBeUndefined();
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
