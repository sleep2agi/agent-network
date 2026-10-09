import { expect, test } from "bun:test";
import { opencodeV2CopresenceRequested } from "./opencode-start-mode";

test("V2 persisted co-presence routes ordinary start into TUI orchestration", () => {
  expect(opencodeV2CopresenceRequested({ runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence" })).toBe(true);
});
test("legacy V1/unspecified generation and headless behavior are unchanged", () => {
  for (const opencodeGeneration of [undefined, "v1", "future", true]) {
    expect(opencodeV2CopresenceRequested({ runtime: "opencode-cli", opencodeGeneration, opencodeMode: "copresence" })).toBe(false);
  }
  for (const opencodeMode of [undefined, "headless", true]) {
    expect(opencodeV2CopresenceRequested({ runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode })).toBe(false);
  }
});
test("stored OpenCode fields cannot route another runtime", () => {
  for (const runtime of [undefined, "codex-app-server", "grok-build-cli", "claude-agent-sdk"]) {
    expect(opencodeV2CopresenceRequested({ runtime, opencodeGeneration: "v2", opencodeMode: "copresence" })).toBe(false);
  }
});
