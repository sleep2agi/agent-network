// cursor-agent is a source preview. Published npm preview does not contain it,
// so `anet node start` must not fall through to `npx @sleep2agi/agent-node@preview`.

export function agentNodeHelpSupportsCursorAgent(help: string): boolean {
  return help.includes("cursor-agent");
}

export interface CursorAgentNodeCandidate {
  source: "sibling" | "explicit" | "path";
  command: string;
  argsPrefix: string[];
  /** `--help` text, or null when the probe failed. */
  help: string | null;
}

export function chooseCursorAgentNodeLaunch(
  candidates: readonly CursorAgentNodeCandidate[],
): CursorAgentNodeCandidate {
  for (const candidate of candidates) {
    if (candidate.help && agentNodeHelpSupportsCursorAgent(candidate.help)) return candidate;
  }
  throw new Error(
    "cursor-agent is not on published npm preview, so anet will not run npx @sleep2agi/agent-node@preview. " +
    "Use the agent-node installed beside this anet checkout, or set ANET_AGENT_NODE_BIN to an agent-node whose --help lists cursor-agent.",
  );
}
