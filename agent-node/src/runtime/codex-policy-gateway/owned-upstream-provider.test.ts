import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNED_CODEX_ENV_ALLOWLIST,
  __test,
  spawnOwnedCodexUpstream,
} from "./owned-upstream-provider";

function expectBaseNativePromise(value: Promise<unknown>): void {
  expect(Object.getPrototypeOf(value)).toBe(Promise.prototype);
  expect(Object.prototype.hasOwnProperty.call(value, "constructor")).toBe(false);
}

function fakeCodex(dir: string, ignoreTerm = false, orphanDescendant = false): string {
  const path = join(dir, "fake-codex.cjs");
  const source = `#!/usr/bin/env bun
const net = require("node:net");
const fs = require("node:fs");
const childProcess = require("node:child_process");
if (process.argv[2] === "--same-group-descendant") {
  const url = new URL(process.argv[3]);
  fs.writeFileSync(process.env.TMPDIR + "/owned-provider-descendant.json", JSON.stringify({
    pid: process.pid,
    groupId: process.ppid,
  }));
  const childServer = net.createServer((socket) => socket.destroy());
  childServer.listen(Number(url.port), url.hostname);
  process.on("SIGTERM", () => {});
  return;
}
const args = process.argv.slice(2);
const listenAt = args.indexOf("--listen");
if (listenAt < 0) process.exit(31);
const url = new URL(args[listenAt + 1]);
if (process.env.TMPDIR) {
  fs.writeFileSync(process.env.TMPDIR + "/owned-provider-observation.json", JSON.stringify({
    args,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
  }));
}
const server = net.createServer((socket) => socket.destroy());
${orphanDescendant
    ? `const descendant = childProcess.spawn(process.execPath, [__filename, "--same-group-descendant", url.href], {
  detached: false,
  env: process.env,
  stdio: "ignore",
});
descendant.unref();
setTimeout(() => process.exit(0), 75);`
    : "server.listen(Number(url.port), url.hostname);"}
${ignoreTerm
    ? "process.on(\"SIGTERM\", () => {});"
    : "process.on(\"SIGTERM\", () => server.close(() => process.exit(0)));"}
`;
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe("spawnOwnedCodexUpstream", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("pins approval=never/read-only and projects an exact four-key environment", () => {
    const args = __test.buildOwnedCodexArgs("ws://127.0.0.1:24567");
    expect(args).toEqual([
      "app-server",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=read-only",
      "--listen",
      "ws://127.0.0.1:24567",
    ]);

    const env = __test.buildOwnedCodexEnv({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      CODEX_HOME: "/safe/codex",
      COMMHUB_TOKEN: "ntok_RAW_SECRET",
      RANDOM_SECRET: "RAW_SECRET",
    });
    expect(Object.keys(env).sort()).toEqual([...OWNED_CODEX_ENV_ALLOWLIST].sort());
    expect(env.COMMHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();

    const smuggled = __test.buildOwnedCodexEnv({ HOME: "/x/atok_RAW_SECRET" });
    expect(smuggled.HOME).toBeUndefined();
  });

  test("real spawn boundary and bounded graceful process-group teardown use base Promises", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-provider-test-"));
    dirs.push(dir);
    const binary = fakeCodex(dir);
    const logs: string[] = [];
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];

    const spawnPromise = spawnOwnedCodexUpstream({
      binary: "fake-codex.cjs",
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        TMPDIR: dir,
        HOME: "/safe/home",
        LEAK_ME: "RAW_ENV_SECRET",
      },
      baselineGate: async () => {},
      startupTimeoutMs: 2_000,
      termTimeoutMs: 250,
      killTimeoutMs: 250,
      log: (message) => logs.push(message),
      onExit: (info) => exits.push(info),
    });
    expectBaseNativePromise(spawnPromise);
    const owned = await spawnPromise;
    expect(owned.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(owned.identity.path).toBe(realpathSync(binary));
    expect(owned.identity.dev).toMatch(/^\d+$/);
    expect(owned.identity.ino).toMatch(/^\d+$/);
    expect(Object.isFrozen(owned.identity)).toBe(true);

    const observation = JSON.parse(
      readFileSync(join(dir, "owned-provider-observation.json"), "utf8"),
    ) as { args: string[]; cwd: string; envKeys: string[] };
    expect(observation.args).toEqual(__test.buildOwnedCodexArgs(owned.url));
    expect(observation.cwd).toBe(realpathSync(dir));
    expect(observation.envKeys).toEqual(["HOME", "PATH", "TMPDIR"]);

    const shutdownPromise = owned.shutdown();
    expectBaseNativePromise(shutdownPromise);
    await shutdownPromise;
    expect(exits).toHaveLength(1);
    for (const line of logs) {
      expect(line).toMatch(/^code=[a-z_]+ correlation=provider-\d+$/);
      expect(line).not.toContain("RAW_");
    }
  }, 5_000);

  test("abort sends process-group KILL and is bounded below final A's outer timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-provider-abort-test-"));
    dirs.push(dir);
    const owned = await spawnOwnedCodexUpstream({
      binary: fakeCodex(dir, true),
      env: { PATH: process.env.PATH, TMPDIR: dir },
      baselineGate: async () => {},
      startupTimeoutMs: 2_000,
      killTimeoutMs: 250,
    });
    const started = Date.now();
    const abortPromise = owned.abort();
    expectBaseNativePromise(abortPromise);
    await abortPromise;
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 5_000);

  test("abort kills a same-group descendant after the process-group leader already exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-provider-descendant-test-"));
    dirs.push(dir);
    const owned = await spawnOwnedCodexUpstream({
      binary: fakeCodex(dir, true, true),
      env: { PATH: process.env.PATH, TMPDIR: dir },
      baselineGate: async () => {},
      startupTimeoutMs: 2_000,
      killTimeoutMs: 300,
    });
    const observationPath = join(dir, "owned-provider-descendant.json");
    let observation: { pid: number; groupId: number } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        observation = JSON.parse(readFileSync(observationPath, "utf8"));
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(observation).not.toBeNull();
    // Wait until the provider has observed the leader's scheduled exit while
    // the descendant keeps the original process group alive.
    await new Promise<void>((resolve) => setTimeout(resolve, 125));
    expect(__test.groupExists(observation!.groupId)).toBe(true);
    await owned.abort();
    expect(__test.groupExists(observation!.groupId)).toBe(false);
  }, 5_000);

  test("baseline rejection is stable, happens before spawn, and is not rendered to logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-provider-gate-test-"));
    dirs.push(dir);
    const binary = fakeCodex(dir);
    const logs: string[] = [];
    const failure = new Error("RAW_BASELINE_SECRET");

    let observed: Error | null = null;
    try {
      await spawnOwnedCodexUpstream({
        binary,
        env: { PATH: process.env.PATH, TMPDIR: dir },
        baselineGate: async () => {
          throw failure;
        },
        log: (message) => logs.push(message),
      });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      "owned_upstream_baseline_failed",
    );
    expect(observed?.message).not.toContain("RAW_BASELINE_SECRET");
    expect(observed?.message).not.toContain(binary);
    expect(logs).toEqual(["code=owned_upstream_gate_begin correlation=provider-1"]);
    expect(() => readFileSync(join(dir, "owned-provider-observation.json"))).toThrow();
  });

  test("binary identity replacement after the gate is refused before spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-provider-identity-test-"));
    dirs.push(dir);
    const binary = fakeCodex(dir);

    let observed: Error | null = null;
    try {
      await spawnOwnedCodexUpstream({
        binary,
        env: { PATH: process.env.PATH, TMPDIR: dir },
        baselineGate: async (canonicalPath) => {
          expect(canonicalPath).toBe(realpathSync(binary));
          renameSync(binary, join(dir, "original-kept-alive"));
          fakeCodex(dir);
        },
      });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      "owned_upstream_binary_identity_failed",
    );
    expect(observed?.message).not.toContain(binary);
    expect(() => readFileSync(join(dir, "owned-provider-observation.json"))).toThrow();
  });
});
