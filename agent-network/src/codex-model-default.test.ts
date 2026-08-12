import { describe, expect, test } from "bun:test";
import {
  CODEX_MODEL_CHOICES,
  DEFAULT_CODEX_MODEL,
  defaultCodexModelForRuntime,
} from "./codex-model-default";
import { SUPPORTED_RUNTIME_NAMES } from "./normalize-runtime";

const CODEX_RUNTIMES = new Set(["codex-sdk", "codex-app-server"]);
const NON_CODEX_RUNTIMES = SUPPORTED_RUNTIME_NAMES.filter((runtime) => !CODEX_RUNTIMES.has(runtime));

describe("Codex model defaults", () => {
  test("all Codex creation runtime spellings use the supported default", () => {
    for (const runtime of ["codex-sdk", "codex-app-server"]) {
      expect(defaultCodexModelForRuntime(runtime)).toBe("gpt-5.6-sol");
    }
    expect(NON_CODEX_RUNTIMES).toEqual([
      "claude-agent-sdk",
      "claude-code-cli",
      "grok-build-acp",
      "grok-build-cli",
      "opencode-cli",
    ]);
    for (const runtime of NON_CODEX_RUNTIMES) {
      expect(defaultCodexModelForRuntime(runtime)).toBeUndefined();
    }
  });

  test("shared Codex choice catalog has one supported default", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_MODEL_CHOICES.filter((choice) => choice.default === true)).toEqual([
      { id: DEFAULT_CODEX_MODEL, default: true },
    ]);
  });
});
