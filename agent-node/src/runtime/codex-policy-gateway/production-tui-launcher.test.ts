import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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

  test("distinct PTY payload group is stopped before its live wrapper reaps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "production-tui-group-"));
    dirs.push(dir);
    const binary = executable(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    const observation = join(dir, "launcher-descendant.json");
    const descendantSource = `
const { readFileSync, readSync, writeFileSync, writeSync } = require("node:fs");
writeSync(3, readFileSync("/proc/" + process.pid + "/stat", "utf8") + "\\n");
const ack = Buffer.alloc(3);
const ackBytes = readSync(4, ack, 0, ack.length, null);
if (ackBytes !== 3 || ack.toString("utf8") !== "go\\n") process.exit(125);
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
writeFileSync(${JSON.stringify(join(dir, "launcher-descendant.ready"))}, "ready");
setInterval(() => {}, 1000);
`;
    const wrapper = executable(
      join(dir, "fake-pty.cjs"),
      `#!/usr/bin/env bun
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, writeSync } = require("node:fs");
function proc(pid) {
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  const tail = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\\s+/);
  return { raw, pid, ppid: Number(tail[1]), pgid: Number(tail[2]), sid: Number(tail[3]), startTime: tail[19] };
}
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  detached: true,
  env: process.env,
  stdio: ["ignore", "ignore", "ignore", 3, 4],
});
const wrapper = proc(process.pid);
const payload = proc(descendant.pid);
writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ wrapper, payload }));
descendant.once("exit", () => process.exit(0));
setInterval(() => {}, 1000);
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
    const fixtureGroups: number[] = [];
    let fixtureComplete = false;
    try {
      expect(Object.getPrototypeOf(launcher.exited)).toBe(Promise.prototype);
      expect(Object.prototype.hasOwnProperty.call(launcher.exited, "constructor")).toBe(false);

      const launching = launcher.launch({ wsUrl: "ws://127.0.0.1:43123", env });
      expect(Object.getPrototypeOf(launching)).toBe(Promise.prototype);
      expect(Object.prototype.hasOwnProperty.call(launching, "constructor")).toBe(false);
      await launching;
      await waitForFile(observation);
      const observed = JSON.parse(readFileSync(observation, "utf8")) as {
        wrapper: { pid: number; ppid: number; pgid: number; sid: number; startTime: string };
        payload: { pid: number; ppid: number; pgid: number; sid: number; startTime: string };
      };
      fixtureGroups.push(observed.payload.pgid, observed.wrapper.pgid);
      expect(observed.wrapper.pgid).toBe(observed.wrapper.pid);
      expect(observed.payload.pgid).toBe(observed.payload.pid);
      expect(observed.payload.sid).toBe(observed.payload.pid);
      expect(observed.wrapper.pgid).not.toBe(observed.payload.pgid);
      expect(observed.payload.ppid).toBe(observed.wrapper.pid);
      expect(__test.groupExists(observed.wrapper.pgid)).toBe(true);
      expect(__test.groupExists(observed.payload.pgid)).toBe(true);

      expect(__test.sameProcessIdentity(observed.payload, observed.payload)).toBe(true);
      expect(__test.sameProcessIdentity(
        observed.payload,
        { ...observed.payload, startTime: `${observed.payload.startTime}0` },
      )).toBe(false);
      expect(__test.sameOwnedGroupMember(
        observed.payload,
        { ...observed.payload, pgid: observed.wrapper.pgid },
        { pgid: observed.payload.pgid, sid: observed.payload.sid },
      )).toBe(false);

      // The payload ignores TERM and is in a different session/group. The
      // launcher must KILL it first and let the still-live wrapper reap it.
      const terminate = launcher.terminate();
      expect(Object.getPrototypeOf(terminate)).toBe(Promise.prototype);
      expect(launcher.terminate()).toBe(terminate);
      await Promise.all([launcher.exited, terminate]);
      expect(__test.groupExists(observed.payload.pgid)).toBe(false);
      expect(__test.groupExists(observed.wrapper.pgid)).toBe(false);
      fixtureComplete = true;
    } finally {
      if (!fixtureComplete && fixtureGroups.length === 0 && existsSync(observation)) {
        try {
          const observed = JSON.parse(readFileSync(observation, "utf8")) as {
            wrapper?: { pgid?: number };
            payload?: { pgid?: number };
          };
          for (const pgid of [observed.payload?.pgid, observed.wrapper?.pgid]) {
            if (Number.isSafeInteger(pgid) && (pgid as number) > 1) {
              fixtureGroups.push(pgid as number);
            }
          }
        } catch {
          // The fixture may have failed before its atomic-sized JSON write.
        }
      }
      for (const pgid of fixtureComplete ? [] : fixtureGroups) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  }, 5_000);

  test("non-descendant ownership handshake is refused without signaling that group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "production-tui-foreign-RAW_PATH-"));
    dirs.push(dir);
    const binary = executable(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    const foreign = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ], {
      detached: true,
      stdio: "ignore",
    });
    if (foreign.pid === undefined) throw new Error("foreign fixture did not spawn");

    try {
      const wrapper = executable(
        join(dir, "lying-pty.cjs"),
        `#!/usr/bin/env bun
const { readFileSync, writeSync } = require("node:fs");
writeSync(3, readFileSync("/proc/${foreign.pid}/stat", "utf8") + "\\n");
setInterval(() => {}, 1000);
`,
      );
      const launcher = new ProductionTuiLauncher({
        binary,
        ptyBinary: wrapper,
        writeStdout: () => {},
        writeStderr: () => {},
      });
      const env = buildAllowlistEnv("test-bearer", {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: dir,
        TMPDIR: dir,
        CODEX_HOME: dir,
      });

      let observed: (Error & { code?: string }) | null = null;
      try {
        await launcher.launch({ wsUrl: "ws://127.0.0.1:43125", env });
      } catch (error) {
        observed = error as Error & { code?: string };
      }
      expect(observed?.code).toBe("tui_codex_identity_not_descendant");
      expect(observed?.message).toBe(
        "codex TUI launcher failed (tui_codex_identity_not_descendant)",
      );
      expect(observed?.message).not.toContain(dir);
      expect(observed?.message).not.toContain("RAW_PATH");
      let terminalError: (Error & { code?: string }) | null = null;
      try {
        await launcher.exited;
      } catch (error) {
        terminalError = error as Error & { code?: string };
      }
      expect(terminalError?.code).toBe("tui_codex_identity_not_descendant");

      const foreignIdentity = __test.readLinuxProcessIdentity(foreign.pid);
      expect(foreignIdentity?.pid).toBe(foreign.pid);
      expect(__test.groupExists(foreign.pid)).toBe(true);
    } finally {
      try {
        process.kill(-foreign.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await new Promise<void>((resolve) => {
        if (foreign.exitCode !== null || foreign.signalCode !== null) resolve();
        else foreign.once("exit", () => resolve());
      });
    }
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
