import { describe, expect, test } from "bun:test";
import { normalizeSessionRuntime } from "./runtime-label";

describe("session runtime projection", () => {
  test("preserves exact co-presence and CLI runtimes", () => {
    expect(normalizeSessionRuntime("agent-node:codex-app-server")).toBe("codex-app-server");
    expect(normalizeSessionRuntime("agent-node:grok-build-cli")).toBe("grok-build-cli");
  });
  test("keeps legacy labels backward-compatible", () => {
    expect(normalizeSessionRuntime("agent-node:codex")).toBe("codex-sdk");
    expect(normalizeSessionRuntime("agent-node:claude")).toBe("claude-agent-sdk");
    expect(normalizeSessionRuntime("agent-node:grok")).toBe("grok-build-acp");
    expect(normalizeSessionRuntime("agent-node:opencode")).toBe("opencode-cli");
    expect(normalizeSessionRuntime("claude-code")).toBe("claude-code-cli");
  });
  test("does not invent unknown runtimes", () => {
    expect(normalizeSessionRuntime("agent-node:future-runtime")).toBeNull();
    expect(normalizeSessionRuntime("agent-node:codex-app-server-evil")).toBeNull();
    expect(normalizeSessionRuntime("agent-node:grok-build-cli-preview")).toBeNull();
    expect(normalizeSessionRuntime(null)).toBeNull();
  });
});
