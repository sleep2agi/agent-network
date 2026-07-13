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

    expect(existsSync(`/proc/${identity.pid}`)).toBe(false);
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

  test("revalidates the exact identity before escalating a TERM-resistant Leader", async () => {
    const fixture = await startLeader(false, true);
    const identity = await capture(fixture);

    await terminateOwnedGrokLeader(identity, 500);

    expect(existsSync(`/proc/${identity.pid}`)).toBe(false);
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
