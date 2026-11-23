import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsCodexCopresenceNode, windowsStartRefusal } from "./windows-runtime";

const off = {} as NodeJS.ProcessEnv;
const start = (profile: Record<string, unknown>, flags: Partial<{ copresence: boolean; tmux: boolean; dev: boolean }> = {}, env = off) =>
  windowsStartRefusal({ profile, copresenceFlag: !!flags.copresence, tmuxFlag: !!flags.tmux, devChannelsFlag: !!flags.dev, env });

// The profile the interactive picker writes for 「Codex 共存 TUI」 (tests/test751-codex-copresence-windows).
const pickerCodex = { runtime: "codex-app-server", codexCopresence: true };
const sharedOpencode = { runtime: "opencode-cli", opencodeGeneration: "v2", opencodeSharedServerUrl: "http://127.0.0.1:14096", opencodeSharedServerPasswordFile: "C:\\p" };

test("a Codex co-presence node created by the picker starts on native Windows", () => {
  expect(start(pickerCodex)).toBeNull();
  expect(start({ runtime: "codex-app-server" }, { copresence: true })).toBeNull();
  expect(windowsCodexCopresenceNode(pickerCodex)).toBe(true);
});

test("what already started on native Windows still does", () => {
  expect(start({ runtime: "claude-agent-sdk" })).toBeNull();
  expect(start({})).toBeNull();
  expect(start(sharedOpencode)).toBeNull();
  expect(start(sharedOpencode, { copresence: true })).toBeNull();
  expect(start({ runtime: "antigravity-acp" }, {}, { ANET_ALLOW_ACP_WINDOWS: "1" } as NodeJS.ProcessEnv)).toBeNull();
});

test("the shapes that need tmux or a terminal stay refused, each with its own reason", () => {
  expect(start(pickerCodex, { tmux: true })).toContain("--tmux");
  expect(start(pickerCodex, { dev: true })).toContain("--accept-dev-channels");
  expect(start({ runtime: "grok-build-cli", grokCopresence: true })).toContain("Grok co-presence");
  expect(start({ runtime: "claude-agent-sdk" }, { copresence: true })).toContain("claude-agent-sdk");
  expect(start({ runtime: "claude-agent-sdk", codexCopresence: true })).toContain("Co-presence on native Windows");
  // Codex without co-presence (plain app-server bridge) was never validated on Windows.
  expect(start({ runtime: "codex-app-server" })).toContain("codex-app-server");
  for (const runtime of ["claude-code-cli", "codex-sdk", "grok-build-acp", "opencode-cli"]) {
    expect(start({ runtime })).toContain(`Runtime ${runtime} cannot be started on native Windows yet`);
  }
  expect(start({ runtime: "opencode-cli", opencodeGeneration: "v2" })).not.toBeNull();
});

test("an ACP runtime that is off by default is told how to turn it on", () => {
  expect(start({ runtime: "antigravity-acp" })).toContain("ANET_ALLOW_ACP_WINDOWS=1");
});

test("every refusal says what to do next", () => {
  const refusals = [start(pickerCodex, { tmux: true }), start({ runtime: "codex-sdk" }), start({ runtime: "grok-build-cli", grokCopresence: true }),
    start({ runtime: "claude-agent-sdk" }, { copresence: true }), start({ runtime: "antigravity-acp" })];
  for (const text of refusals) expect(text).toMatch(/Start (it|the node) without|run (it|this node) under WSL|Create one of those|ANET_ALLOW_ACP_WINDOWS=1/i);
});

test("`anet node start` asks this function and nothing else on Windows", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
  expect(cli).toContain("const refusal = windowsStartRefusal({");
  expect(cli).not.toContain("co-presence runtimes are unavailable");
});
