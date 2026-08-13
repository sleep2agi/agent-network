import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { readPinnedGrokCopresenceCapabilityProfile } from "./profile-selection";

/**
 * Pinned Grok 0.2.93 ignores `--tools` in its interactive TUI.  The preview
 * therefore uses one runtime-owned agent profile and verifies the effective
 * request inventory independently.  The two MCP dispatcher tools are useful
 * only because startup separately proves that exactly one runtime-owned
 * `commhub` server was discovered. The repo-read profile adds only the three
 * read-only project tools; process, write, web/media, subagent, and scheduler
 * tools remain absent, while protected credential paths stay hard-denied.
 */
export const GROK_COPRESENCE_CAPABILITY_PROFILE = readPinnedGrokCopresenceCapabilityProfile();
export const GROK_COPRESENCE_WEB_SEARCH_ENABLED = GROK_COPRESENCE_CAPABILITY_PROFILE === "x-search";
export const GROK_COPRESENCE_REPO_READ_ENABLED = GROK_COPRESENCE_CAPABILITY_PROFILE === "repo-read";
export const GROK_COPRESENCE_EFFECTIVE_TOOLS = Object.freeze([
  "todo_write",
  "search_tool",
  "use_tool",
  ...(GROK_COPRESENCE_WEB_SEARCH_ENABLED ? ["web_search"] : []),
  ...(GROK_COPRESENCE_REPO_READ_ENABLED ? ["read_file", "grep", "list_dir"] : []),
]);

/**
 * Vendor-native effectful/control tools that must remain unavailable even
 * when the pinned interactive TUI ignores the agent profile's `tools`
 * inventory. This includes every non-read/non-search name observed in the
 * pinned 0.2.93 AvailableCommandsUpdate inventory, plus conservative native
 * aliases seen in the binary/repository. Keep the Claude-compatible aliases
 * in runtime argv too, but never rely on them as translations for Grok's
 * lifecycle names.
 */
export const GROK_COPRESENCE_VENDOR_DENY_TOOLS = Object.freeze([
  "run_terminal_command",
  "run_terminal_cmd",
  "search_replace",
  "write_file",
  "edit_file",
  "apply_patch",
  "write",
  "kill_command_or_subagent",
  "get_command_or_subagent_output",
  "wait_commands_or_subagents",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "monitor",
  "update_goal",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  "web_fetch",
  "http_request",
  "image_gen",
  "image_edit",
  "generate_image",
  "video_gen",
  "generate_video",
  "browser",
  "computer",
  "screenshot",
]);

export const GROK_COPRESENCE_AGENT_NAME = "anet-copresence-preview";
export const GROK_COPRESENCE_AGENT_FILE = `${GROK_COPRESENCE_AGENT_NAME}.md`;
export const GROK_COPRESENCE_PROFILE_MARKER = "ANET_COPRESENCE_PROFILE_V1";

export function renderGrokCopresenceAgentProfile(): string {
  return [
    "---",
    `name: ${GROK_COPRESENCE_AGENT_NAME}`,
    `description: Fixed Agent Network co-presence preview profile (${GROK_COPRESENCE_CAPABILITY_PROFILE})`,
    "injectDefaultTools: false",
    "discoverSkills: false",
    "inheritSkills: false",
    "tools:",
    ...GROK_COPRESENCE_EFFECTIVE_TOOLS.map((tool) => `  - ${tool}`),
    "---",
    GROK_COPRESENCE_WEB_SEARCH_ENABLED
      ? `${GROK_COPRESENCE_PROFILE_MARKER}: Answer the current user directly. The runtime-owned outbound-only commhub MCP integration and general web_search are available; do not claim inbound CommHub, lifecycle/presence ownership, filesystem, shell, web-fetch/media, or subagent access. Web search is not an x.com-only network sandbox.`
      : GROK_COPRESENCE_REPO_READ_ENABLED
        ? `${GROK_COPRESENCE_PROFILE_MARKER}: Answer the current user directly. The runtime-owned outbound-only commhub MCP integration plus read_file, grep, and list_dir are available under Grok's strict sandbox: project tree plus essential system paths only; protected credential paths remain denied. Do not claim shell, write/edit, web/media, lifecycle/presence ownership, or subagent access.`
        : `${GROK_COPRESENCE_PROFILE_MARKER}: Answer the current user directly. Only the runtime-owned outbound-only commhub MCP integration is available; do not claim inbound CommHub, lifecycle/presence ownership, filesystem, shell, web/media, or subagent access.`,
    "",
  ].join("\n");
}

/** Re-bind the generated profile at the final PTY boundary. */
export function assertGrokCopresenceAgentProfile(profilePath: string, grokHome: string): void {
  const canonicalHome = realpathSync(resolve(grokHome));
  const expectedPath = join(canonicalHome, GROK_COPRESENCE_AGENT_FILE);
  if (resolve(profilePath) !== expectedPath || dirname(expectedPath) !== canonicalHome) {
    throw new Error("grok copresence agent profile is outside its runtime-owned home");
  }
  const before = lstatSync(expectedPath);
  const uid = process.getuid?.();
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || (uid !== undefined && before.uid !== uid)
  ) {
    throw new Error("grok copresence agent profile is not an owner-only regular file");
  }
  const fd = openSync(expectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || (opened.mode & 0o777) !== 0o600
      || (uid !== undefined && opened.uid !== uid)
      || readFileSync(fd, "utf8") !== renderGrokCopresenceAgentProfile()
    ) {
      throw new Error("grok copresence agent profile differs from the fixed preview policy");
    }
  } finally {
    closeSync(fd);
  }
}
