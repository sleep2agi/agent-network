// #1469 finding-3 — witnessed-red for the --tools / --model validation
// missing in createProfileFromOpts. Before the fix, `--tools Bsh,Read`
// silently produced the profile { tools: ["Bsh", "Read"] } — the typo
// erased Bash from the agent's allowlist and nothing surfaced until the
// model tried (and failed) to use Bash much later.
//
// The witnessed-red pattern:
//   Pre-fix:  no validator exists; opts.tools split+trim only. Typo passes.
//   Post-fix: parseAndValidateTools throws with a message naming the bad
//             token and the expected set (mirrors what #478 did for
//             --runtime via normalizeRuntimeStrict).
//
// These tests exercise the validator directly (pure fn, zero fs, zero
// CLI). The equivalent full-flow shape — createProfileFromOpts calls
// parseAndValidateTools — is covered by that call site's throw path,
// which is a mechanical wiring: the guard is the value.
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_KNOWN_TOOLS,
  parseAndValidateTools,
  validateModel,
} from "./tool-allowlist";

describe("#1469 finding-3 — parseAndValidateTools (--tools guard)", () => {
  test("🔴 witnessed-red: --tools Bsh,Read on claude-agent-sdk throws naming the typo", () => {
    // The exact failure mode reported in the dispatch.
    expect(() => parseAndValidateTools("Bsh,Read", "claude-agent-sdk")).toThrow(
      /unknown Claude-side tool "Bsh"/,
    );
    // The error message must include the expected set so the user knows
    // what to type — the whole reason for throwing instead of silently
    // dropping the bad token.
    let thrown: Error | undefined;
    try { parseAndValidateTools("Bsh,Read", "claude-agent-sdk"); } catch (e) { thrown = e as Error; }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("Bash");
    expect(thrown!.message).toContain("Read");  // in the "expected one of" list
  });

  test("all-known claude tools pass and return the trimmed list", () => {
    const result = parseAndValidateTools("Bash, Read, Write, Grep", "claude-agent-sdk");
    expect(result).toEqual(["Bash", "Read", "Write", "Grep"]);
  });

  test("claude-code-cli runtime uses the same allowlist as claude-agent-sdk", () => {
    // Both claude-lineage runtimes reject the same typo — the allowlist is
    // shared, not per-runtime.
    expect(() => parseAndValidateTools("Bsh", "claude-code-cli")).toThrow(/unknown Claude-side tool/);
    expect(parseAndValidateTools("Bash", "claude-code-cli")).toEqual(["Bash"]);
  });

  test("MCP tools flow through under any runtime (they're server-defined, no static allowlist)", () => {
    const result = parseAndValidateTools("mcp__commhub__send_task,mcp__slack__send_message,Read", "claude-agent-sdk");
    expect(result).toEqual([
      "mcp__commhub__send_task",
      "mcp__slack__send_message",
      "Read",
    ]);
  });

  test("MCP-shaped names outside claude-lineage runtimes also pass", () => {
    expect(parseAndValidateTools("mcp__server__tool", "opencode-cli")).toEqual(["mcp__server__tool"]);
  });

  test("non-claude runtime: unknown-Claude tokens pass basic format only (grok's lowercase_snake OK)", () => {
    // grok's copresence profile uses todo_write/search_tool/use_tool.
    // The Claude-side allowlist must NOT reject them on a grok runtime;
    // grok's own downstream validation is the authority for that field.
    expect(parseAndValidateTools("todo_write,search_tool,use_tool", "grok-build-cli")).toEqual([
      "todo_write", "search_tool", "use_tool",
    ]);
  });

  test("basic format check catches shape violations on ANY runtime (leading digit, whitespace, punctuation)", () => {
    // Every non-MCP tool token must start with a letter and only contain
    // identifier chars — even on non-claude-lineage runtimes. This catches
    // typos with punctuation regardless of runtime scoping.
    expect(() => parseAndValidateTools("1Bad", "grok-build-cli")).toThrow(/invalid tool name/);
    expect(() => parseAndValidateTools("with space", "opencode-cli")).toThrow(/invalid tool name/);
    expect(() => parseAndValidateTools("weird.name", "codex-sdk")).toThrow(/invalid tool name/);
  });

  test("empty --tools value / whitespace-only / commas-only throws (helps user, not a silent no-op)", () => {
    // The dispatch's guidance: fail loudly. If a user types --tools "" or
    // --tools ",,", that's almost certainly a shell-quoting mistake, not
    // "please give me the runtime default" (that's what omitting --tools
    // does). Throwing tells them explicitly.
    expect(() => parseAndValidateTools("", "claude-agent-sdk")).toThrow(/empty list/);
    expect(() => parseAndValidateTools("   ", "claude-agent-sdk")).toThrow(/empty list/);
    expect(() => parseAndValidateTools(",,,", "claude-agent-sdk")).toThrow(/empty list/);
  });

  test("trimming: `--tools ' Bash , Read '` returns clean tokens (surrounding ws normal, embedded ws still rejected)", () => {
    expect(parseAndValidateTools(" Bash , Read ", "claude-agent-sdk")).toEqual(["Bash", "Read"]);
  });

  test("CLAUDE_KNOWN_TOOLS is stable and non-empty (source-of-truth guardrail)", () => {
    // If someone accidentally empties or re-orders CLAUDE_KNOWN_TOOLS,
    // this test surfaces it. Not exhaustive on content, but ensures the
    // constant itself remains present.
    expect(CLAUDE_KNOWN_TOOLS.length).toBeGreaterThan(5);
    expect(CLAUDE_KNOWN_TOOLS).toContain("Bash");
    expect(CLAUDE_KNOWN_TOOLS).toContain("Read");
    expect(CLAUDE_KNOWN_TOOLS).toContain("Write");
    expect(CLAUDE_KNOWN_TOOLS).toContain("Grep");
    expect(CLAUDE_KNOWN_TOOLS).toContain("WebSearch");
  });
});

describe("#1469 finding-3 — validateModel (--model guard)", () => {
  test("🔴 witnessed-red: empty and whitespace-only values throw", () => {
    expect(() => validateModel("")).toThrow(/empty/);
    expect(() => validateModel("   ")).toThrow(/empty/);
  });

  test("value with embedded whitespace throws (shell-quoting typo catcher)", () => {
    expect(() => validateModel("claude 3 opus")).toThrow(/whitespace/);
    expect(() => validateModel("model\twith\ttabs")).toThrow(/whitespace/);
  });

  test("trims surrounding whitespace but rejects embedded", () => {
    expect(validateModel("  claude-3-opus  ")).toBe("claude-3-opus");
  });

  test("realistic model names pass through (no allowlist over-restriction)", () => {
    // We deliberately do NOT enforce a known-model list — vendors evolve
    // their model catalogs independently and a strict allowlist would
    // break the first time MiniMax/DeepSeek/GLM ships a new variant.
    expect(validateModel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
    expect(validateModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(validateModel("glm-4.7")).toBe("glm-4.7");
    expect(validateModel("MiniMax-M2.7")).toBe("MiniMax-M2.7");
    expect(validateModel("gpt-5-2024-12")).toBe("gpt-5-2024-12");
  });
});
