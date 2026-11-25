import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// 2026-11-25 on the anet host: `anet node stop 通信猫` (OpenCode V2 co-presence) really
// stopped the node — process gone, both tmux sessions gone — but printed
// `"通信猫" is not running locally`. The graceful SIGTERM takes the tmux sessions down
// with the agent and the agent clears its own pidfile, so the later checks found
// nothing and the summary claimed there was nothing to stop.
const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");

describe("anet node stop on an OpenCode co-presence node", () => {
  test("a graceful SIGTERM of the agent is remembered", () => {
    expect(cli).toContain("let opencodeAgentSignalled = false;");
    expect(cli).toContain('process.kill(identity.pid, "SIGTERM"); opencodeAgentSignalled = true;');
  });

  test("and counts as a stop in the summary line", () => {
    expect(cli).toContain('const killed = stopResult.status === "stopped" || opencodeAgentSignalled;');
    const at = cli.indexOf('const killed = stopResult.status === "stopped" || opencodeAgentSignalled;');
    const summary = cli.slice(at, cli.indexOf("is not running locally", at));
    expect(summary).toContain("if (killed || tmuxKilled)");
  });
});
