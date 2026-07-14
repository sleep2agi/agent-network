import {
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "fs";
import { isAbsolute, delimiter, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";

const LEADER_OWNER_ENV = "ANET_GROK_LEADER_OWNER";
const LISTENER_FLAGS = "00010000";
const STREAM_SOCKET_TYPE = "0001";
const LISTENING_STATE = "01";

interface FileIdentity {
  dev: string;
  ino: string;
  uid: number;
}

interface ExecutableIdentity extends FileIdentity {
  path: string;
}

export interface OwnedGrokLeaderIdentity {
  generation: number;
  pid: number;
  startTime: string;
  executable: ExecutableIdentity;
  configuredBinary: string;
  configuredBinaryFile: FileIdentity;
  socket: FileIdentity;
  listenerInode: string;
  leaderSocket: string;
  grokHome: string;
  sandboxProfile: string;
  ownerNonce: string;
  expectedParentPid: string;
}

export interface CaptureOwnedGrokLeaderOptions {
  generation: number;
  binary: string;
  binaryPathEnv: string;
  leaderSocket: string;
  grokHome: string;
  sandboxProfile: string;
  ownerNonce: string;
  expectedParentPid: string;
  timeoutMs?: number;
}

/**
 * Bind one auto-spawned Grok Leader to this PTY generation.
 *
 * Grok 0.2.93 does not put the socket path in the Leader argv. The binding is
 * therefore deliberately conjunctive: exact filesystem socket identity,
 * exact LISTEN kernel inode, unique fd holder, process generation, pinned
 * executable/argv, and a runtime-generated environment marker all have to
 * agree. A partial match is never adopted.
 */
export async function captureOwnedGrokLeader(
  opts: CaptureOwnedGrokLeaderOptions,
): Promise<OwnedGrokLeaderIdentity> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return inspectOwnedGrokLeader(opts);
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw new Error(`could not bind the Grok Leader to this TUI generation: ${errorMessage(lastError)}`);
}

/**
 * Stop only the exact Leader captured above, then remove only its unchanged
 * stale socket pathname. Any identity drift keeps the caller's lifetime locks
 * held and leaves the path untouched.
 */
export async function terminateOwnedGrokLeader(
  identity: OwnedGrokLeaderIdentity,
  timeoutMs = 2_000,
): Promise<void> {
  if (sameProcessGenerationExists(identity.pid, identity.startTime)) {
    assertIdentityStillOwnsListener(identity);
    // See the pidfd limitation below. The full revalidation makes accidental
    // drift fail closed, but it is not advertised as a same-UID hard boundary.
    const termSent = signalProcess(identity.pid, "SIGTERM");
    if (termSent && !await waitForProcessGenerationGone(identity.pid, identity.startTime, timeoutMs)) {
      // Re-run the complete binding immediately before escalation rather than
      // assuming a retained numeric PID is still ours. Node has no public
      // pidfd_send_signal API, so preview still has a syscall-sized numeric
      // PID race against a same-UID actor; same-UID process control is outside
      // this runtime's documented isolation boundary. A stronger same-UID
      // guarantee would require pidfd or an equivalently atomic supervisor.
      assertIdentityStillOwnsListener(identity);
      const killSent = signalProcess(identity.pid, "SIGKILL");
      if (killSent && !await waitForProcessGenerationGone(identity.pid, identity.startTime, timeoutMs)) {
        throw new Error(`owned Grok Leader pid ${identity.pid} did not exit after SIGKILL`);
      }
    }
  }

  await waitForListenerGone(identity, timeoutMs);
  await waitForOwnerGenerationGone(identity, timeoutMs);
  removeUnchangedStaleSocket(identity);
}

export function grokLeaderOwnerEnvironmentKey(): string {
  return LEADER_OWNER_ENV;
}

/** @internal Exported only so the native-executable binding has a mutation test. */
export function assertGrokLeaderCommandIdentity(
  argv: readonly string[],
  configuredBinary: string,
  executablePath: string,
): void {
  const binaryIndex = argv.findIndex((value, index) => index <= 1 && sameRealPath(value, configuredBinary));
  if (binaryIndex < 0 || argv[binaryIndex + 1] !== "agent" || argv[binaryIndex + 2] !== "leader") {
    throw new Error("Grok Leader argv does not identify the pinned agent leader process");
  }
  // The production pin is a native ELF and must be the kernel executable,
  // not merely an attacker-controlled argv[0] string. Index 1 is retained
  // only for executable script fixtures, whose inode is bound separately.
  if (binaryIndex === 0 && executablePath !== configuredBinary) {
    throw new Error("Grok Leader kernel executable differs from the pinned binary");
  }
  const leaderArgs = argv.slice(binaryIndex + 3);
  if (!leaderArgs.includes("--no-exit-on-disconnect") || !leaderArgs.includes("--relay-on-demand")) {
    throw new Error("Grok Leader argv is missing its persistent shared-backend flags");
  }
}

function inspectOwnedGrokLeader(
  opts: CaptureOwnedGrokLeaderOptions,
): OwnedGrokLeaderIdentity {
  validateNonce(opts.ownerNonce);
  const socket = readSocketFileIdentity(opts.leaderSocket);
  const listenerInode = uniqueListenerInode(opts.leaderSocket);
  const holders = listenerHolders(listenerInode);
  if (holders.length !== 1) {
    throw new Error(`Grok Leader listener has ${holders.length} process owners instead of one`);
  }
  const pid = holders[0];
  if (pid === process.pid) throw new Error("Grok Leader listener is unexpectedly owned by agent-node");
  const configuredBinary = resolveConfiguredBinary(opts.binary, opts.binaryPathEnv);
  const configuredBinaryFile = fileIdentity(statSync(configuredBinary));
  const processIdentity = readLeaderProcess(pid, configuredBinary, {
    leaderSocket: opts.leaderSocket,
    grokHome: opts.grokHome,
    sandboxProfile: opts.sandboxProfile,
    ownerNonce: opts.ownerNonce,
    expectedParentPid: opts.expectedParentPid,
  });
  const identity: OwnedGrokLeaderIdentity = {
    generation: opts.generation,
    pid,
    startTime: processIdentity.startTime,
    executable: processIdentity.executable,
    configuredBinary,
    configuredBinaryFile,
    socket,
    listenerInode,
    leaderSocket: opts.leaderSocket,
    grokHome: opts.grokHome,
    sandboxProfile: opts.sandboxProfile,
    ownerNonce: opts.ownerNonce,
    expectedParentPid: opts.expectedParentPid,
  };
  // The first pass joins several procfs views. Re-run the complete binding
  // before returning so an exit/rebind during capture cannot yield a mixed
  // identity assembled from two different processes.
  assertIdentityStillOwnsListener(identity);
  return identity;
}

function assertIdentityStillOwnsListener(identity: OwnedGrokLeaderIdentity): void {
  const currentSocket = readSocketFileIdentity(identity.leaderSocket);
  assertFileIdentity(currentSocket, identity.socket, "Grok Leader socket");
  const listenerInode = uniqueListenerInode(identity.leaderSocket);
  if (listenerInode !== identity.listenerInode) {
    throw new Error("Grok Leader listener inode changed before termination");
  }
  const holders = listenerHolders(listenerInode);
  if (holders.length !== 1 || holders[0] !== identity.pid) {
    throw new Error("Grok Leader listener ownership changed before termination");
  }
  const current = readLeaderProcess(identity.pid, identity.configuredBinary, {
    leaderSocket: identity.leaderSocket,
    grokHome: identity.grokHome,
    sandboxProfile: identity.sandboxProfile,
    ownerNonce: identity.ownerNonce,
    expectedParentPid: identity.expectedParentPid,
  });
  if (current.startTime !== identity.startTime) {
    throw new Error("Grok Leader PID generation changed before termination");
  }
  assertFileIdentity(current.executable, identity.executable, "Grok Leader executable");
  if (current.executable.path !== identity.executable.path) {
    throw new Error("Grok Leader executable path changed before termination");
  }
  assertFileIdentity(
    fileIdentity(statSync(identity.configuredBinary)),
    identity.configuredBinaryFile,
    "configured Grok binary",
  );
}

function readLeaderProcess(
  pid: number,
  configuredBinary: string,
  expected: {
    leaderSocket: string;
    grokHome: string;
    sandboxProfile: string;
    ownerNonce: string;
    expectedParentPid: string;
  },
): { startTime: string; executable: ExecutableIdentity } {
  const proc = `/proc/${pid}`;
  const owner = lstatSync(proc).uid;
  const uid = process.getuid?.();
  if (uid !== undefined && owner !== uid) throw new Error("Grok Leader process owner mismatch");
  const processStat = readProcessStat(pid);
  if (processStat.state === "Z" || processStat.state === "X") {
    throw new Error("Grok Leader process is not live");
  }
  const startTime = processStat.startTime;
  const executablePath = realpathSync(join(proc, "exe"));
  const executableStat = statSync(join(proc, "exe"));
  const executable: ExecutableIdentity = {
    path: executablePath,
    dev: String(executableStat.dev),
    ino: String(executableStat.ino),
    uid: executableStat.uid,
  };
  const argv = readNulList(join(proc, "cmdline"));
  assertGrokLeaderCommandIdentity(argv, configuredBinary, executablePath);
  const env = readNulEnvironment(join(proc, "environ"));
  const required: Record<string, string> = {
    [LEADER_OWNER_ENV]: expected.ownerNonce,
    HOME: expected.grokHome,
    GROK_HOME: expected.grokHome,
    GROK_SANDBOX: expected.sandboxProfile,
    GROK_LEADER_SOCKET: expected.leaderSocket,
    GROK_LEADER_LOG: "/dev/null",
    ANET_EXPECTED_PARENT_PID: expected.expectedParentPid,
  };
  for (const [key, value] of Object.entries(required)) {
    if (env[key] !== value) throw new Error(`Grok Leader environment identity mismatch: ${key}`);
  }
  return { startTime, executable };
}

function uniqueListenerInode(socketPath: string): string {
  const listeners: string[] = [];
  const lines = readFileSync("/proc/net/unix", "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseUnixSocketRow(line);
    if (
      parsed.path === socketPath
      && parsed.flags === LISTENER_FLAGS
      && parsed.type === STREAM_SOCKET_TYPE
      && parsed.state === LISTENING_STATE
    ) {
      listeners.push(parsed.inode);
    }
  }
  const unique = [...new Set(listeners)];
  if (unique.length !== 1) {
    throw new Error(`Grok Leader socket has ${unique.length} listening inodes instead of one`);
  }
  return unique[0];
}

function parseUnixSocketRow(line: string): {
  flags: string;
  type: string;
  state: string;
  inode: string;
  path: string;
} {
  const match = line.match(/^\s*\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/);
  if (!match) throw new Error("malformed /proc/net/unix row");
  return {
    flags: match[1],
    type: match[2],
    state: match[3],
    inode: match[4],
    path: match[5] ?? "",
  };
}

function listenerHolders(inode: string): number[] {
  const target = `socket:[${inode}]`;
  const holders = new Set<number>();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
          holders.add(pid);
          break;
        }
      } catch {}
    }
  }
  return [...holders].sort((left, right) => left - right);
}

function readSocketFileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("Grok Leader path is not a real Unix socket");
  if (uid !== undefined && stat.uid !== uid) throw new Error("Grok Leader socket owner mismatch");
  return fileIdentity(stat);
}

function fileIdentity(stat: { dev: number | bigint; ino: number | bigint; uid: number }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid };
}

function readProcessStat(pid: number): { state: string; startTime: string } {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error("malformed process stat");
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0] || "";
  const startTime = fields[19];
  if (!/^[A-Z]$/.test(state) || !/^\d+$/.test(startTime || "")) {
    throw new Error("missing process state or start time");
  }
  return { state, startTime };
}

function readNulList(path: string): string[] {
  return readFileSync(path).toString("utf8").split("\0").filter(Boolean);
}

function readNulEnvironment(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of readNulList(path)) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("malformed process environment");
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

function resolveConfiguredBinary(binary: string, pathEnv: string): string {
  const candidates = isAbsolute(binary)
    ? [binary]
    : pathEnv.split(delimiter).filter(Boolean).map((directory) => resolve(directory, binary));
  for (const candidate of candidates) {
    try {
      if ((statSync(candidate).mode & constants.S_IXUSR) !== 0) return realpathSync(candidate);
    } catch {}
  }
  throw new Error("could not resolve the pinned Grok executable for Leader identity");
}

