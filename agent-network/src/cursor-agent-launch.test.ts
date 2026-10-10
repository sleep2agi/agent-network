import { describe, expect, test } from "bun:test";
import {
  agentNodeHelpSupportsCursorAgent,
  chooseCursorAgentNodeLaunch,
  type CursorAgentNodeCandidate,
} from "./cursor-agent-launch";

const helpWith = (names: string) => `--runtime ${names}`;

function candidate(
  source: CursorAgentNodeCandidate["source"],
  help: string | null,
): CursorAgentNodeCandidate {
  return { source, command: "node", argsPrefix: [`${source}.js`], help };
}

describe("cursor-agent agent-node launch", () => {
  test("help must name cursor-agent", () => {
    expect(agentNodeHelpSupportsCursorAgent(helpWith("opencode-cli | cursor-agent"))).toBe(true);
    expect(agentNodeHelpSupportsCursorAgent(helpWith("opencode-cli"))).toBe(false);
  });

  test("a capable sibling wins over an older PATH agent-node", () => {
    const chosen = chooseCursorAgentNodeLaunch([
      candidate("sibling", helpWith("cursor-agent")),
      candidate("path", helpWith("opencode-cli")),
    ]);
    expect(chosen.source).toBe("sibling");
  });

  test("an incapable sibling falls through to an explicit capable binary", () => {
    const chosen = chooseCursorAgentNodeLaunch([
      candidate("sibling", helpWith("opencode-cli")),
      candidate("explicit", helpWith("cursor-agent")),
      candidate("path", null),
    ]);
    expect(chosen.source).toBe("explicit");
  });

  test("no capable entrypoint refuses the published preview fallback", () => {
    expect(() => chooseCursorAgentNodeLaunch([
      candidate("sibling", helpWith("opencode-cli")),
      candidate("path", null),
    ])).toThrow(/npx @sleep2agi\/agent-node@preview/);
  });
});
