import { describe, expect, test } from "bun:test";

import { collectClaudeVendorEnvForCreate } from "./claude-vendor-env.js";

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
});
