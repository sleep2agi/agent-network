// Board #542 — anet's pin check and agent-node's package gate read ONE
// supported-versions table. The two packages cannot import each other, so the
// table is a byte-identical mirror; this test is what keeps it one table.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { OPENCODE_BUILTIN_PIN, opencodeExactInstallCommand } from "./opencode-pin";
import { OPENCODE_V1_PIN, opencodeGenerationSupport } from "./opencode-versions";

const REPO = join(import.meta.dir, "..", "..");
const ANET_TABLE = join(REPO, "agent-network", "src", "opencode-versions.ts");
const NODE_TABLE = join(REPO, "agent-node", "src", "runtime", "opencode-versions.ts");
const NODE_BINARY = join(REPO, "agent-node", "src", "runtime", "opencode-acp", "binary.ts");

describe("opencode supported-versions table parity (#542)", () => {
  test("agent-network and agent-node carry byte-identical copies", () => {
    expect(readFileSync(ANET_TABLE, "utf8")).toBe(readFileSync(NODE_TABLE, "utf8"));
  });

  test("the copy imports nothing, so both packages can bundle it as-is", () => {
    expect(readFileSync(ANET_TABLE, "utf8")).not.toMatch(/^\s*import\s/m);
  });

  test("anet's built-in pin IS the table's v1 pin (no second literal)", () => {
    expect(OPENCODE_BUILTIN_PIN).toBe(OPENCODE_V1_PIN);
    expect(opencodeGenerationSupport("v1").pin).toBe(OPENCODE_BUILTIN_PIN);
    expect(opencodeExactInstallCommand()).toBe(`npm install -g ${opencodeGenerationSupport("v1").packageName}@${OPENCODE_V1_PIN}`);
    expect(readFileSync(join(import.meta.dir, "opencode-pin.ts"), "utf8"))
      .toContain("export const OPENCODE_BUILTIN_PIN = OPENCODE_V1_PIN;");
  });

  test("agent-node's pin and version gate derive from the same table", () => {
    const src = readFileSync(NODE_BINARY, "utf8");
    expect(src).toContain('from "../opencode-versions"');
    expect(src).toContain("export const OPENCODE_DEFAULT_PIN = OPENCODE_V1_PIN;");
    // No hard-coded pin literal left in the gate.
    expect(src).not.toMatch(/OPENCODE_DEFAULT_PIN\s*=\s*"/);
    expect(src).not.toContain("expectedVersion !== OPENCODE_DEFAULT_PIN");
    // #541 transition list is the table's v1 row minus the pin, not a literal.
    expect(src).not.toMatch(/OPENCODE_TRANSITION_VERSIONS[^=]*=\s*Object\.freeze\(\[/);
    expect(src).toContain('return isAcceptedOpencodeVersionFor("v1", version);');
  });

  test("anet's transition list comes from the same row (#541 folded onto the table)", async () => {
    const { OPENCODE_TRANSITION_VERSIONS, acceptedOpencodeVersions } = await import("./opencode-pin");
    const v1 = opencodeGenerationSupport("v1");
    expect(acceptedOpencodeVersions()).toEqual([...v1.acceptedVersions]);
    expect([...OPENCODE_TRANSITION_VERSIONS]).toEqual(v1.acceptedVersions.filter((v) => v !== v1.pin));
  });

  test("the pin line stays sed-readable for shell suites (test1225)", () => {
    const line = readFileSync(ANET_TABLE, "utf8").split("\n").find((l) => l.startsWith("export const OPENCODE_V1_PIN = "));
    expect(line).toBe(`export const OPENCODE_V1_PIN = "${OPENCODE_V1_PIN}";`);
  });
});
