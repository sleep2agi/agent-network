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
