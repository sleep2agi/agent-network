// Board #542 — the OpenCode backend seam and the supported-versions table.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { OPENCODE_V1_BACKEND, OPENCODE_V2_BACKEND, opencodeBackendFor } from "./opencode-backend";
import { OPENCODE_DEFAULT_PIN } from "./opencode-acp/binary";
import {
  OPENCODE_DEFAULT_GENERATION,
  OPENCODE_SUPPORTED_VERSIONS,
  OPENCODE_V1_PIN,
  OPENCODE_V2_PIN,
  acceptedOpencodeVersionsFor,
  isAcceptedOpencodeVersionFor,
  opencodeGenerationOfConfig,
  opencodeGenerationRefusal,
  opencodeGenerationSupport,
} from "./opencode-versions";

describe("supported-versions table", () => {
  test("one row per generation; v1 supported with its pin first; v2 preview accepts only its exact pin (#543)", () => {
    expect(OPENCODE_SUPPORTED_VERSIONS.map((row) => row.generation)).toEqual(["v1", "v2"]);
    const v1 = opencodeGenerationSupport("v1");
    expect(v1).toMatchObject({ packageName: "opencode-ai", status: "supported", pin: OPENCODE_V1_PIN });
    expect(v1.acceptedVersions[0]).toBe(OPENCODE_V1_PIN);
    const v2 = opencodeGenerationSupport("v2");
    expect(v2).toMatchObject({ packageName: "@opencode/cli", status: "preview", pin: OPENCODE_V2_PIN });
    expect(OPENCODE_V2_PIN).toBe("2.0.22");
    expect(acceptedOpencodeVersionsFor("v2")).toEqual(["2.0.22"]);
    expect(isAcceptedOpencodeVersionFor("v2", "2.0.22")).toBe(true);
    expect(isAcceptedOpencodeVersionFor("v2", "2.0.21")).toBe(false);
    expect(isAcceptedOpencodeVersionFor("v2", OPENCODE_V1_PIN)).toBe(false);
  });

  test("the table is frozen all the way down", () => {
    expect(Object.isFrozen(OPENCODE_SUPPORTED_VERSIONS)).toBe(true);
    for (const row of OPENCODE_SUPPORTED_VERSIONS) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.acceptedVersions)).toBe(true);
    }
  });

  test("agent-node's historical pin constant is the table's v1 pin", () => {
    expect(OPENCODE_DEFAULT_PIN).toBe(OPENCODE_V1_PIN);
    expect(isAcceptedOpencodeVersionFor("v1", OPENCODE_V1_PIN)).toBe(true);
    expect(isAcceptedOpencodeVersionFor("v1", "1.18.1")).toBe(true); // #541 transition window
    expect(isAcceptedOpencodeVersionFor("v1", "1.18.2")).toBe(false);
    expect(isAcceptedOpencodeVersionFor("v1", "2.0.22")).toBe(false);
  });

  test("node config generation: absent/null → v1, known value kept, unknown → undefined (caller refuses)", () => {
    expect(OPENCODE_DEFAULT_GENERATION).toBe("v1");
    expect(opencodeGenerationOfConfig({})).toBe("v1");
    expect(opencodeGenerationOfConfig(undefined)).toBe("v1");
    expect(opencodeGenerationOfConfig({ opencodeGeneration: null })).toBe("v1");
    expect(opencodeGenerationOfConfig({ opencodeGeneration: "v1" })).toBe("v1");
    expect(opencodeGenerationOfConfig({ opencodeGeneration: "v2" })).toBe("v2");
    expect(opencodeGenerationOfConfig({ opencodeGeneration: "V1" })).toBeUndefined();
    expect(opencodeGenerationOfConfig({ opencodeGeneration: 1 })).toBeUndefined();
  });
});

describe("V2 gate (#543): preview, co-presence only, unsafe-tools only", () => {
  test("V1 is never refused", () => {
    expect(opencodeGenerationRefusal("v1", { unsafeTools: false })).toBeNull();
    expect(opencodeGenerationRefusal("v1", { unsafeTools: false, mode: "headless" })).toBeNull();
  });

  test("V2 under the default safe preset is refused with ONE actionable line naming the flag", () => {
    const line = opencodeGenerationRefusal("v2", { unsafeTools: false, mode: "copresence", configFile: "/n/config.json" });
    expect(line).not.toBeNull();
    expect(line!).not.toContain("\n");
    expect(line!).toContain("flags.opencodeUnsafeTools=true");
    expect(line!).toContain("/n/config.json");
    expect(line!).toContain("ignores the node safety policy");
  });

  test("V2 headless is refused even with the flag; V2 co-presence + flag passes", () => {
    expect(opencodeGenerationRefusal("v2", { unsafeTools: true, mode: "headless" })).toMatch(/co-presence-only preview/);
    expect(opencodeGenerationRefusal("v2", { unsafeTools: true, mode: "copresence" })).toBeNull();
    expect(opencodeGenerationRefusal("v2", { unsafeTools: true })).toBeNull();
  });
});

