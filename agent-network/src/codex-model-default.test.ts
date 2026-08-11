import { describe, expect, test } from "bun:test";
import {
  CODEX_MODEL_CHOICES,
  DEFAULT_CODEX_MODEL,
  defaultCodexModelForRuntime,
} from "./codex-model-default";

describe("Codex model defaults", () => {
  test("all Codex creation runtime spellings use the supported default", () => {
    for (const runtime of ["codex-sdk", "codex-app-server"]) {
      expect(defaultCodexModelForRuntime(runtime)).toBe("gpt-5.6-sol");
    }
    expect(defaultCodexModelForRuntime("claude-agent-sdk")).toBeUndefined();
    expect(defaultCodexModelForRuntime("grok-build-acp")).toBeUndefined();
    expect(defaultCodexModelForRuntime("opencode-cli")).toBeUndefined();
  });

  test("shared Codex choice catalog has one supported default", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_MODEL_CHOICES.filter((choice) => choice.default === true)).toEqual([
      { id: DEFAULT_CODEX_MODEL, default: true },
    ]);
  });
});
