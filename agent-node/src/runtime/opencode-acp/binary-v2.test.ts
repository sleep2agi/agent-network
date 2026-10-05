// Board #543 — the package gate for OpenCode V2 (`@opencode/cli`, scoped).
// V1 (`opencode-ai`) behaviour is pinned by binary.test.ts; this file only
// adds the V2 identity and the cross-generation refusals.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  OPENCODE_DEFAULT_PIN,
  resolvePinnedOpencodeBinaryAttestation,
  revalidatePinnedOpencodeBinary,
} from "./binary";
import { OPENCODE_V2_PIN } from "../opencode-versions";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function trustedRoot(): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode package identity tests require Linux uid semantics");
  }
  const userRuntime = `/run/user/${process.getuid()}`;
  mkdirSync(userRuntime, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(userRuntime, ".anet-543-"));
  roots.push(root);
  return root;
}

/** npm layout: <root>/node_modules/<name>/bin/opencode.exe (scoped names nest). */
function stub(root: string, name: string, version: string, reported: string): string {
  const packageRoot = join(root, "node_modules", ...name.split("/"));
  mkdirSync(join(packageRoot, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name,
    version,
    bin: { opencode: "./bin/opencode.exe", opencode2: "./bin/opencode.exe" },
  }), { mode: 0o600 });
  const binary = join(packageRoot, "bin", "opencode.exe");
  writeFileSync(binary, `#!/usr/bin/env bun\nif (process.argv[2] === "--version") { console.log(${JSON.stringify(reported)}); process.exit(0); }\n`, { mode: 0o700 });
  return binary;
}

describe("OpenCode V2 package gate (#543)", () => {
  test("V2 admits exact @opencode/cli@pin whose --version prints 'opencode vX.Y.Z'", () => {
    const binary = stub(trustedRoot(), "@opencode/cli", OPENCODE_V2_PIN, `opencode v${OPENCODE_V2_PIN}`);
    const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary, generation: "v2" });
    expect(attestation.binary).toBe(binary);
    expect(attestation.expectedVersion).toBe(OPENCODE_V2_PIN);
    expect(attestation.generation).toBe("v2");
    expect(revalidatePinnedOpencodeBinary(attestation, {})).toBe(binary);
  });

  test("V1 attestations keep their pre-#543 shape (no generation key)", () => {
    const binary = stub(trustedRoot(), "opencode-ai", OPENCODE_DEFAULT_PIN, OPENCODE_DEFAULT_PIN);
    const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary });
    expect(Object.keys(attestation).sort()).toEqual(["binary", "binaryFile", "expectedVersion", "packageJson", "packageJsonFile"]);
  });

  test("the V1 gate (default) refuses a V2 package — a V1 node never runs @opencode/cli", () => {
    const binary = stub(trustedRoot(), "@opencode/cli", OPENCODE_V2_PIN, `opencode v${OPENCODE_V2_PIN}`);
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary }))
      .toThrow(/not inside a node_modules\/opencode-ai wrapper/);
  });

  test("the V2 gate refuses opencode-ai, another 2.x, and a V1 version", () => {
    const v1 = stub(trustedRoot(), "opencode-ai", OPENCODE_DEFAULT_PIN, OPENCODE_DEFAULT_PIN);
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: v1, generation: "v2" }))
      .toThrow(/not inside a node_modules\/@opencode\/cli wrapper/);
    const drift = stub(trustedRoot(), "@opencode/cli", "2.0.21", "opencode v2.0.21");
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: drift, generation: "v2" }))
      .toThrow(/not @opencode\/cli@2\.0\.22/);
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: drift, generation: "v2", expectedVersion: "2.0.21" }))
      .toThrow(/unsupported opencode v2 version 2\.0\.21/);
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: drift, generation: "v2", expectedVersion: OPENCODE_DEFAULT_PIN }))
      .toThrow(/unsupported opencode v2 version/);
  });

  test("a V2 package whose --version disagrees with its manifest is refused", () => {
    const lying = stub(trustedRoot(), "@opencode/cli", OPENCODE_V2_PIN, "opencode v2.0.99");
    expect(() => resolvePinnedOpencodeBinaryAttestation({ requestedBinary: lying, generation: "v2" }))
      .toThrow(/expected @opencode\/cli@2\.0\.22; resolved binary reports 2\.0\.99/);
  });
});
