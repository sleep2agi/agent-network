import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OPENCODE_KEYLESS_FREE_MODEL_NOTE,
  isOpencodeZenFreeModel,
  opencodeFreeTierSafePresetWarning,
  opencodeUnsafeToolsCommand,
} from "./opencode-free-tier";

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

describe("#540 OpenCode Zen free tier vs the default safe preset", () => {
  test("recognises Zen free models only", () => {
    expect(isOpencodeZenFreeModel("opencode/nemotron-3-ultra-free")).toBe(true);
    expect(isOpencodeZenFreeModel(" opencode/mimo-v2.6-flash-free ")).toBe(true);
    expect(isOpencodeZenFreeModel("opencode/claude-sonnet-4")).toBe(false);
    expect(isOpencodeZenFreeModel("anthropic/claude-free")).toBe(false);
    expect(isOpencodeZenFreeModel(undefined)).toBe(false);
  });

  test("warns for free model + safe preset, with both exact remedies", () => {
    const lines = opencodeFreeTierSafePresetWarning({
      nodeId: "oc-free",
      model: "opencode/nemotron-3-ultra-free",
      unsafeTools: false,
      configFile: "/w/.anet/nodes/oc-free/config.json",
    }).join("\n");
    expect(lines).toContain("free tier can only be used from within OpenCode");
    expect(lines).toContain("flags.opencodeUnsafeTools=true");
    expect(lines).toContain(opencodeUnsafeToolsCommand("/w/.anet/nodes/oc-free/config.json"));
    expect(lines).toContain("anet opencode auth-login 'oc-free' --provider anthropic");
    expect(lines).toContain("anet node edit 'oc-free' --model anthropic/<model>");
  });

  test("silent when tools are already unsafe or the model is keyed", () => {
    const base = { nodeId: "n", configFile: "/c.json" };
    expect(opencodeFreeTierSafePresetWarning({ ...base, model: "opencode/x-free", unsafeTools: true })).toEqual([]);
    expect(opencodeFreeTierSafePresetWarning({ ...base, model: "anthropic/claude-sonnet-4", unsafeTools: false })).toEqual([]);
  });

  test("the printed command really sets flags.opencodeUnsafeTools and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc540-"));
    try {
      const file = join(dir, "it's config.json");
      writeFileSync(file, JSON.stringify({ runtime: "opencode-cli", flags: { timeout: 5 } }), { mode: 0o600 });
      const run = spawnSync("bash", ["-c", opencodeUnsafeToolsCommand(file)], { encoding: "utf8" });
      expect(run.status).toBe(0);
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect(after).toEqual({ runtime: "opencode-cli", flags: { timeout: 5, opencodeUnsafeTools: true } });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("anet node create no longer promises free models just work, and prints the warning", () => {
    // Witness: the old line is what users saw before the fix.
    expect(CLI).not.toContain("Keyless/free models can still start without a credential.");
    expect(OPENCODE_KEYLESS_FREE_MODEL_NOTE).toContain("flags.opencodeUnsafeTools=true");
    expect(CLI).toContain("OPENCODE_KEYLESS_FREE_MODEL_NOTE,");
    const start = CLI.indexOf("function printOpencodeCreationSecurityDisclosure(");
    expect(start).toBeGreaterThan(0);
    expect(CLI.slice(start, start + 600)).toContain("opencodeFreeTierSafePresetWarning(");
    expect(CLI.match(/printOpencodeCreationSecurityDisclosure\(id, profile\)/g)?.length).toBe(2);
  });
});
