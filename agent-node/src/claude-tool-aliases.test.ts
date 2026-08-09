import { describe, expect, test } from "bun:test";
import { CLAUDE_COMMHUB_TOOL_ALIASES, claudeCommhubToolAliases } from "./claude-tool-aliases";

describe("Claude CommHub tool aliases", () => {
  test("pins the exact registered in-process CommHub tool set", () => {
    expect(CLAUDE_COMMHUB_TOOL_ALIASES).toEqual({
      commhub_send_task: "mcp__commhub__send_task",
      commhub_send_message: "mcp__commhub__send_message",
      commhub_get_all_status: "mcp__commhub__get_all_status",
      commhub_get_session_status: "mcp__commhub__get_session_status",
      commhub_get_task: "mcp__commhub__get_task",
      commhub_list_tasks: "mcp__commhub__list_tasks",
    });
    expect("commhub_send_reply" in CLAUDE_COMMHUB_TOOL_ALIASES).toBe(false);
  });

  test("does not advertise aliases when the in-process server failed", () => {
    expect(claudeCommhubToolAliases(false)).toBeUndefined();
    expect(claudeCommhubToolAliases(true)).toEqual(CLAUDE_COMMHUB_TOOL_ALIASES);
  });
});
