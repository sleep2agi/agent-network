// #720 — the `-c` overrides that wire CommHub into a node's `codex app-server`.
//
// One list, shared by the POSIX (tmux) and Windows co-presence launchers, so the two
// cannot drift. The TUI attaches to that app-server with `--remote`, and MCP tool calls
// run inside the app-server, so the TUI path is covered by the same overrides.
//
// Why `default_tools_approval_mode`: Codex asks 「Allow the commhub MCP server to run
// tool "<name>"?」 (an `mcpServer/elicitation/request`, codex_approval_kind
// mcp_tool_call_approval) the first time each MCP tool runs. It is not governed by
// approval_policy alone: measured with the co-presence default (read-only + on-request)
// both 0.133.0 and 0.159.2 prompt, and with never + read-only 0.133.0 still prompts while
// 0.159.2 silently declines the call. An unattended node never answers, the turn blocks,
// the Hub times the task out. 「Always allow」 does not survive a restart because anet
// supplies the commhub server via `-c` at launch, not in config.toml.
//
// `mcp_servers.<name>.default_tools_approval_mode = "approve"` pre-approves every tool
// of that one server. Measured (tests/test720-codex-commhub-tool-approval): accepted by
// codex 0.133.0 (values auto|prompt|approve) and 0.159.2 (auto|prompt|writes|approve);
// without it both versions prompt, with it both run the tool with no prompt.
// Scoped to `commhub` only — other MCP servers keep Codex's default behaviour.
// Not applied to the external-app-server lane (codex-external-appserver.ts): there commhub
// comes from the user's own config.toml, and a lone `-c mcp_servers.commhub.<key>` for a
// server that is not defined makes codex refuse to start ("invalid transport", measured).
// Such nodes add `default_tools_approval_mode = "approve"` under their [mcp_servers.commhub].
export const COMMHUB_TOOLS_APPROVAL_KEY = "mcp_servers.commhub.default_tools_approval_mode";
export const COMMHUB_TOOLS_APPROVAL_VALUE = "approve";
export const COMMHUB_TOKEN_ENV = "ANET_CODEX_COMMHUB_TOKEN";

/**
 * `-c` fragments (without the `-c` flags) for the commhub MCP server.
 * - `quoted`: TOML string literals, for the POSIX launcher (each fragment is shellQuoted).
 * - `bare`: unquoted values, for the Windows launcher (cmd.exe mangles `"`; codex parses a
 *   value that is not valid TOML as a plain string, so `x=approve` reads as "approve").
 */
export function codexCommhubMcpOverrides(hubBaseUrl: string, style: "quoted" | "bare"): string[] {
  const q = (v: string) => (style === "quoted" ? `"${v}"` : v);
  return [
    `mcp_servers.commhub.url=${q(`${hubBaseUrl}/mcp`)}`,
    `mcp_servers.commhub.bearer_token_env_var=${q(COMMHUB_TOKEN_ENV)}`,
    `${COMMHUB_TOOLS_APPROVAL_KEY}=${q(COMMHUB_TOOLS_APPROVAL_VALUE)}`,
  ];
}

/**
 * The complete argv of the Windows co-presence `codex app-server` (the launcher passes
 * exactly this to windowsManagedProcess). Pure, so it is testable on Linux CI where the
 * win32 launcher itself cannot run (#720 review: assert the launcher's real argv).
 */
export function codexWindowsAppServerArgs(o: {
  approvalPolicy: string; sandboxMode: string; model: string; hub: string; wsUrl: string;
}): string[] {
  return [
    "app-server",
    "-c", `approval_policy=${o.approvalPolicy}`,
    "-c", `sandbox_mode=${o.sandboxMode}`,
    "-c", `model=${o.model}`,
    // url + bearer + pre-approved commhub tools (bare TOML: cmd.exe mangles `"`).
    ...codexCommhubMcpOverrides(o.hub, "bare").flatMap((x) => ["-c", x]),
    "--listen", o.wsUrl,
  ];
}
