import { buildGrokCopresenceArgs, isGrokPreviewAutomaticResolution } from "./runtime";
import {
  GROK_COPRESENCE_CAPABILITY_PROFILE,
  GROK_COPRESENCE_EFFECTIVE_TOOLS,
  renderGrokCopresenceAgentProfile,
} from "./policy";

const args = buildGrokCopresenceArgs({
  cwd: "/workspace/project",
  sessionId: "23223223-2232-4232-8232-232232232232",
  resume: false,
  leaderSocket: "/tmp/anet-test232/leader.sock",
  agentProfile: "/runtime/anet-copresence-preview.md",
  sandboxProfile: "anet-test232-workspace",
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
  args,
  renderedProfile: renderGrokCopresenceAgentProfile(),
  automaticWebSearch: {
    human: automaticTool("web_search", "human"),
    network: automaticTool("web_search", "network"),
  },
  webSearchNearMisses: [
    "web_search2", "WebSearch", " web_search", "web_search ", "web-search",
    "web_search\n", "ｗｅｂ＿ｓｅａｒｃｈ", "not_web_search",
  ].map((tool) => [tool, automaticTool(tool, "network")]),
}) + "\n");
