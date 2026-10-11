// claude-code-cli does not run inside agent-node. `anet node start` spawns
// `claude --session-id <uuid>` / `--resume <uuid>` and the channel MCP
// (node-server) is the process that heartbeats. The uuid has to be on that
// child's env, set after the id is final and before spawn.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function launchAgentBody(): string {
  const start = CLI.indexOf("async function launchAgent(");
  expect(start).toBeGreaterThan(-1);
  const rest = CLI.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("claude-code-cli passes its resume id to node-server", () => {
  const body = launchAgentBody();

  test("ANET_RUNTIME_SESSION_ID is assigned from profile.session after the argv is chosen and before spawn", () => {
    const sessionFlag = body.indexOf('claudeArgs.push("--session-id", profile.session)');
    const assign = body.indexOf("env.ANET_RUNTIME_SESSION_ID = runtimeSessionId");
    const spawnClaude = body.indexOf('spawn("claude", claudeArgs');
    expect(sessionFlag).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(sessionFlag);
    expect(spawnClaude).toBeGreaterThan(assign);
    const between = body.slice(assign - 400, spawnClaude);
    expect(between).toContain("profile.session");
    expect(between).toContain("delete env.ANET_RUNTIME_SESSION_ID");
    expect(between).toContain("length <= 200");
  });
});
