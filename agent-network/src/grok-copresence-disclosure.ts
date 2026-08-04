export type GrokCopresenceSessionDisclosure = "configured" | "new" | "resume";

export type GrokCopresenceDisclosure = {
  profile: "commhub-only" | "x-search" | "invalid";
  lines: readonly string[];
};

/**
 * Describe only the two exact tool profiles accepted by the pinned Grok TUI
 * runtime. This is deliberately exact: a near-miss must never be presented as
 * either reviewed capability set.
 */
export function grokCopresenceDisclosure(
  tools: unknown,
  session: GrokCopresenceSessionDisclosure = "configured",
): GrokCopresenceDisclosure {
  const configured = Array.isArray(tools) ? tools : [];
  const xSearch = configured.length === 1 && configured[0] === "WebSearch";
  const defaultProfile = configured.length === 0;

  const lines: string[] = [];
  let profile: GrokCopresenceDisclosure["profile"];
  if (xSearch) {
    profile = "x-search";
    lines.push("Configured profile: x-search; fixed tools: [todo_write,search_tool,use_tool,web_search].");
    lines.push("General web_search is enabled; WebFetch, filesystem, shell, media, project/host MCP, and subagents remain unavailable.");
  } else if (defaultProfile) {
    profile = "commhub-only";
    lines.push("Configured profile: commhub-only; fixed tools: [todo_write,search_tool,use_tool].");
    lines.push("No filesystem, shell, web, media, project/host MCP, or subagents.");
  } else {
    profile = "invalid";
    lines.push("Configured tools do not match a supported exact Grok co-presence profile; startup will fail closed.");
    lines.push("Supported profiles are [] and [WebSearch]; custom or near-match tool names are not accepted.");
  }

  if (session === "new") {
    lines.push("Grok 0.2.93 will pin this tool inventory when the new session is created.");
  } else if (session === "resume") {
    lines.push("Grok 0.2.93 keeps the tool inventory from session creation; resume cannot apply a later profile change.");
    lines.push("After changing tools, stop the node and start it with --new-session.");
  } else {
    lines.push("Grok 0.2.93 pins tools when a session is created; after changing tools, start with --new-session.");
  }

  return { profile, lines };
}
