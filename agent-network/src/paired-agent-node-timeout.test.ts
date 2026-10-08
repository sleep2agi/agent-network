import { expect, test } from "bun:test";
import { pairedAgentNodeResolveTimeoutMs, pairedAgentNodeResolveError, PAIRED_AGENT_NODE_SPEC } from "./opencode-agent-node-pair";

test("cold exact-pair fetch defaults to five minutes", () => {
  expect(pairedAgentNodeResolveTimeoutMs({})).toBe(300_000);
  expect(pairedAgentNodeResolveTimeoutMs({ ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS: "" })).toBe(300_000);
});
test("operator can extend or shorten the fetch budget", () => {
  expect(pairedAgentNodeResolveTimeoutMs({ ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS: "600000" })).toBe(600_000);
  expect(pairedAgentNodeResolveTimeoutMs({ ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS: "100" })).toBe(100);
});
test("invalid budgets explain the setting", () => {
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "2147483648"]) {
    expect(() => pairedAgentNodeResolveTimeoutMs({ ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS: value })).toThrow("ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS");
  }
});
test("timeout gives an exact-version prefetch, not a floating install", () => {
  const message = pairedAgentNodeResolveError({ code: "ETIMEDOUT", stderr: "partial output" }, 100);
  expect(message).toContain("timed out after 100ms");
  expect(message).toContain("ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS");
  expect(message).toContain(`npx -y ${PAIRED_AGENT_NODE_SPEC} --print-entrypoint`);
  expect(message).not.toContain("@preview");
});
test("ordinary failures retain their cause, SIGTERM alone is not a timeout", () => {
  const message = pairedAgentNodeResolveError({ signal: "SIGTERM", stderr: "registry denied" }, 300_000);
  expect(message).toContain("registry denied");
  expect(message).not.toContain("timed out");
});
