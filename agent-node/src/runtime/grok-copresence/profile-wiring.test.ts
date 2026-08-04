import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const cliSource = readFileSync(join(import.meta.dir, "../../cli.ts"), "utf8");
const runtimeSource = readFileSync(join(import.meta.dir, "runtime.ts"), "utf8");
const selectionSource = readFileSync(join(import.meta.dir, "profile-selection.ts"), "utf8");

describe("Grok co-presence profile wiring", () => {
  test("pins validated config before dynamically loading the runtime", () => {
    const pin = cliSource.indexOf("process.env[GROK_COPRESENCE_PROFILE_ENV] = GROK_COPRESENCE_CAPABILITY_PROFILE");
    const runtimeImport = cliSource.indexOf('await import("./runtime/grok-copresence/runtime")');
    expect(pin).toBeGreaterThan(0);
    expect(runtimeImport).toBeGreaterThan(pin);
    expect(cliSource).toContain("selectGrokCopresenceCapabilityProfile(toolsRaw");
  });

  test("cannot mutate the capability according to a logical turn owner", () => {
    expect(selectionSource).not.toContain("turnOwner");
    const argsStart = runtimeSource.indexOf("export function buildGrokCopresenceArgs(");
    const argsEnd = runtimeSource.indexOf("\nexport function assertGrokCopresenceFeatures", argsStart);
    const argsBody = runtimeSource.slice(argsStart, argsEnd);
    expect(argsBody).toContain("GROK_COPRESENCE_WEB_SEARCH_ENABLED");
    expect(argsBody).not.toContain("turnOwner");
    expect(argsBody).not.toContain("waitingHuman");
  });
});
