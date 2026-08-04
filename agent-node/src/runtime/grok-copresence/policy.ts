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
 * `commhub` server was discovered.  Filesystem, process, web/media, subagent,
 * and scheduler tools remain absent.
 */
export const GROK_COPRESENCE_CAPABILITY_PROFILE = readPinnedGrokCopresenceCapabilityProfile();
export const GROK_COPRESENCE_WEB_SEARCH_ENABLED = GROK_COPRESENCE_CAPABILITY_PROFILE === "x-search";
export const GROK_COPRESENCE_EFFECTIVE_TOOLS = Object.freeze([
  "todo_write",
  "search_tool",
  "use_tool",
  ...(GROK_COPRESENCE_WEB_SEARCH_ENABLED ? ["web_search"] : []),
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
      ? `${GROK_COPRESENCE_PROFILE_MARKER}: Answer the current user directly. The runtime-owned commhub MCP integration and general web_search are available; do not claim filesystem, shell, web-fetch/media, or subagent access. Web search is not an x.com-only network sandbox.`
      : `${GROK_COPRESENCE_PROFILE_MARKER}: Answer the current user directly. Only the runtime-owned commhub MCP integration is available; do not claim filesystem, shell, web/media, or subagent access.`,
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
