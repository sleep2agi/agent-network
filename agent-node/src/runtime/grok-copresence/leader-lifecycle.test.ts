import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  captureOwnedGrokLeader,
  assertGrokLeaderCommandIdentity,
  processGenerationGone,
  terminateOwnedGrokLeader,
  type OwnedGrokLeaderIdentity,
} from "./leader-lifecycle";

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const nativeChildren: ChildProcess[] = [];
const descendantPids: number[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
  }
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([child.exited.catch(() => undefined), Bun.sleep(300)]);
  }
  for (const child of nativeChildren.splice(0)) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      Bun.sleep(300),
    ]);
  }
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Grok auto-Leader lifecycle identity", () => {
  test("rejects a different kernel executable hidden behind a pinned argv0", () => {
    const pinned = realpathSync("/bin/true");
    const other = realpathSync("/bin/sh");
    const argv = [pinned, "agent", "leader", "--no-exit-on-disconnect", "--relay-on-demand"];
    expect(() => assertGrokLeaderCommandIdentity(argv, pinned, pinned)).not.toThrow();
    expect(() => assertGrokLeaderCommandIdentity(argv, pinned, other)).toThrow(
      "kernel executable differs",
    );
  });

  test("rejects a live native listener whose argv0 forges the pinned executable", async () => {
    const fixture = await startForgedNativeLeader();
    await expect(captureOwnedGrokLeader({
      generation: 1,
      binary: fixture.configuredBinary,
      binaryPathEnv: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      leaderSocket: fixture.socket,
      grokHome: fixture.home,
      sandboxProfile: "workspace",
      ownerNonce: fixture.nonce,
      expectedParentPid: String(process.pid),
      timeoutMs: 100,
    })).rejects.toThrow("kernel executable differs");
    expect(existsSync(`/proc/${fixture.child.pid}`)).toBe(true);
  });

  test("terminates one exact generation and removes only its stale socket", async () => {
    const fixture = await startLeader();
    const identity = await capture(fixture);
    expect(identity.pid).toBe(fixture.child.pid);
    expect(existsSync(fixture.socket)).toBe(true);

    await terminateOwnedGrokLeader(identity);

    // 语义是「这一代进程没了」,不是「/proc 目录没了」—— 用与产品同一个谓词。
    // SIGTERM 之后到父进程 reap 之前进程处于 Z,`/proc` 条目仍在(#1315)。
    // 这条的 fixture 不是 TERM-resistant,但窗口与是否升级 SIGKILL 无关:
    // 任何被 fork 的子进程退出后、父进程 wait 之前都是 Z。
    expect(await waitGenerationGone(identity)).toBe(true);
    expect(existsSync(fixture.socket)).toBe(false);
  });

  test("does not adopt a listener whose generation marker differs", async () => {
    const fixture = await startLeader();
    await expect(captureOwnedGrokLeader({
      ...captureOptions(fixture),
      ownerNonce: "22222222-2222-4222-8222-222222222222",
      timeoutMs: 100,
    })).rejects.toThrow("environment identity mismatch");
    expect(existsSync(`/proc/${fixture.child.pid}`)).toBe(true);
  });

  test("does not signal or unlink after the socket pathname is replaced", async () => {
    const fixture = await startLeader();
    const identity = await capture(fixture);
    unlinkSync(fixture.socket);
    const replacement = createServer((client) => client.destroy());
    servers.push(replacement);
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(fixture.socket, resolve);
    });

    await expect(terminateOwnedGrokLeader(identity, 200)).rejects.toThrow("identity changed");
    expect(existsSync(`/proc/${fixture.child.pid}`)).toBe(true);
    expect(existsSync(fixture.socket)).toBe(true);
  });

  /** Poll until the exact generation is gone, or the bound elapses.
   *
   * 🔴 Asserting `!existsSync(/proc/<pid>)` is wrong here: between SIGKILL
   * landing and the parent reaping, the process is in state `Z` and its
   * `/proc` entry still exists. `processGenerationGone` excludes `Z`/`X`, so
   * it is the same question the product itself answers (#1315).
   *
   * The bound is generous on purpose — polling returns as soon as the
   * condition holds, so a wide ceiling costs nothing when things are fast,
   * and does not turn a slow machine into a false failure.
   */
  async function waitGenerationGone(id: { pid: number; startTime: string }, boundMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + boundMs;
    while (Date.now() < deadline) {
      if (processGenerationGone(id.pid, id.startTime)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return processGenerationGone(id.pid, id.startTime);
  }

  // 🔴 This test pins the bug behind #1315 permanently: if anyone ever swaps
  // processGenerationGone back for an `existsSync(/proc/<pid>)` existence
  // check, this goes red. It asserts the two DISAGREE on a zombie — which is
  // precisely the window that made the escalation test intermittently fail.
  test("processGenerationGone reports a zombie as gone while /proc still exists", async () => {
    // A child that exits while its parent never waits stays in state Z.
    //
    // 🔴 A shell CANNOT be used to build this: measured on this host, dash,
    // bash and `setsid bash` all reap the background job before the next
    // command runs, so `/proc/<pid>` is gone entirely rather than showing Z.
    // A bare `fork()` whose parent never waits is the only form that holds —
    // hence python3 (present in the agent-node test image).
    const holder = spawn(
      "python3",
      ["-c", "import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      const zombiePid = await new Promise<number>((resolve, reject) => {
        holder.stdout!.once("data", (d) => resolve(Number(String(d).trim())));
        holder.once("error", reject);
      });
      // give the child time to exit and become a zombie
      let state = "";
      let startTime = "";
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const raw = readFileSync(`/proc/${zombiePid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
        state = fields[0] || "";
        startTime = fields[19] || "";
        if (state === "Z") break;
      }
      expect(state).toBe("Z");

      // the existence check the test used to rely on: still true
      expect(existsSync(`/proc/${zombiePid}`)).toBe(true);
      // the predicate the product actually uses: already "gone"
      expect(processGenerationGone(zombiePid, startTime)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("revalidates the exact identity before escalating a TERM-resistant Leader", async () => {
    const fixture = await startLeader(false, true);
    const identity = await capture(fixture);

    await terminateOwnedGrokLeader(identity, 500);

    // Assert the CONDITION, not the clock. On timeout this still reports the
    // predicate's value, so a failure reads "still not reaped after the bound"
    // rather than "the sleep was too short".
    expect(await waitGenerationGone(identity)).toBe(true);
    expect(existsSync(fixture.socket)).toBe(false);
  });

  test("does not escalate when a TERM-resistant Leader replaces its listener", async () => {
    const fixture = await startLeader(false, true, true);
    const identity = await capture(fixture);

    await expect(terminateOwnedGrokLeader(identity, 300)).rejects.toThrow("identity changed");
    expect(existsSync(`/proc/${identity.pid}`)).toBe(true);
    const replacementPidFile = join(fixture.root, "replacement.pid");
    await waitFor(() => existsSync(replacementPidFile));
    const replacementPid = Number(readFileSync(replacementPidFile, "utf8"));
    descendantPids.push(replacementPid);
    expect(existsSync(`/proc/${replacementPid}`)).toBe(true);
  });

  test("does not signal after the configured binary inode is replaced", async () => {
    const fixture = await startLeader();
    const identity = await capture(fixture);
    const replacement = `${fixture.binary}.replacement`;
    writeFileSync(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(replacement, 0o700);
    renameSync(replacement, fixture.binary);

    await expect(terminateOwnedGrokLeader(identity, 100)).rejects.toThrow(
      "configured Grok binary identity changed",
    );
    expect(existsSync(`/proc/${identity.pid}`)).toBe(true);
    expect(existsSync(fixture.socket)).toBe(true);
  });

  test("retains the stale socket when another process from the generation remains", async () => {
    const fixture = await startLeader(true);
    const identity = await capture(fixture);

    await expect(terminateOwnedGrokLeader(identity, 200)).rejects.toThrow(
      "generation still has live processes",
    );
    expect(existsSync(fixture.socket)).toBe(true);
  });
});

interface LeaderFixture {
  root: string;
  home: string;
  socket: string;
  binary: string;
  nonce: string;
  child: ReturnType<typeof Bun.spawn>;
}

async function startForgedNativeLeader(): Promise<{
  root: string;
  home: string;
  socket: string;
  configuredBinary: string;
  nonce: string;
  child: ChildProcess & { pid: number };
}> {
  const root = mkdtempSync(join(tmpdir(), "grok-leader-native-forgery-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "run");
  const socket = join(runtime, "leader.sock");
  const source = join(root, "listener.c");
  const executable = join(root, "listener");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  writeFileSync(source, [
    "#include <sys/socket.h>",
    "#include <sys/un.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "#include <unistd.h>",
    "int main(void) {",
    "  const char *path = getenv(\"GROK_LEADER_SOCKET\");",
    "  int fd = socket(AF_UNIX, SOCK_STREAM, 0);",
    "  struct sockaddr_un addr; memset(&addr, 0, sizeof(addr));",
    "  addr.sun_family = AF_UNIX; strncpy(addr.sun_path, path, sizeof(addr.sun_path)-1);",
    "  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) || listen(fd, 4)) return 2;",
    "  for (;;) pause();",
    "}",
    "",
  ].join("\n"), { mode: 0o600 });
  const compiled = spawnSync("cc", ["-O2", "-o", executable, source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (compiled.status !== 0) throw new Error("native lifecycle fixture compilation failed");
  const configuredBinary = realpathSync("/bin/true");
  const nonce = "33333333-3333-4333-8333-333333333333";
  const spawned = spawn(executable, [
    "agent",
    "leader",
    "--no-exit-on-disconnect",
    "--relay-on-demand",
  ], {
    argv0: configuredBinary,
    cwd: root,
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      GROK_HOME: home,
      GROK_SANDBOX: "workspace",
      GROK_LEADER_SOCKET: socket,
      GROK_CHANGELOG_OFFLINE: "1",
      GROK_LEADER_LOG: "off",
      ANET_GROK_LEADER_OWNER: nonce,
      ANET_EXPECTED_PARENT_PID: String(process.pid),
    },
    stdio: "ignore",
  });
  if (!spawned.pid) throw new Error("native lifecycle fixture did not start");
  const child = spawned as ChildProcess & { pid: number };
  nativeChildren.push(child);
  await waitFor(() => existsSync(socket));
  return { root, home, socket, configuredBinary, nonce, child };
}

async function startLeader(
  spawnDescendant = false,
  ignoreTerm = false,
  replaceListenerOnTerm = false,
): Promise<LeaderFixture> {
  const root = mkdtempSync(join(tmpdir(), "grok-leader-lifecycle-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "run");
  const socket = join(runtime, "leader.sock");
  const binary = join(root, "grok-fixture.mjs");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  writeFileSync(binary, [
    'import fs from "node:fs";',
    'import net from "node:net";',
    'import { spawn } from "node:child_process";',
    'const socket = process.env.GROK_LEADER_SOCKET;',
    'if (process.env.ANET_FIXTURE_DESCENDANT === "1") {',
    '  const childEnv = {...process.env};',
    '  delete childEnv.ANET_GROK_LEADER_OWNER;',
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
    '    {env: childEnv, detached: true, stdio: "ignore"});',
    '  fs.writeFileSync(process.env.ANET_FIXTURE_DESCENDANT_PID, String(child.pid), {mode: 0o600});',
    '  child.unref();',
    '}',
    'const server = net.createServer((client) => client.destroy());',
    'server.listen(socket, () => { try { fs.chmodSync(socket, 0o600); } catch {} });',
    'process.on("SIGTERM", () => {',
    '  if (process.env.ANET_FIXTURE_TERM_DRIFT === "1") {',
    '    try { fs.unlinkSync(socket); } catch {}',
    '    const replacementEnv = {...process.env, ANET_FIXTURE_TERM_DRIFT: "0"};',
    '    const replacement = spawn(process.execPath, [process.argv[1], "agent", "leader",',
    '      "--no-exit-on-disconnect", "--relay-on-demand"],',
    '      {env: replacementEnv, detached: true, stdio: "ignore"});',
    '    fs.writeFileSync(process.env.ANET_FIXTURE_REPLACEMENT_PID, String(replacement.pid), {mode: 0o600});',
    '    replacement.unref();',
    '    return;',
    '  }',
    '  if (process.env.ANET_FIXTURE_IGNORE_TERM !== "1") process.exit(0);',
    '});',
    'setInterval(() => {}, 1000);',
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(binary, 0o700);
  const nonce = "11111111-1111-4111-8111-111111111111";
  const descendantPidFile = join(root, "descendant.pid");
  const child = Bun.spawn([
    process.execPath,
    binary,
    "agent",
    "leader",
    "--no-exit-on-disconnect",
    "--relay-on-demand",
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      GROK_HOME: home,
      GROK_SANDBOX: "workspace",
      GROK_LEADER_SOCKET: socket,
      GROK_CHANGELOG_OFFLINE: "1",
      GROK_LEADER_LOG: "off",
      ANET_GROK_LEADER_OWNER: nonce,
      ANET_EXPECTED_PARENT_PID: String(process.pid),
      ANET_FIXTURE_DESCENDANT: spawnDescendant ? "1" : "0",
      ANET_FIXTURE_IGNORE_TERM: ignoreTerm ? "1" : "0",
      ANET_FIXTURE_TERM_DRIFT: replaceListenerOnTerm ? "1" : "0",
      ANET_FIXTURE_REPLACEMENT_PID: join(root, "replacement.pid"),
      ANET_FIXTURE_DESCENDANT_PID: descendantPidFile,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  await waitFor(() => existsSync(socket));
  if (spawnDescendant) {
    await waitFor(() => existsSync(descendantPidFile));
    descendantPids.push(Number(readFileSync(descendantPidFile, "utf8")));
  }
  return { root, home, socket, binary, nonce, child };
}

function captureOptions(fixture: LeaderFixture) {
  return {
    generation: 1,
    binary: fixture.binary,
    binaryPathEnv: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    leaderSocket: fixture.socket,
    grokHome: fixture.home,
    sandboxProfile: "workspace",
    ownerNonce: fixture.nonce,
    expectedParentPid: String(process.pid),
    timeoutMs: 1_000,
  };
}

function capture(fixture: LeaderFixture): Promise<OwnedGrokLeaderIdentity> {
  return captureOwnedGrokLeader(captureOptions(fixture));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("fixture condition timed out");
}
