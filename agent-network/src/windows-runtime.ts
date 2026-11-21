/**
 * Native Windows runtime policy.
 *
 * RFC-044 slice 2 deliberately limited native Windows to the SDK path: the
 * terminal / tmux / co-presence runtimes need a POSIX-ish PTY multiplexer that
 * had not been validated there. That boundary is about **PTY**, not about every
 * non-SDK runtime — the allowlist shape over-blocked the ACP runtimes, which
 * speak JSON-RPC over a plain stdio child process (`acp-runner/client.ts` uses
 * `spawn` + pipes, no PTY, no tmux).
 *
 * 2026-11-22 — 闻星 brought native Windows evidence for antigravity-acp
 * (ConPTY + `ssh -tt` login works, `agy -p` headless works). That proves the
 * CLI works, not that OUR stdio path works on Windows (`.cmd` shim resolution,
 * child env policy, stop/tree-kill are still unverified there).
 *
 * So antigravity-acp is admitted **only behind an explicit opt-in**
 * (`ANET_ALLOW_ACP_WINDOWS=1`) until a Windows-native first-reply + stop smoke
 * exists. Default behaviour on win32 is unchanged (SDK only).
 */
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
  return env.ANET_ALLOW_ACP_WINDOWS === "1" && WINDOWS_ACP_OPT_IN_RUNTIMES.includes(runtime);
}
