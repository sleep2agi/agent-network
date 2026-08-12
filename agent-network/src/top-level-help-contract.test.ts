import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

function realHelp(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "anet-top-help-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "anet-top-help-cwd-"));
  try {
    return spawnSync("bun", [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
      timeout: 15_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("top-level help matches the implemented command parsers", () => {
  test("advertises only the implemented config and batch shapes", () => {
    const result = realHelp("--help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("anet config [path|json]");
    expect(result.stdout).toContain("anet batch <verb> [prefix]");
    expect(result.stdout).not.toContain("anet config get|set");
    expect(result.stdout).not.toContain("anet batch <file>");
  });

  test("includes the provider required by opencode auth-login", () => {
    const result = realHelp("--help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "anet opencode auth-login <n> --provider <anthropic|openai>",
    );
  });
});
