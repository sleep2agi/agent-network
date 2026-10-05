// Board #543 — anet's OpenCode V2 preview gate (create + start).
import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "./cli-args";
import {
  applyOpencodeGenerationCreateOption,
  opencodeGenerationInstallCommand,
  opencodeStartGenerationRefusal,
} from "./opencode-generation-create";

const base = () => ({ runtime: "opencode-cli", opencodeMode: "headless", flags: { timeout: 1 } as Record<string, any> });

describe("create: --opencode-generation", () => {
  test("absent → the very same profile object (V1 byte-identical)", () => {
    const profile = base();
    const out = applyOpencodeGenerationCreateOption(profile, {});
    expect(out).toEqual({ ok: true, profile });
    if (out.ok) expect(out.profile).toBe(profile);
  });

  test("v1 → same object; v1 + --opencode-unsafe-tools refused (that flag is V2-only here)", () => {
    const profile = base();
    const out = applyOpencodeGenerationCreateOption(profile, { "opencode-generation": "v1" });
    if (!out.ok) throw new Error(out.refusal);
    expect(out.profile).toBe(profile);
    expect(applyOpencodeGenerationCreateOption(profile, { "opencode-generation": "v1", "opencode-unsafe-tools": "true" }).ok).toBe(false);
    expect(applyOpencodeGenerationCreateOption(profile, { "opencode-unsafe-tools": "true" }).ok).toBe(false);
  });

  test("v2 without --opencode-unsafe-tools → refused with ONE actionable line", () => {
    const out = applyOpencodeGenerationCreateOption(base(), { "opencode-generation": "v2" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).not.toContain("\n");
    expect(out.refusal).toContain("--opencode-unsafe-tools");
    expect(out.refusal).toContain("@opencode/cli");
  });

  test("v2 + --opencode-unsafe-tools → records v2, co-presence, flags.opencodeUnsafeTools=true; keeps other flags", () => {
    const profile = base();
    const out = applyOpencodeGenerationCreateOption(profile, { "opencode-generation": "v2", "opencode-unsafe-tools": "true" });
    if (!out.ok) throw new Error(out.refusal);
    expect(out.profile).toMatchObject({ opencodeGeneration: "v2", opencodeMode: "copresence", flags: { timeout: 1, opencodeUnsafeTools: true } });
    expect(profile.flags.opencodeUnsafeTools).toBeUndefined();
  });

  test("unknown generation refused", () => {
    expect(applyOpencodeGenerationCreateOption(base(), { "opencode-generation": "V2" }).ok).toBe(false);
    expect(applyOpencodeGenerationCreateOption(base(), { "opencode-generation": "3" }).ok).toBe(false);
  });

  test("--opencode-unsafe-tools is a boolean flag: it never swallows the next token", () => {
    const opts = parseCliOptions(["node", "create", "n", "--opencode-unsafe-tools", "--opencode-generation", "v2"]);
    expect(opts["opencode-unsafe-tools"]).toBe("true");
    expect(opts["opencode-generation"]).toBe("v2");
    const swallow = parseCliOptions(["node", "create", "--opencode-unsafe-tools", "n"]);
    expect(swallow["opencode-unsafe-tools"]).toBe("true");
  });
});

describe("start: stored profile gate", () => {
  test("V1 (absent or explicit) is never refused, whatever the flags", () => {
    expect(opencodeStartGenerationRefusal({}, { copresence: false })).toBeNull();
    expect(opencodeStartGenerationRefusal({ opencodeGeneration: "v1" }, { copresence: true })).toBeNull();
  });

  test("V2 under the safe preset is refused naming the config file", () => {
    const line = opencodeStartGenerationRefusal(
      { opencodeGeneration: "v2", opencodeMode: "copresence", flags: {} },
      { copresence: true, configFile: "/h/.anet/nodes/x/config.json" },
    );
    expect(line).toContain("flags.opencodeUnsafeTools=true in /h/.anet/nodes/x/config.json");
  });

  test("V2 headless refused; V2 co-presence + flag passes", () => {
    expect(opencodeStartGenerationRefusal({ opencodeGeneration: "v2", opencodeMode: "headless", flags: { opencodeUnsafeTools: true } }, { copresence: false }))
      .toMatch(/co-presence-only preview/);
    expect(opencodeStartGenerationRefusal({ opencodeGeneration: "v2", opencodeMode: "headless", flags: { opencodeUnsafeTools: true } }, { copresence: true })).toBeNull();
    expect(opencodeStartGenerationRefusal({ opencodeGeneration: "v2", opencodeMode: "copresence", flags: { opencodeUnsafeTools: true } }, { copresence: false })).toBeNull();
  });

  test("an unrecognised stored generation is refused, not guessed", () => {
    expect(opencodeStartGenerationRefusal({ opencodeGeneration: "v9" }, { copresence: true })).toMatch(/expected "v1" or "v2"/);
  });

  test("install commands come from the table", () => {
    expect(opencodeGenerationInstallCommand("v2")).toBe("npm install -g @opencode/cli@2.0.22");
  });
});
