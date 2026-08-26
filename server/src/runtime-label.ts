/** Preserve exact agent-node runtimes before applying legacy family aliases. */
export function normalizeSessionRuntime(agent: unknown): string | null {
  if (typeof agent !== "string" || agent.length === 0) return null;
  if (agent === "claude-code") return "claude-code-cli";
  const reported = agent.startsWith("agent-node:") ? agent.slice("agent-node:".length) : "";
  const exact: Record<string, string> = {
    "codex-app-server": "codex-app-server",
    "grok-build-cli": "grok-build-cli",
    opencode: "opencode-cli",
    "opencode-cli": "opencode-cli",
    codex: "codex-sdk",
    "codex-sdk": "codex-sdk",
    claude: "claude-agent-sdk",
    "claude-agent-sdk": "claude-agent-sdk",
    grok: "grok-build-acp",
    "grok-build-acp": "grok-build-acp",
  };
  if (exact[reported]) return exact[reported];
  if (agent === "http-api" || agent === "http" || agent === "api") return "http-api";
  return null;
}
