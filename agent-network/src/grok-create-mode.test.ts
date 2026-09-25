// Owner decision 2026-09-25: plain "grok" creates a headless ACP node; the
// shared TUI (grok-build-cli) is experimental and explicit-only. These tests
// pin the three things that decision promises:
//   1. choosing Grok without further detail → ACP
//   2. an explicit co-presence ask → grok-build-cli
//   3. an EXISTING grok-build-cli config keeps behaving as co-presence
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  GROK_COPRESENCE_EXPERIMENTAL_NOTE_EN,
  GROK_COPRESENCE_EXPERIMENTAL_NOTE_ZH,
  resolveGrokCreateRuntime,
} from "./grok-create-mode";
import { normalizeRuntime, normalizeRuntimeStrict } from "./normalize-runtime";
import { grokBuildCliCreationFields } from "./grok-copresence-profile";
import { grokCopresenceRequested } from "./grok-copresence-orchestration";

describe("new Grok node — default is headless ACP", () => {
  for (const raw of ["grok", "grok-build", "grok-build-acp"]) {
    test(`--runtime ${raw} (no --copresence) → grok-build-acp`, () => {
      const r = resolveGrokCreateRuntime(raw, undefined);
      expect(r).toEqual({ ok: true, runtime: "grok-build-acp", copresenceRequested: false });
    });
  }

  test("--copresence explicitly false does not opt in", () => {
    expect(resolveGrokCreateRuntime("grok", "false")).toEqual({ ok: true, runtime: "grok-build-acp", copresenceRequested: false });
  });

  test("the created ACP profile carries no co-presence fields", () => {
    expect(grokBuildCliCreationFields("grok-build-acp", "n-1")).toEqual({});
  });
});

describe("new Grok node — explicit co-presence opt-in", () => {
  test("--runtime grok --copresence → grok-build-cli", () => {
    expect(resolveGrokCreateRuntime("grok", "true")).toEqual({ ok: true, runtime: "grok-build-cli", copresenceRequested: true });
    expect(resolveGrokCreateRuntime("grok-build", "true")).toEqual({ ok: true, runtime: "grok-build-cli", copresenceRequested: true });
  });

  test("--runtime grok-build-cli passes through unchanged (canonical explicit name)", () => {
    for (const raw of ["grok-build-cli", "grok-cli", "grok-tui"]) {
      const r = resolveGrokCreateRuntime(raw, undefined);
      expect(r).toEqual({ ok: true, runtime: raw, copresenceRequested: false });
      expect(normalizeRuntimeStrict((r as any).runtime)).toBe("grok-build-cli");
    }
  });

  test("--runtime grok-build-acp --copresence is contradictory and refused", () => {
    const r = resolveGrokCreateRuntime("grok-build-acp", "true");
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("grok-build-cli");
  });

  test("non-Grok runtimes and an absent runtime pass through", () => {
    expect(resolveGrokCreateRuntime(undefined, "true")).toEqual({ ok: true, runtime: undefined, copresenceRequested: false });
    expect(resolveGrokCreateRuntime("opencode-cli", "true")).toEqual({ ok: true, runtime: "opencode-cli", copresenceRequested: false });
    expect(resolveGrokCreateRuntime("codex-cli", "true")).toEqual({ ok: true, runtime: "codex-cli", copresenceRequested: false });
  });
});

describe("existing grok-build-cli configs are untouched", () => {
  // Shape of a profile written by `anet node create --runtime grok-build-cli`
  // before this change (grokBuildCliCreationFields output + runtime).
  const existing = Object.freeze({
    runtime: "grok-build-cli",
    ...grokBuildCliCreationFields("grok-build-cli", "legacy-node-id"),
    grokCopresenceAuto: true,
  });

  test("still normalizes to grok-build-cli (not re-mapped to ACP)", () => {
    expect(normalizeRuntime(existing as any)).toBe("grok-build-cli");
    expect(normalizeRuntimeStrict(existing as any)).toBe("grok-build-cli");
  });

  test("still starts as co-presence with a plain `anet node start`", () => {
    expect((existing as any).grokCopresence).toBe(true);
    expect(grokCopresenceRequested(false, existing as any)).toBe(true);
  });

  test("a legacy headless grok-build-cli config stays headless", () => {
    const headless = { runtime: "grok-build-cli", grokCopresence: false };
    expect(grokCopresenceRequested(true, headless)).toBe(false);
  });

  test("the create-mode resolver is wired only into createCommand, not the start/profile paths", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    const calls = cli.split("resolveGrokCreateRuntime(").length - 1;
    // one import-site mention is an identifier list entry without "(", so every
    // "(" occurrence is a call. Exactly one call, and it sits in createCommand.
    expect(calls).toBe(1);
    const createStart = cli.indexOf("async function createCommand(");
    const createEnd = cli.indexOf("\nasync function ", createStart + 1);
    const callAt = cli.indexOf("resolveGrokCreateRuntime(");
    expect(callAt > createStart && (createEnd === -1 || callAt < createEnd)).toBe(true);
  });
});

describe("limitations note", () => {
  test("zh and en notes name all four known limitations", () => {
    for (const k of ["打字", "钉", "macOS", "不加载 .agents/skills"]) expect(GROK_COPRESENCE_EXPERIMENTAL_NOTE_ZH).toContain(k);
    for (const k of ["typing", "pinned", "macOS", ".agents/skills skills are not loaded"]) expect(GROK_COPRESENCE_EXPERIMENTAL_NOTE_EN).toContain(k);
    expect(GROK_COPRESENCE_EXPERIMENTAL_NOTE_ZH).toContain("实验性");
    expect(GROK_COPRESENCE_EXPERIMENTAL_NOTE_EN).toContain("Experimental");
  });
});
