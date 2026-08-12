import { describe, expect, test } from "bun:test";
import { DEFAULT_CODEX_MODEL, resolveCodexModel } from "./codex-model-default";

describe("agent-node Codex model resolution", () => {
  test("missing model uses the verified supported default", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(resolveCodexModel(undefined)).toBe(DEFAULT_CODEX_MODEL);
  });

  test("explicit model remains authoritative", () => {
    expect(resolveCodexModel("operator-custom-model")).toBe("operator-custom-model");
  });
});
