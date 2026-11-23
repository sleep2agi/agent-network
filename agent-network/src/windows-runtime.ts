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

/**
 * Native Windows has had its own Codex co-presence path since 2026-08 (`startWindowsCodexCopresence`:
 * app-server + bridge as managed processes, no tmux), and the interactive picker offers it there.
 * The SDK-only start gate added on 2026-11-17 refused it together with the tmux shapes, so a node
 * the picker had just created could not be started. This names the one Codex shape that is let
 * through; `--tmux`, dev channels and grok co-presence stay refused.
 */
export function windowsCodexCopresenceNode(
  profile: { runtime?: unknown; codexCopresence?: unknown } | null | undefined,
  copresenceFlag = false,
): boolean {
  return !!profile && profile.runtime === "codex-app-server" && (profile.codexCopresence === true || copresenceFlag);
}

/**
 * Why `anet node start` refuses this node on native Windows, or null when it may start.
 * One sentence the user can act on: what is wrong and what to do instead.
 */
export function windowsStartRefusal(input: {
  profile: { runtime?: unknown; opencodeGeneration?: unknown; opencodeSharedServerUrl?: unknown;
    opencodeSharedServerPasswordFile?: unknown; codexCopresence?: unknown; grokCopresence?: unknown };
  copresenceFlag: boolean; tmuxFlag: boolean; devChannelsFlag: boolean;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const { profile, copresenceFlag, tmuxFlag, devChannelsFlag } = input;
  const runtime = typeof profile.runtime === "string" && profile.runtime ? profile.runtime : "claude-agent-sdk";
  if (tmuxFlag) return "--tmux is not available on native Windows (there is no tmux). Start the node without --tmux.";
  if (devChannelsFlag) return "--accept-dev-channels needs a terminal session that native Windows does not have. Start the node without it.";
  if (profile.grokCopresence === true) return "Grok co-presence needs tmux, which native Windows does not have. Run this node under WSL, or create a claude-agent-sdk node here.";
  if (windowsCodexCopresenceNode(profile, copresenceFlag) || windowsOpencodeSharedNode(profile)) return null;
  if (copresenceFlag || profile.codexCopresence === true) {
    return `Co-presence on native Windows is available for Codex (runtime codex-app-server) and for OpenCode V2 on a shared Server; this node's runtime is ${runtime}. Start it without --copresence, or run it under WSL.`;
  }
  if (windowsRuntimeSupported(runtime, "win32", input.env ?? process.env)) return null;
  return `Runtime ${runtime} cannot be started on native Windows yet. Available here: claude-agent-sdk, Codex co-presence (codex-app-server), OpenCode V2 on a shared Server`
    + (WINDOWS_ACP_OPT_IN_RUNTIMES.includes(runtime) ? `; ${runtime} can be tried by setting ANET_ALLOW_ACP_WINDOWS=1.` : ". Create one of those, or run this node under WSL.");
}
