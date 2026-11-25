import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReportedSessionId } from "./reported-session-id";

describe("resolveReportedSessionId", () => {
  test("antigravity reports live agySessionId instead of stale boot SESSION_ID", () => {
    expect(resolveReportedSessionId({
      phase: "report_status",
      runtime: "antigravity",
      agySessionId: "eb99bf8b-live-session",
      fallbackSessionId: "b523a25a-stale-boot",
    })).toBe("eb99bf8b-live-session");

    expect(resolveReportedSessionId({
      phase: "register",
      runtime: "antigravity",
      agySessionId: "eb99bf8b-live-session",
      fallbackSessionId: "b523a25a-stale-boot",
    })).toBe("eb99bf8b-live-session");
  });

  test("antigravity omits session_id before first turn or after clearAgySession", () => {
    expect(resolveReportedSessionId({
      phase: "report_status",
      runtime: "antigravity",
      agySessionId: undefined,
      fallbackSessionId: "b523a25a-stale-boot",
    })).toBeUndefined();

    expect(resolveReportedSessionId({
      phase: "register",
      runtime: "antigravity",
      agySessionId: undefined,
      fallbackSessionId: "b523a25a-stale-boot",
    })).toBeUndefined();
  });

  test("preserves existing session_id behavior for other runtimes", () => {
    expect(resolveReportedSessionId({
      phase: "report_status",
      runtime: "grok",
      grokSessionId: "grok-live",
      fallbackSessionId: "boot-id",
    })).toBe("grok-live");

    expect(resolveReportedSessionId({
      phase: "report_status",
      runtime: "claude",
      claudeSessionId: "claude-live",
      fallbackSessionId: "boot-id",
    })).toBe("claude-live");

    expect(resolveReportedSessionId({
      phase: "register",
      runtime: "opencode",
      opencodeSessionId: "oc-live",
      fallbackSessionId: "boot-id",
    })).toBe("oc-live");

    expect(resolveReportedSessionId({
      phase: "report_status",
      runtime: "codex",
      fallbackSessionId: "codex-boot",
    })).toBe("codex-boot");
  });

  test("agent-node/src/cli.ts wires resolveReportedSessionId into both register and reportStatus", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
    expect(cli).toContain('phase: "register"');
    expect(cli).toContain('phase: "report_status"');
    expect(cli).toContain("agySessionId");
  });
});
