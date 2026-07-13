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
  stdin?: string,
) {
  return Bun.spawnSync({
    cmd: [process.execPath, CLI, ...argv],
    cwd: ws.cwd,
    env: { HOME: ws.home, PATH: ws.bin, ...extraEnv },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeNodeConfig(
  ws: ReturnType<typeof workspace>,
  runtime: string,
  env: Record<string, string> = {},
  extra: Record<string, unknown> = {},
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
    ...extra,
  }));
}

function writeArgvRecorder(ws: ReturnType<typeof workspace>, name: "npx" | "claude" | "codex"): string {
  const log = join(ws.root, `${name}-argv.txt`);
  const executable = join(ws.bin, name);
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(executable, 0o755);
  return log;
}

function writeGlobalConfig(ws: ReturnType<typeof workspace>, config: Record<string, unknown>): void {
  const globalDir = join(ws.home, ".anet");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "config.json"), JSON.stringify(config));
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
    const argvLog = writeArgvRecorder(ws, "npx");
    writeNodeConfig(ws, "claude-agent-sdk", { ANTHROPIC_API_KEY: "test-only-placeholder" });

    const result = runCli(ws, ["node", "start", "test-node"]);
    expect(result.exitCode).toBe(0);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("@sleep2agi/agent-node@preview");
    expect(argv).toContain("--runtime");
    expect(argv).toContain("claude-agent-sdk");
  });

  test("host_supervisor daemon start is keyless and reaches the real npx entry", () => {
    const ws = workspace();
    const argvLog = writeArgvRecorder(ws, "npx");
    writeNodeConfig(ws, "claude-agent-sdk", {}, { role: "host_supervisor" });

    const result = runCli(ws, ["daemon", "start", "test-node"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain("provider credential");
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("@sleep2agi/agent-node@preview");
    expect(argv).toContain("claude-agent-sdk");
  });

  test("host_supervisor daemon up reuses an existing profile and reaches npx without a key", () => {
    const ws = workspace();
    const argvLog = writeArgvRecorder(ws, "npx");
    writeNodeConfig(ws, "claude-agent-sdk", {}, { role: "host_supervisor" });

    const result = runCli(ws, ["daemon", "up", "test-node"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("already a host_supervisor daemon");
    expect(result.stderr.toString()).not.toContain("provider credential");
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("@sleep2agi/agent-node@preview");
    expect(argv).toContain("claude-agent-sdk");
  });

  test("legacy agent-sdk/codex profile launches codex-sdk through npx without rewriting config", () => {
    const ws = workspace();
    const argvLog = writeArgvRecorder(ws, "npx");
    writeNodeConfig(ws, "agent-sdk", {}, { codexRuntime: "codex" });
    const configPath = join(ws.cwd, ".anet", "nodes", "test-node", "config.json");
    const before = readFileSync(configPath, "utf8");

    const result = runCli(ws, ["node", "start", "test-node"]);
    expect(result.exitCode).toBe(0);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("--runtime");
    expect(argv).toContain("codex-sdk");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("unknown stored runtime exits 2 with zero spawn and unchanged config", () => {
    const ws = workspace();
    const npxLog = writeArgvRecorder(ws, "npx");
    const claudeLog = writeArgvRecorder(ws, "claude");
    writeNodeConfig(ws, "private-runtime");
    const configPath = join(ws.cwd, ".anet", "nodes", "test-node", "config.json");
    const before = readFileSync(configPath, "utf8");

    const result = runCli(ws, ["node", "start", "test-node"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported runtime");
    expect(existsSync(npxLog)).toBeFalse();
    expect(existsSync(claudeLog)).toBeFalse();
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("codex-app-server uses npx agent-node and never the Claude launcher", () => {
    const ws = workspace();
    const npxLog = writeArgvRecorder(ws, "npx");
    const claudeLog = writeArgvRecorder(ws, "claude");
    writeArgvRecorder(ws, "codex");
    writeNodeConfig(ws, "codex-app-server");

    const result = runCli(ws, ["node", "start", "test-node"]);
    expect(result.exitCode).toBe(0);
    const argv = readFileSync(npxLog, "utf8");
    expect(argv).toContain("@sleep2agi/agent-node@preview");
    expect(argv).toContain("codex-app-server");
    expect(existsSync(claudeLog)).toBeFalse();
  });

  test("codex-app-server is accepted by create without entering an SDK credential path", () => {
    const ws = workspace();
    writeGlobalConfig(ws, { hub: "http://127.0.0.1:1" });
    const result = runCli(ws, ["node", "create", "cas-node", "--runtime", "codex-app-server"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Not logged in");
    expect(result.stderr.toString()).not.toContain("Unsupported runtime");
    expect(result.stderr.toString()).not.toContain("provider credential");
    expect(existsSync(join(ws.cwd, ".anet", "nodes", "cas-node", "config.json"))).toBeFalse();
  });

  test("batch custom unknown --runtime exits 2 before Hub/config/spawn", () => {
    const ws = workspace();
    const npxLog = writeArgvRecorder(ws, "npx");
    const claudeLog = writeArgvRecorder(ws, "claude");

    const result = runCli(ws, [
      "create", "--batch", "--preset", "__custom__", "--runtime", "private-runtime",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported runtime");
    expect(result.stderr.toString()).toContain("--preset __custom__");
    expect(existsSync(join(ws.cwd, ".anet"))).toBeFalse();
    expect(existsSync(npxLog)).toBeFalse();
    expect(existsSync(claudeLog)).toBeFalse();
  });

  test("batch custom prompt rejects unknown runtime instead of defaulting", () => {
    const ws = workspace();
    const npxLog = writeArgvRecorder(ws, "npx");
    const claudeLog = writeArgvRecorder(ws, "claude");
    writeGlobalConfig(ws, { hub: "http://127.0.0.1:1" });

    const result = runCli(
      ws,
      ["create", "--batch", "--preset", "__custom__"],
      {},
      "private-runtime\n",
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported runtime");
    expect(result.stderr.toString()).toContain("--preset __custom__ prompt");
    expect(existsSync(join(ws.cwd, ".anet"))).toBeFalse();
    expect(existsSync(npxLog)).toBeFalse();
    expect(existsSync(claudeLog)).toBeFalse();
  });
});
