import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function functionBody(name: string): string {
  const start = CLI.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = CLI.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("#485 claude-code-cli dependency preflight", () => {
  const dependencyBody = functionBody("checkRuntimeDependency");
  const launchBody = functionBody("launchAgent");

  test("create remains a warning while start fails closed", () => {
    expect(dependencyBody).toContain('!claudeInstalled && phase === "create"');
    expect(dependencyBody).toContain('!claudeInstalled && phase === "start"');
    const startGate = dependencyBody.slice(
      dependencyBody.indexOf('!claudeInstalled && phase === "start"'),
      dependencyBody.indexOf('if (phase === "start") printClaudeCodeNotice'),
    );
    expect(startGate).toMatch(/console\.error/);
    expect(startGate).toMatch(/process\.exit\(1\)/);
    expect(startGate).toContain("npm install -g @anthropic-ai/claude-code");
    expect(startGate).toContain("claude auth login");
    expect(startGate).toContain("--runtime claude-agent-sdk");
  });

  test("dependency refusal runs before launch side effects", () => {
    const dependencyCheck = launchBody.indexOf('checkRuntimeDependency(runtime, "start")');
    const mcpWrite = launchBody.indexOf("ensureMcpJson(profile)");
    const claudeSpawn = launchBody.indexOf('spawn("claude", claudeArgs');
    expect(dependencyCheck).toBeGreaterThan(-1);
    expect(mcpWrite).toBeGreaterThan(dependencyCheck);
    expect(claudeSpawn).toBeGreaterThan(dependencyCheck);
  });
});
