import { describe, expect, test } from "bun:test";
import { codexCopresenceEnvFileText, codexCopresenceStageEnv } from "./codex-copresence-env";

describe("Codex co-presence config environment", () => {
  test("carries config values while launcher identity wins", () => {
    expect(codexCopresenceStageEnv({
      DEEPSEEK_KEY: "fake-provider-value",
      CODEX_HOME: "/wrong",
      ANET_NODE_MARKER: "wrong",
    }, {
      CODEX_HOME: "/node/codex-home",
      ANET_NODE_MARKER: "marker",
    })).toEqual({
      DEEPSEEK_KEY: "fake-provider-value",
      CODEX_HOME: "/node/codex-home",
      ANET_NODE_MARKER: "marker",
    });
  });

  test("renders values without placing them in tmux arguments", () => {
    const text = codexCopresenceEnvFileText({ FAKE_KEY: "space ' quote" });
    expect(text).toBe(`export FAKE_KEY='space '"'"' quote'\n`);
  });

  test("rejects keys which could become shell syntax", () => {
    expect(() => codexCopresenceStageEnv({ "BAD;echo": "x" }, {})).toThrow("invalid config.env key");
  });
});
