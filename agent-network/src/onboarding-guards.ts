import type { RuntimeName } from "./normalize-runtime";

export interface LaunchCommand {
  command: "agent-node" | "npx";
  args: string[];
}

export interface ProviderCredentialContext {
  launchIntent: "node-create" | "node-start";
  profileRole?: string;
}

export function bunHubPrerequisiteIssue(hasBunx: boolean): string | null {
  return hasBunx
    ? null
    : "anet hub start requires Bun >= 1.2.0 and its bunx executable";
}

/** Resolve the real command used by `anet node start`. */
export function resolveAgentNodeLaunch(hasGlobalAgentNode: boolean, agentArgs: string[]): LaunchCommand {
  if (hasGlobalAgentNode) return { command: "agent-node", args: [...agentArgs] };
  // `preview` is intentionally a moving npm dist-tag, not a version pin.
  // Evidence/release notes must record the exact version resolved at the time
  // of a smoke run rather than describing this channel selector as pinned.
  return {
    command: "npx",
    args: ["-y", "@sleep2agi/agent-node@preview", ...agentArgs],
  };
}

/**
 * Only the SDK vendor path requires an Anthropic-compatible provider key.
 * CLI-auth runtimes and opencode's separately configured free-model path are
 * deliberately outside this guard.
 */
export function providerCredentialIssue(
  runtime: RuntimeName,
  env: Record<string, string | undefined>,
  context: ProviderCredentialContext,
): string | null {
  if (runtime !== "claude-agent-sdk") return null;
  // A host supervisor uses agent-node only as the authenticated SSE doorbell
  // daemon; it does not run an inference turn. Keep this exemption narrow:
  // ordinary SDK nodes (including role-less/member profiles) still require a
  // provider credential, and create-time profiles cannot claim this bypass.
  if (context.launchIntent === "node-start" && context.profileRole === "host_supervisor") {
    return null;
  }
  const hasCredential = [env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  return hasCredential
    ? null
    : "claude-agent-sdk needs a non-empty provider credential (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)";
}
