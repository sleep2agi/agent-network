/** Keep in parity with agent-network/src/windows-runtime.ts (independent npm packages). */
export const WINDOWS_DEFAULT_RUNTIMES: readonly string[] = ["claude-agent-sdk"];

/** ACP stdio runtimes that do not need PTY/tmux; gated by ANET_ALLOW_ACP_WINDOWS=1. */
export const WINDOWS_ACP_OPT_IN_RUNTIMES: readonly string[] = ["antigravity-acp"];

export function windowsRuntimeSupported(
  runtime: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") return true;
  if (WINDOWS_DEFAULT_RUNTIMES.includes(runtime)) return true;
  return env.ANET_ALLOW_ACP_WINDOWS === "1" && (WINDOWS_ACP_OPT_IN_RUNTIMES.includes(runtime));
}

/**
 * #3812 — native Windows runs an OpenCode node in exactly one shape: OpenCode V2, as a client of
 * an OpenCode Server that is already running on the machine. A node that owns its server, and
 * OpenCode V1, launch `opencode` themselves through a POSIX-only path and stay refused.
 */
export function windowsOpencodeSharedNode(profile: {
  runtime?: unknown; opencodeGeneration?: unknown;
  opencodeSharedServerUrl?: unknown; opencodeSharedServerPasswordFile?: unknown;
} | null | undefined): boolean {
  return !!profile && profile.runtime === "opencode-cli" && profile.opencodeGeneration === "v2"
    && typeof profile.opencodeSharedServerUrl === "string" && !!profile.opencodeSharedServerUrl
    && typeof profile.opencodeSharedServerPasswordFile === "string" && !!profile.opencodeSharedServerPasswordFile;
}