describe("OpencodeBackend", () => {
  test("V1 backend reads its identity from the table", () => {
    expect(OPENCODE_V1_BACKEND.generation).toBe("v1");
    expect(OPENCODE_V1_BACKEND.packageName).toBe("opencode-ai");
    expect(OPENCODE_V1_BACKEND.support).toBe(opencodeGenerationSupport("v1"));
    expect(OPENCODE_V1_BACKEND.isSupportedVersion(OPENCODE_V1_PIN)).toBe(true);
    expect(OPENCODE_V1_BACKEND.isSupportedVersion("2.0.22")).toBe(false);
    expect(opencodeBackendFor("v1")).toBe(OPENCODE_V1_BACKEND);
  });

  test("V1 argv is exactly the pre-#542 acp / serve / attach shape", () => {
    expect(OPENCODE_V1_BACKEND.acpArgs()).toEqual(["acp"]);
    expect(OPENCODE_V1_BACKEND.serveArgs({ hostname: "127.0.0.1", port: 4242 }))
      .toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4242", "--pure"]);
    expect(OPENCODE_V1_BACKEND.attachArgs({ url: "http://127.0.0.1:4242", sessionId: "ses_x", cwd: "/w" }))
      .toEqual(["attach", "http://127.0.0.1:4242", "--session", "ses_x", "--dir", "/w", "--pure"]);
  });

  test("every declared V1 safety env key really is set on the safe-mode child (golden)", () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "opencode-v1-spawn-snapshot.golden.json"), "utf8"));
    const safeEnv = golden.acpSafe[0].env as Record<string, string>;
    for (const key of OPENCODE_V1_BACKEND.safetyEnvKeys) expect(Object.keys(safeEnv)).toContain(key);
    // …and no OPENCODE_* key on that child is missing from the declaration.
    const declared = new Set(OPENCODE_V1_BACKEND.safetyEnvKeys);
    expect(Object.keys(safeEnv).filter((key) => key.startsWith("OPENCODE_") && !declared.has(key))).toEqual([]);
  });

  test("V2 backend: own identity, serve without --pure, TUI joins with --server/--session (no attach)", () => {
    expect(opencodeBackendFor("v2")).toBe(OPENCODE_V2_BACKEND);
    expect(OPENCODE_V2_BACKEND).not.toBe(OPENCODE_V1_BACKEND);
    expect(OPENCODE_V2_BACKEND.generation).toBe("v2");
    expect(OPENCODE_V2_BACKEND.packageName).toBe("@opencode/cli");
    expect(OPENCODE_V2_BACKEND.isSupportedVersion("2.0.22")).toBe(true);
    expect(OPENCODE_V2_BACKEND.isSupportedVersion(OPENCODE_V1_PIN)).toBe(false);
    expect(OPENCODE_V2_BACKEND.serveArgs({ hostname: "127.0.0.1", port: 4242 }))
      .toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4242"]);
    expect(OPENCODE_V2_BACKEND.attachArgs({ url: "http://127.0.0.1:4242", sessionId: "ses_x", cwd: "/w" }))
      .toEqual(["--server", "http://127.0.0.1:4242", "--session", "ses_x"]);
    expect(() => OPENCODE_V2_BACKEND.acpArgs()).toThrow(/co-presence-only preview/);
  });

  test("V2 backend refuses to build a runtime env under the safe preset (it would ignore it)", () => {
    expect(() => OPENCODE_V2_BACKEND.buildChildEnv({ workDir: "/nonexistent-543", cwd: "/nonexistent-543", unsafeTools: false }))
      .toThrow(/flags\.opencodeUnsafeTools=true/);
    expect(() => OPENCODE_V2_BACKEND.buildChildEnv({ workDir: "/nonexistent-543", cwd: "/nonexistent-543" }))
      .toThrow(/default safe preset/);
  });

  test("V2 backend never revalidates a V1 attestation", () => {
    expect(() => OPENCODE_V2_BACKEND.revalidateBinary({
      binary: "/x/node_modules/opencode-ai/bin/opencode.exe",
      packageJson: "/x/node_modules/opencode-ai/package.json",
      expectedVersion: OPENCODE_V1_PIN,
      binaryFile: { dev: "0", ino: "0", size: 0, sha256: "" },
      packageJsonFile: { dev: "0", ino: "0", size: 0, sha256: "" },
    }, {})).toThrow(/attestation made for another generation/);
  });
});
