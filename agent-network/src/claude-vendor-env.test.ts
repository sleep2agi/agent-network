import { describe, expect, test } from "bun:test";

import {
  collectClaudeVendorEnvForCreate,
  planPlainSecretEnvRewrites,
} from "./claude-vendor-env.js";

describe("collectClaudeVendorEnvForCreate", () => {
  test("captures known vendor endpoint and credential for claude-agent-sdk", () => {
    expect(collectClaudeVendorEnvForCreate({
      runtime: "claude-agent-sdk",
      explicitEnv: [],
      shellEnv: {
        ANTHROPIC_BASE_URL: "https://vendor.invalid/anthropic",
        ANTHROPIC_AUTH_TOKEN: "secret-test-token",
        UNRELATED_SECRET: "must-not-copy",
      },
    })).toEqual([
      "ANTHROPIC_BASE_URL=https://vendor.invalid/anthropic",
      "ANTHROPIC_AUTH_TOKEN=secret-test-token",
    ]);
  });

  test("explicit --env value wins without duplicate capture", () => {
    expect(collectClaudeVendorEnvForCreate({
      runtime: "claude-agent-sdk",
      explicitEnv: ["ANTHROPIC_BASE_URL=https://explicit.invalid/anthropic"],
      shellEnv: {
        ANTHROPIC_BASE_URL: "https://ambient.invalid/anthropic",
        ANTHROPIC_API_KEY: "ambient-key",
      },
    })).toEqual([
      "ANTHROPIC_BASE_URL=https://explicit.invalid/anthropic",
      "ANTHROPIC_API_KEY=ambient-key",
    ]);
  });

  test("does not capture vendor variables for another runtime", () => {
    expect(collectClaudeVendorEnvForCreate({
      runtime: "codex-sdk",
      explicitEnv: ["KEEP=explicit"],
      shellEnv: { ANTHROPIC_AUTH_TOKEN: "ambient-key" },
    })).toEqual(["KEEP=explicit"]);
  });

  test("rejects line-oriented dotenv injection", () => {
    expect(() => collectClaudeVendorEnvForCreate({
      runtime: "claude-agent-sdk",
      explicitEnv: [],
      shellEnv: { ANTHROPIC_AUTH_TOKEN: "safe\nINJECTED=value" },
    })).toThrow("contains a line break");
  });

  test("rejects line breaks in explicit --env for every runtime", () => {
    for (const [runtime, entry] of [
      ["claude-agent-sdk", "ANTHROPIC_API_KEY=safe\nINJECTED=value"],
      ["codex-sdk", "OPENAI_API_KEY=safe\rINJECTED=value"],
    ] as const) {
      expect(() => collectClaudeVendorEnvForCreate({
        runtime,
        explicitEnv: [entry],
        shellEnv: {},
      })).toThrow("--env entries cannot contain line breaks");
    }
  });
});

describe("planPlainSecretEnvRewrites", () => {
  test("plans the exact dotenv assignment without mutating the profile", () => {
    const env = {
      ANTHROPIC_API_KEY: "safe-value",
      NON_SECRET_SETTING: "kept-in-config",
    };
    expect(planPlainSecretEnvRewrites({ env, nodeId: "n_test-1" })).toEqual([{
      key: "ANTHROPIC_API_KEY",
      refName: "ANTHROPIC_API_KEY_N_TEST_1",
      value: "safe-value",
    }]);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "safe-value",
      NON_SECRET_SETTING: "kept-in-config",
    });
  });

  test("rejects a secret dotenv value with CRLF before any caller mutation", () => {
    expect(() => planPlainSecretEnvRewrites({
      env: { ANTHROPIC_API_KEY: "safe\r\nINJECTED=bad" },
      nodeId: "n_test",
    })).toThrow("ANTHROPIC_API_KEY contains a line break");
  });
});
