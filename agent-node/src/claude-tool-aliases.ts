/**
 * Short CommHub names accepted by Claude Agent SDK before MCP name lookup.
 *
 * Values are the real SDK-visible names produced by an in-process MCP server
 * named `commhub` whose registered bare tools are `send_task`, etc. Keep this
 * an exact set: never advertise a tool the active server does not register
 * (notably the deliberately removed `send_reply`).
 */
export const CLAUDE_COMMHUB_TOOL_ALIASES = Object.freeze({
  commhub_send_task: "mcp__commhub__send_task",
  commhub_send_message: "mcp__commhub__send_message",
  commhub_get_all_status: "mcp__commhub__get_all_status",
  commhub_get_session_status: "mcp__commhub__get_session_status",
  commhub_get_task: "mcp__commhub__get_task",
  commhub_list_tasks: "mcp__commhub__list_tasks",
} satisfies Record<string, string>);

export function claudeCommhubToolAliases(
  hasInProcessCommhubServer: boolean,
): Record<string, string> | undefined {
  return hasInProcessCommhubServer ? { ...CLAUDE_COMMHUB_TOOL_ALIASES } : undefined;
}
