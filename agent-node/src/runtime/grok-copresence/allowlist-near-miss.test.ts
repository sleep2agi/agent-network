// The fixed preview tool profile must be an EXACT value set.
//
// `isGrokPreviewAutomaticResolution` is exported with the comment "exported so
// every rejected dimension has a pure mutation test" — but the allowlist
// dimension had no such test. Independent review found that widening
//
//     GROK_COPRESENCE_EFFECTIVE_TOOLS.includes(requestTool)
//   → GROK_COPRESENCE_EFFECTIVE_TOOLS.some(t => requestTool.startsWith(t))
//
// left the whole suite green: 5 pass / 0 fail. An approval allowlist that no
// test pins can be loosened later and nothing goes red.
//
// This file pins it. Every case below is a name that is NOT in the profile but
// is close enough to slip through a shape match rather than a value match.
//
// Run: bun test src/runtime/grok-copresence/allowlist-near-miss.test.ts

import { describe, expect, test } from "bun:test";
import { isGrokPreviewAutomaticResolution } from "./runtime";
import { GROK_COPRESENCE_EFFECTIVE_TOOLS } from "./policy";

/**
 * A fully valid automatic-resolution tuple for `tool`, so the ONLY thing under
 * test is whether `tool` is in the profile. Every other dimension is already
 * covered by its own test elsewhere.
 */
function validResolutionFor(tool: string) {
  return {
    requestTool: tool,
    activeRequestId: `tool:${tool}`,
    humanDecisionDispatched: false,
    waitingHuman: true,
    turnOwner: "network" as const,
    terminalEventSeen: false,
    event: {
      type: "permission_resolved",
      decision: "allow",
      ts: "2026-08-03T00:00:00Z",
      wait_ms: 0,
      tool_name: tool,
    },
  };
}

describe("grok copresence preview tool profile is an exact value set", () => {
  // Positive control. Without this, every rejection below could be passing
  // because the fixture itself is malformed rather than because the name was
  // refused — a test that can only ever return false proves nothing.
  test("a profile tool with an otherwise valid tuple is accepted", () => {
    for (const tool of GROK_COPRESENCE_EFFECTIVE_TOOLS) {
      expect(isGrokPreviewAutomaticResolution(validResolutionFor(tool))).toBe(true);
    }
  });

  const nearMisses = [
    // Suffixed — accepted by startsWith, refused by an exact set.
    "todo_write2",
    "search_tool2",
    "use_tool2",
    "use_tool_v2",
    "use_tool-admin",
    // Case variants.
    "Use_Tool",
    "USE_TOOL",
    "Todo_Write",
    // Padding.
    " use_tool",
    "use_tool ",
    "use_tool\n",
    // Truncated — accepted by an endsWith/contains style match.
    "use_too",
    "tool",
    // Contains a profile name without being one.
    "not_use_tool",
    "xuse_toolx",
    // Full-width and zero-width lookalikes.
    "ｕｓｅ＿ｔｏｏｌ",
    "use​tool",
    "use_to​ol",
    // Empty-ish.
    "",
    " ",
    // Added by independent review of this file: case symmetry on the other two
    // entries, the remaining control characters, an endsWith-shaped name, and a
    // separator swap.
    "Search_Tool",
    "TODO_WRITE",
    "use_tool\r",
    "use_tool\0",
    "x_todo_write",
    "use-tool",
    "todo-write",
  ];

  for (const tool of nearMisses) {
    test(`refuses ${JSON.stringify(tool)}`, () => {
      expect(isGrokPreviewAutomaticResolution(validResolutionFor(tool))).toBe(false);
    });
  }

  // The profile itself is part of the contract: silently growing it would make
  // every rejection above pass for the wrong reason.
  test("the profile is exactly the three pinned tools", () => {
    expect([...GROK_COPRESENCE_EFFECTIVE_TOOLS]).toEqual(["todo_write", "search_tool", "use_tool"]);
  });
});
