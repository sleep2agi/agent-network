/**
 * #557 — per-turn options for the claude-agent-sdk runtime (processWithClaude).
 *
 * Item 4: a node answers each task exactly once — the turn's final text IS the
 * reply, and when the turn ends the SDK child stops anything still running in
 * the background. A model that says "I'll report back when it finishes" makes
 * a promise this node can never keep. Two layers:
 *   - structural: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 in the child env. In
 *     CLI 2.1.289 this removes `run_in_background` from the Bash tool schema,
 *     drops the "you can use run_in_background" guidance, and refuses
 *     background agent launches / Ctrl+B backgrounding.
 *   - prompt: CLAUDE_TURN_END_NOTICE, prepended to the system prompt, for the
 *     cases the env cannot cover (e.g. `nohup … &` inside a foreground Bash).
 *
 * Item 5: on an OAuth (claude.ai) login the CLI auto-fetches the account's
 * claude.ai connectors (e.g. Claude Docs) and adds them to the tool list.
 * `strictMcpConfig` does NOT gate that fetch in headless mode; the CLI's own
 * switch is ENABLE_CLAUDEAI_MCP_SERVERS (a falsy value disables the fetch —
 * checked first in the fetch function). Default: off. A node can opt back in
 * with `flags.claudeAiConnectors: true` in its config.
 */

export const CLAUDE_TURN_END_NOTICE =
  "Your final reply ends this task, and anything still running in the background is stopped when you reply. "
  + "Finish the work first (run commands in the foreground and wait for them), and never promise a later follow-up or that you will report back.\n\n";

export function buildClaudeSystemPrompt(parts: { internToolUseBias?: string; operatorPrompt?: string }): string {
  return (parts.internToolUseBias || "") + CLAUDE_TURN_END_NOTICE + (parts.operatorPrompt || "");
}

/** True only when the node config explicitly opts in with a boolean true. */
export function claudeAiConnectorsOptIn(flags: Record<string, unknown> | undefined | null): boolean {
  return flags?.claudeAiConnectors === true;
}

export function claudeSdkChildEnv(
  baseEnv: Record<string, string | undefined>,
  opts: { keepClaudeAiConnectors: boolean },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
  // Opt-in leaves whatever the operator's environment says (CLI default = on).
  if (!opts.keepClaudeAiConnectors) env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}