function sameRealPath(candidate: string, expected: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  try { return realpathSync(candidate) === expected; } catch { return false; }
}

function sameProcessGenerationExists(pid: number, startTime: string): boolean {
  try {
    const current = readProcessStat(pid);
    return current.startTime === startTime && current.state !== "Z" && current.state !== "X";
  } catch { return false; }
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGenerationGone(
  pid: number,
  startTime: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sameProcessGenerationExists(pid, startTime)) return true;
    await delay(20);
  }
  return !sameProcessGenerationExists(pid, startTime);
}

async function waitForListenerGone(identity: OwnedGrokLeaderIdentity, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rowStillPresent = listenerInodeExists(identity.leaderSocket, identity.listenerInode);
    const holderStillPresent = listenerHolders(identity.listenerInode).length > 0;
    if (!rowStillPresent && !holderStillPresent) return;
    await delay(20);
  }
  throw new Error("owned Grok Leader listener remained after process termination");
}

function listenerInodeExists(path: string, inode: string): boolean {
  try {
    return readFileSync("/proc/net/unix", "utf8").split("\n").slice(1).some((line) => {
      if (!line.trim()) return false;
      const parsed = parseUnixSocketRow(line);
      return parsed.path === path && parsed.inode === inode;
    });
  } catch {
    return true;
  }
}

