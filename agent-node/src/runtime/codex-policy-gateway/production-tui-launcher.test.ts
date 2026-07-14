import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BINARY_IDENTITY_MISMATCH,
  resolveCodexBinaryIdentity,
} from "./codex-binary";
import {
  ProductionTuiLauncher,
  __test,
} from "./production-tui-launcher";
import { buildAllowlistEnv } from "./tui-child-launcher";

function executable(path: string, source: string): string {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("test fixture did not become ready");
}

describe("ProductionTuiLauncher terminal ownership", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("wrapper exit starts single-flight cleanup and exited waits for the whole group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "production-tui-group-"));
    dirs.push(dir);
    const binary = executable(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    const observation = join(dir, "launcher-descendant.json");
    const wrapper = executable(
      join(dir, "fake-pty.cjs"),
      `#!/usr/bin/env bun
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const ready = join(process.env.TMPDIR, "launcher-descendant.ready");
const observation = join(process.env.TMPDIR, "launcher-descendant.json");
const descendantSource = \`
  const { writeFileSync } = require("node:fs");
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  writeFileSync(\${JSON.stringify(ready)}, "ready");
  setInterval(() => {}, 1000);
\`;
const descendant = spawn(process.execPath, ["-e", descendantSource], {
  detached: false,
  env: process.env,
  stdio: "ignore",
});
descendant.unref();
const deadline = Date.now() + 1000;
const timer = setInterval(() => {
  if (existsSync(ready)) {
    clearInterval(timer);
    writeFileSync(observation, JSON.stringify({
      leaderPid: process.pid,
      descendantPid: descendant.pid,
      groupId: process.pid,
    }));
    setTimeout(() => process.exit(0), 25);
  } else if (Date.now() >= deadline) {
    process.exit(91);
  }
}, 10);
`,
    );
    const identity = resolveCodexBinaryIdentity(binary);
    const env = buildAllowlistEnv("test-bearer", {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: dir,
      TMPDIR: dir,
      CODEX_HOME: dir,
    });
    const launcher = new ProductionTuiLauncher({
      binary: "ignored-when-identity-is-supplied",
      identity,
      ptyBinary: wrapper,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(Object.getPrototypeOf(launcher.exited)).toBe(Promise.prototype);
    expect(Object.prototype.hasOwnProperty.call(launcher.exited, "constructor")).toBe(false);

    await launcher.launch({ wsUrl: "ws://127.0.0.1:43123", env });
    await waitForFile(observation);
    const observed = JSON.parse(readFileSync(observation, "utf8")) as {
      leaderPid: number;
      descendantPid: number;
      groupId: number;
    };
    expect(observed.groupId).toBe(observed.leaderPid);
    expect(__test.groupExists(observed.groupId)).toBe(true);

    // Let the wrapper leader exit naturally. Its same-group descendant keeps
    // the ownership fence open until the launcher's bounded TERM/KILL path.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const terminate = launcher.terminate();
    expect(Object.getPrototypeOf(terminate)).toBe(Promise.prototype);
    await Promise.all([launcher.exited, terminate]);
    expect(__test.groupExists(observed.groupId)).toBe(false);
  }, 5_000);

  test("provider identity replacement is refused before the PTY wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "production-tui-identity-RAW_PATH-"));
    dirs.push(dir);
    const binary = executable(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    const identity = resolveCodexBinaryIdentity(binary);
    renameSync(binary, join(dir, "original-kept-alive"));
    executable(binary, "#!/bin/sh\nexit 9\n");
    const marker = join(dir, "pty-must-not-run");
    const wrapper = executable(
      join(dir, "marker-pty.sh"),
      `#!/bin/sh\nprintf ran > '${marker}'\n`,
    );
    const launcher = new ProductionTuiLauncher({ identity, ptyBinary: wrapper });
    const env = buildAllowlistEnv("test-bearer", {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    });

    let observed: Error | null = null;
    try {
      await launcher.launch({ wsUrl: "ws://127.0.0.1:43124", env });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      CODEX_BINARY_IDENTITY_MISMATCH,
    );
    expect(observed?.message).toBe(CODEX_BINARY_IDENTITY_MISMATCH);
    expect(observed?.message).not.toContain(dir);
    expect(observed?.message).not.toContain("RAW_PATH");
    expect(existsSync(marker)).toBe(false);
    await launcher.terminate();
  });
});
