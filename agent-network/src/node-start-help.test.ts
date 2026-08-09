import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

function realHelp(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "anet-518-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "anet-518-cwd-"));
  try {
    const result = spawnSync("bun", [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("#518 node start help exposes the recommended headless flag", () => {
  test("real `anet node start --help` names --accept-dev-channels and its operating boundary", () => {
    const result = realHelp("node", "start", "--help");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: anet node start <name> [options]");
    expect(result.stdout).toContain("--accept-dev-channels");
    expect(result.stdout).toMatch(/Headless \/ CI \/ no-TTY/);
    expect(result.stdout).toMatch(/detached\s+tmux/);
    expect(result.stdout).toMatch(/requires tmux/);
  });

  test("asking for help performs no node-start work", () => {
    const result = realHelp("node", "start", "--help");
    expect(result.stdout).not.toContain("Starting agent-node");
    expect(result.stdout).not.toContain("not found");
    expect(result.stderr).toBe("");
  });
});
