import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_SESSION_ID_MAX, runtimeResumeSessionId, type RuntimeSessionSources } from "./runtime-session-id";

const CLAUDE = "6ac06f64-1111-4000-8000-000000000001";
const THREAD = "0199abcd-2222-4000-8000-000000000002";
const GROK = "grok_session_example";
const OPENCODE = "ses_0d571d710ffeeQgHa0262JnDNv";

function id(runtime: RuntimeSessionSources["runtime"], extra: Partial<RuntimeSessionSources> = {}) {
  return runtimeResumeSessionId({ runtime, ...extra });
}

describe("runtimeResumeSessionId", () => {
  test("claude-agent-sdk reports the SDK session id, not a boot leftover from another field", () => {
    expect(id("claude", { claudeSessionId: CLAUDE, bootSessionId: "stale-boot" })).toBe(CLAUDE);
    expect(id("claude", { claudeSessionId: "", bootSessionId: "stale-boot" })).toBeUndefined();
    expect(id("claude")).toBeUndefined();
  });

  test("grok reports only the live session; a cleared session is omitted", () => {
    expect(id("grok", { grokSessionId: GROK, bootSessionId: "old" })).toBe(GROK);
    expect(id("grok", { grokSessionId: undefined, bootSessionId: "old" })).toBeUndefined();
  });

  test("opencode reports the ACP / co-presence session id", () => {
    expect(id("opencode", { opencodeSessionId: OPENCODE })).toBe(OPENCODE);
    expect(id("opencode", { bootSessionId: OPENCODE })).toBeUndefined();
  });

  test("codex-app-server reports the Codex thread id, not the generic boot session", () => {
    expect(id("codex-app-server", { codexAppServerThreadId: THREAD, bootSessionId: "other" })).toBe(THREAD);
    expect(id("codex-app-server", { bootSessionId: THREAD })).toBeUndefined();
  });

  test("codex-sdk prefers the live thread, then the boot session used to resume", () => {
    expect(id("codex", { codexSdkThreadId: THREAD, bootSessionId: "boot" })).toBe(THREAD);
    expect(id("codex", { bootSessionId: "boot" })).toBe("boot");
    expect(id("codex", { codexStdioRecordedThreadId: "stdio-only", bootSessionId: "boot" })).toBe("boot");
  });

  test("codex stdio lane reports the recorded thread", () => {
    expect(id("codex", { codexStdioDirect: true, codexStdioRecordedThreadId: THREAD, codexSdkThreadId: "sdk", bootSessionId: "boot" })).toBe(THREAD);
    expect(id("codex", { codexStdioDirect: true, bootSessionId: "boot" })).toBe("boot");
    expect(id("codex", { codexStdioDirect: true })).toBeUndefined();
  });

  test("blank, non-string, and over-max values are omitted (a 201-char id would reject the whole report_status)", () => {
    expect(id("claude", { claudeSessionId: "  " })).toBeUndefined();
    expect(id("claude", { claudeSessionId: `  ${CLAUDE}  ` })).toBe(CLAUDE);
    expect(id("grok", { grokSessionId: null })).toBeUndefined();
    const tooLong = "x".repeat(RUNTIME_SESSION_ID_MAX + 1);
    expect(id("codex-app-server", { codexAppServerThreadId: tooLong })).toBeUndefined();
    expect(id("codex-app-server", { codexAppServerThreadId: "y".repeat(RUNTIME_SESSION_ID_MAX) })).toBe("y".repeat(RUNTIME_SESSION_ID_MAX));
  });

  test("unknown runtime does not invent an id from a boot session", () => {
    expect(id("claude-code-cli", { bootSessionId: CLAUDE })).toBeUndefined();
    expect(id("", { bootSessionId: CLAUDE, claudeSessionId: CLAUDE })).toBeUndefined();
  });
});

describe("agent-node report_status sends the live resume id", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("register and reportStatus both send the same currentRuntimeSessionId() they record as published", () => {
    // One read per report: lastPublished and the payload must not diverge.
    const assign = /const activeSessionId = currentRuntimeSessionId\(\);/g;
    const field = /session_id:\s*activeSessionId/g;
    expect(src.match(assign)?.length).toBe(2);
    expect(src.match(field)?.length).toBe(2);
    expect(src).not.toContain('const activeSessionId = RUNTIME === "grok"');
  });

  test("a newly learned id is published after register, from each writeback", () => {
    expect(src).toContain("runtimeSessionPublishArmed = true;");
    expect(src).toContain("publishRuntimeSessionIfNew();");
    for (const fn of ["function writebackSession(", "function writebackGrokSession(", "function writebackCodexThread("]) {
      const at = src.indexOf(fn);
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 500)).toContain("publishRuntimeSessionIfNew()");
    }
  });
});
