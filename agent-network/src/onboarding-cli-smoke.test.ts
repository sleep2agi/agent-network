import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");
const roots: string[] = [];

function workspace(): { root: string; home: string; bin: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "anet-onboarding-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, bin, cwd };
}

function runCli(
  ws: ReturnType<typeof workspace>,
  argv: string[],
  extraEnv: Record<string, string> = {},
) {
  return Bun.spawnSync({
    cmd: [process.execPath, CLI, ...argv],
    cwd: ws.cwd,
    env: { HOME: ws.home, PATH: ws.bin, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeNodeConfig(
  ws: ReturnType<typeof workspace>,
  runtime: string,
  env: Record<string, string> = {},
) {
  const dir = join(ws.cwd, ".anet", "nodes", "test-node");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    node_id: "n_testnode",
    node_name: "test-node",
    alias: "test-node",
    runtime,
    token: "test-only-node-token",
    channels: ["server:commhub"],
    env,
    flags: {},
  }));
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("onboarding CLI subprocess gates", () => {
  test("version/setup-facing report declares the Bun prerequisite", () => {
    const ws = workspace();
    const result = runCli(ws, ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Bun/bunx missing");
    expect(result.stdout.toString()).toContain("https://bun.sh/install");
  });

  test("unknown --runtime exits non-zero before Hub access and never falls back", () => {
    const ws = workspace();
    const result = runCli(ws, ["node", "create", "test-node", "--runtime", "not-a-runtime"]);
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain("Unsupported runtime");
    expect(stderr).toContain("not-a-runtime");
    expect(result.stdout.toString()).not.toContain("Created node");
    expect(existsSync(join(ws.cwd, ".anet", "nodes", "test-node", "config.json"))).toBeFalse();
  });

  test("hub start without bunx exits with actionable Bun guidance", () => {
    const ws = workspace();
    const result = runCli(ws, ["hub", "start", "--port", "65431"]);
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("requires Bun >= 1.2.0");
    expect(stderr).toContain("https://bun.sh/install");
  });

  test("blank claude-agent-sdk credential blocks start before npx", () => {
    const ws = workspace();
    writeNodeConfig(ws, "claude-agent-sdk");
    const result = runCli(ws, ["node", "start", "test-node"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("needs a non-empty provider credential");
  });

  test("missing global agent-node takes the real npx fallback", () => {
    const ws = workspace();
    const argvLog = join(ws.root, "npx-argv.txt");
    const npx = join(ws.bin, "npx");
    writeFileSync(npx, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ANET_TEST_ARGV_LOG\"\nexit 0\n");
    chmodSync(npx, 0o755);
    writeNodeConfig(ws, "claude-agent-sdk", { ANTHROPIC_API_KEY: "test-only-placeholder" });

    const result = runCli(ws, ["node", "start", "test-node"], { ANET_TEST_ARGV_LOG: argvLog });
    expect(result.exitCode).toBe(0);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("@sleep2agi/agent-node@preview");
    expect(argv).toContain("--runtime");
    expect(argv).toContain("claude-agent-sdk");
  });
});
