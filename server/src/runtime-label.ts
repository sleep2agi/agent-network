/** Preserve exact agent-node runtimes before applying legacy family aliases. */
export function normalizeSessionRuntime(agent: unknown): string | null {
  if (typeof agent !== "string" || agent.length === 0) return null;
  if (agent === "claude-code") return "claude-code-cli";
  const reported = agent.startsWith("agent-node:") ? agent.slice("agent-node:".length) : "";
  if (reported === "codex-app-server") return "codex-app-server";
  if (reported === "grok-build-cli") return "grok-build-cli";
  if (reported === "opencode" || reported === "opencode-cli") return "opencode-cli";
  if (reported === "codex" || reported === "codex-sdk") return "codex-sdk";
  if (reported === "claude" || reported === "claude-agent-sdk") return "claude-agent-sdk";
  if (reported === "grok" || reported === "grok-build-acp") return "grok-build-acp";
  if (agent === "http-api" || agent === "http" || agent === "api") return "http-api";
  return null;
}
