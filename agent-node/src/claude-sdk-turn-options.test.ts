// #557 items 4+5 — claude-agent-sdk turn options: turn-end notice, no background
// tasks, no claude.ai account connectors unless the node config opts in.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLAUDE_TURN_END_NOTICE,
  buildClaudeSystemPrompt,
  claudeAiConnectorsOptIn,
  claudeSdkChildEnv,
} from "./claude-sdk-turn-options";

const cliSrc = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

describe("#557 turn-end notice", () => {
  test("says the reply ends the task, background is stopped, no later follow-up — in at most 2 sentences", () => {
    expect(CLAUDE_TURN_END_NOTICE).toMatch(/reply ends this task/);
    expect(CLAUDE_TURN_END_NOTICE).toMatch(/background is stopped/);
    expect(CLAUDE_TURN_END_NOTICE).toMatch(/foreground/);
    expect(CLAUDE_TURN_END_NOTICE).toMatch(/never promise a later follow-up/);
    expect(CLAUDE_TURN_END_NOTICE.trim().split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
  });

  test("operator prompt is kept verbatim as the suffix; intern bias stays first", () => {
    const operatorPrompt = "You are 通信X.\n\nRules: A, B.";
    const out = buildClaudeSystemPrompt({ internToolUseBias: "BIAS\n\n", operatorPrompt });
    expect(out).toBe("BIAS\n\n" + CLAUDE_TURN_END_NOTICE + operatorPrompt);
    expect(out.endsWith(operatorPrompt)).toBe(true);
  });

  test("no operator prompt and no bias still yields the notice (never empty)", () => {
    expect(buildClaudeSystemPrompt({})).toBe(CLAUDE_TURN_END_NOTICE);
    expect(buildClaudeSystemPrompt({ internToolUseBias: "", operatorPrompt: "" })).toBe(CLAUDE_TURN_END_NOTICE);
  });
});

describe("#557 SDK child env", () => {
  test("default: background tasks disabled and claude.ai connectors off", () => {
    const env = claudeSdkChildEnv({ PATH: "/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "1" }, { keepClaudeAiConnectors: false });
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.PATH).toBe("/bin");
  });

  test("opt-in keeps the operator's connector setting; background stays disabled", () => {
    const env = claudeSdkChildEnv({ PATH: "/bin" }, { keepClaudeAiConnectors: true });
    expect("ENABLE_CLAUDEAI_MCP_SERVERS" in env).toBe(false);
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(claudeSdkChildEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "0" }, { keepClaudeAiConnectors: true }).ENABLE_CLAUDEAI_MCP_SERVERS).toBe("0");
  });

  test("does not mutate the input env", () => {
    const base = { PATH: "/bin" };
    claudeSdkChildEnv(base, { keepClaudeAiConnectors: false });
    expect(base).toEqual({ PATH: "/bin" });
  });

  test("opt-in only on boolean true", () => {
    expect(claudeAiConnectorsOptIn({ claudeAiConnectors: true })).toBe(true);
    for (const v of ["true", 1, false, null, undefined]) expect(claudeAiConnectorsOptIn({ claudeAiConnectors: v })).toBe(false);
    expect(claudeAiConnectorsOptIn(undefined)).toBe(false);
    expect(claudeAiConnectorsOptIn({})).toBe(false);
  });
});

describe("#557 processWithClaude wiring", () => {
  test("combinedSystemPrompt is built by buildClaudeSystemPrompt (and #501 snapshot:false shape is kept)", () => {
    expect(cliSrc).toMatch(/const combinedSystemPrompt = buildClaudeSystemPrompt\(\{ internToolUseBias, operatorPrompt: SYSTEM_PROMPT \}\);/);
    expect(cliSrc).toMatch(/options\.systemPrompt\s*=\s*\{\s*type:\s*"custom",\s*prompt:\s*combinedSystemPrompt,\s*snapshot:\s*false\s*\}/);
  });

  test("SDK child env goes through claudeSdkChildEnv with the node-config opt-in", () => {
    expect(cliSrc).toMatch(/env: claudeSdkChildEnv\(maskedEnv\(process\.env\), \{\s*keepClaudeAiConnectors: claudeAiConnectorsOptIn\(fileConfig\?\.flags\),\s*\}\)/);
    expect(cliSrc).not.toMatch(/env: maskedEnv\(process\.env\),/);
  });
});
