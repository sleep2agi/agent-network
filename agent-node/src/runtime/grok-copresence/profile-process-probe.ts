import { buildGrokCopresenceArgs, isGrokPreviewAutomaticResolution } from "./runtime";
import {
  GROK_COPRESENCE_CAPABILITY_PROFILE,
  GROK_COPRESENCE_EFFECTIVE_TOOLS,
  renderGrokCopresenceAgentProfile,
} from "./policy";
import { selectGrokCopresenceSandboxProfile } from "./profile-selection";

const sandboxProfile = selectGrokCopresenceSandboxProfile(
  GROK_COPRESENCE_CAPABILITY_PROFILE,
  { workspaceProfile: "anet-test232-workspace", strictProfile: "anet-test232-strict" },
);

const args = buildGrokCopresenceArgs({
  cwd: "/workspace/project",
  sessionId: "23223223-2232-4232-8232-232232232232",
  resume: false,
  leaderSocket: "/tmp/anet-test232/leader.sock",
  agentProfile: "/runtime/anet-copresence-preview.md",
  sandboxProfile,
  protectedPaths: ["/runtime/private"],
});
const automaticTool = (tool: string, turnOwner: "human" | "network") => isGrokPreviewAutomaticResolution({
  requestTool: tool,
  activeRequestId: `tool:${tool}`,
  humanDecisionDispatched: false,
  waitingHuman: true,
  turnOwner,
  terminalEventSeen: false,
  event: {
    type: "permission_resolved",
    decision: "allow",
    ts: "2026-08-04T00:00:00Z",
    wait_ms: 1,
    tool_name: tool,
  },
});

process.stdout.write(JSON.stringify({
  profile: GROK_COPRESENCE_CAPABILITY_PROFILE,
  tools: GROK_COPRESENCE_EFFECTIVE_TOOLS,
  sandboxProfile,
  args,
  renderedProfile: renderGrokCopresenceAgentProfile(),
  automaticTools: Object.fromEntries(GROK_COPRESENCE_EFFECTIVE_TOOLS.map((tool) => [tool, {
    human: automaticTool(tool, "human"),
    network: automaticTool(tool, "network"),
  }])),
  toolNearMisses: [
    "web_search2", "WebSearch", " web_search", "web_search ", "web-search",
    "web_search\n", "ｗｅｂ＿ｓｅａｒｃｈ", "not_web_search",
    "read_file2", "Read", "read-file", " grep", "list_dir ", "list_directory",
  ].map((tool) => [tool, automaticTool(tool, "network")]),
}) + "\n");
