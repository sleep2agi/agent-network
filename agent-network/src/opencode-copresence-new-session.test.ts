import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// 2026-11-25: `anet node start 通信猫 --new-session` on an OpenCode V2 co-presence node
// resumed the saved session anyway. The orchestrator re-runs `node start` inside the
// bridge tmux session, and that inner command is the one that decides resume vs fresh;
// it was built without the flag, so the user's choice was silently dropped.
const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
const start = cli.indexOf("async function startOpencodeCopresenceOrchestration(");
const body = cli.slice(start, cli.indexOf("\n}\n", start));

describe("OpenCode co-presence --new-session", () => {
  test("the orchestrator takes the new-session choice", () => {
    expect(start).toBeGreaterThan(0);
    expect(cli.slice(start, cli.indexOf("{", start))).toContain("newSession = false");
  });

  test("the bridge's inner node start forwards --new-session", () => {
    const inner = body.slice(body.indexOf("node start ${shellQuote(resolved.id)}"));
    expect(inner.slice(0, inner.indexOf('].join(" ; ")'))).toContain('(newSession ? " --new-session" : "")');
  });

  test("node start passes the user's flag to the orchestrator", () => {
    expect(cli).toContain("await startOpencodeCopresenceOrchestration(id, opts.hub, forceNewSession);");
    expect(cli).not.toMatch(/await startOpencodeCopresenceOrchestration\(id, opts\.hub\);/);
  });
});
