import { describe, expect, test } from "bun:test";
import {
  bunHubPrerequisiteIssue,
  providerCredentialIssue,
  resolveAgentNodeLaunch,
} from "./onboarding-guards";

describe("onboarding guards", () => {
  test("hub startup fails closed when bunx is unavailable", () => {
    expect(bunHubPrerequisiteIssue(false)).toContain("requires Bun");
    expect(bunHubPrerequisiteIssue(true)).toBeNull();
  });

  test("agent-node falls back to the pinned npx package when no global binary exists", () => {
    expect(resolveAgentNodeLaunch(false, ["--config", "config.json"])).toEqual({
      command: "npx",
      args: ["-y", "@sleep2agi/agent-node@preview", "--config", "config.json"],
    });
  });

  test("a global agent-node remains the preferred launch path", () => {
    expect(resolveAgentNodeLaunch(true, ["--config", "config.json"])).toEqual({
      command: "agent-node",
      args: ["--config", "config.json"],
    });
  });

  test("claude-agent-sdk rejects blank provider credentials", () => {
    expect(providerCredentialIssue("claude-agent-sdk", {})).toContain("provider credential");
    expect(providerCredentialIssue("claude-agent-sdk", { ANTHROPIC_API_KEY: "  " })).toContain("provider credential");
  });

  test("claude-agent-sdk accepts either supported provider credential", () => {
    expect(providerCredentialIssue("claude-agent-sdk", { ANTHROPIC_API_KEY: "present" })).toBeNull();
    expect(providerCredentialIssue("claude-agent-sdk", { ANTHROPIC_AUTH_TOKEN: "present" })).toBeNull();
  });

  test("CLI-auth and keyless-capable runtimes are not blocked by the provider-key guard", () => {
    for (const runtime of [
      "claude-code-cli",
      "codex-sdk",
      "codex-app-server",
      "grok-build-acp",
      "opencode-cli",
    ] as const) {
      expect(providerCredentialIssue(runtime, {})).toBeNull();
    }
  });
});