async function waitForOwnerGenerationGone(
  identity: OwnedGrokLeaderIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processesWithGenerationIdentity(identity).length === 0) return;
    await delay(20);
  }
  throw new Error("Grok Leader generation still has live processes after termination");
}

function processesWithGenerationIdentity(identity: OwnedGrokLeaderIdentity): number[] {
  const matches: number[] = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;
    try {
      const env = readNulEnvironment(`/proc/${entry.name}/environ`);
      if (
        env[LEADER_OWNER_ENV] === identity.ownerNonce
        || (
          env.GROK_HOME === identity.grokHome
          && env.ANET_EXPECTED_PARENT_PID === identity.expectedParentPid
        )
      ) {
        matches.push(pid);
      }
    } catch {}
  }
  return matches.sort((left, right) => left - right);
}

function removeUnchangedStaleSocket(identity: OwnedGrokLeaderIdentity): void {
  if (!existsSync(identity.leaderSocket)) return;
  const current = readSocketFileIdentity(identity.leaderSocket);
  assertFileIdentity(current, identity.socket, "stale Grok Leader socket");
  if (listenerInodeExists(identity.leaderSocket, identity.listenerInode)) {
    throw new Error("refusing to unlink a Grok Leader socket that still has a listener");
  }
  unlinkSync(identity.leaderSocket);
}

function assertFileIdentity(current: FileIdentity, expected: FileIdentity, label: string): void {
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== expected.uid) {
    throw new Error(`${label} identity changed`);
  }
}

function validateNonce(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("invalid Grok Leader owner generation marker");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
