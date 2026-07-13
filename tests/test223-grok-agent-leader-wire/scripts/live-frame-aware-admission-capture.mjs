import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteRecorder } from "../lib/byte-recorder.mjs";
import {
  jsonRpcIdKey,
} from "../lib/rpc-order.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const CAPTURE = "live-frame-aware-admission";
const MAX_FRAME_BYTES = 1024 * 1024;
const IO_TIMEOUT_MS = 5_000;
const LISTEN_TIMEOUT_MS = 5_000;
const QUIESCENCE_TIMEOUT_MS = 5_000;
const QUIESCENCE_QUIET_MS = 100;
const PROCESS_TERM_TIMEOUT_MS = 2_000;
const PROCESS_KILL_TIMEOUT_MS = 2_000;
const TUI_LAUNCH_GENERATION_ENV = "ANET_TUI_LAUNCH_GENERATION";
const REJECTED_MARKER = "CAPTURE_BODY_CANARY_FRAME_GATE_REJECTED_PROMPT";
const READY_MARKER = "CAPTURE_BODY_CANARY_FRAME_GATE_READY";
const RECOVERY_PROMPT = "Reply with one string formed from TUI_GATE_ + RECOVERY_ + OK. Output only the result.";
const ALLOWED_ANSWER = "FRAME_GATE_ALLOWED_OK";
const ALLOWED_PROMPT = [
  "Reply with one string formed by concatenating these fragments without",
  "spaces or punctuation: FRAME_GATE_ + ALLOWED_ + OK.",
  "Output only the result.",
].join(" ");
const progress = {
  rejectionProven: false,
  tuiAliveAfterRejection: false,
  allowedPromptStopReason: undefined,
  allowedAcpAnswerExact: false,
  allowedAnswerNativeFramesToTui: 0,
  allowedAnswerRenderedInTui: false,
  tuiRecoveryCompleted: false,
};

class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function asCaptureError(error, fallbackCode) {
  return error instanceof CaptureError ? error : new CaptureError(fallbackCode);
}

async function withTimeout(promise, timeoutMs, code, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // Timeout remains the authoritative bounded failure.
          } finally {
            rejectTimeout(new CaptureError(code));
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForStreamClose(stream) {
  if (!stream || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolveClose) => stream.once("close", resolveClose));
}

function createHalfOpenServer(connectionListener) {
  return createServer({ allowHalfOpen: true }, connectionListener);
}

function createHalfOpenConnection(socketPath) {
  return createConnection({ path: socketPath, allowHalfOpen: true });
}

async function listenUnixServer(server, socketPath, label) {
  await withTimeout(new Promise((resolveListen, rejectListen) => {
    const cleanup = () => server.removeListener("error", onError);
    const onError = (error) => {
      cleanup();
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      cleanup();
      resolveListen();
    });
  }), LISTEN_TIMEOUT_MS, `${label}_LISTEN_TIMEOUT`, () => server.close());
}

async function closeServerBounded(server, label, timeoutMs = IO_TIMEOUT_MS) {
  if (!server?.listening) return;
  await withTimeout(new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  }), timeoutMs, `${label}_SERVER_CLOSE_TIMEOUT`);
}

function createServerCloseLifecycle(server, label) {
  let phase = "open";
  let physicalCloseCalls = 0;
  let serverClosePromise;
  let abortPromise;
  const ensureCloseStarted = () => {
    if (serverClosePromise) return serverClosePromise;
    physicalCloseCalls += 1;
    serverClosePromise = new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(new CaptureError(`${label}_SERVER_CLOSE_FAILED`));
        else resolveClose();
      });
    });
    serverClosePromise.catch(() => {});
    return serverClosePromise;
  };
  return {
    beginDrain({ closing = false, closePhase = "open" } = {}) {
      if (closing || closePhase !== "open" || phase !== "open" || serverClosePromise) {
        throw new CaptureError(`${label}_DRAIN_PHASE_INVALID`);
      }
      phase = "draining";
      return ensureCloseStarted();
    },
    graceful() {
      if (phase !== "draining" || !serverClosePromise) {
        throw new CaptureError(`${label}_GRACEFUL_PHASE_INVALID`);
      }
      return serverClosePromise;
    },
    abort(abortTransport) {
      if (abortPromise) return abortPromise;
      if (typeof abortTransport !== "function") {
        throw new CaptureError(`${label}_ABORT_TRANSPORT_REQUIRED`);
      }
      phase = "abort_pending";
      let transportResult;
      try {
        // Execute synchronously: abort must not queue behind a graceful path
        // that is waiting for terminal EOF from these same sockets.
        transportResult = abortTransport();
      } catch (error) {
        transportResult = Promise.reject(error);
      }
      const close = ensureCloseStarted();
      phase = "aborting";
      abortPromise = Promise.all([Promise.resolve(transportResult), close])
        .then(() => { phase = "closed"; });
      abortPromise.catch(() => {});
      return abortPromise;
    },
    status: () => ({
      phase,
      physicalCloseCalls,
      closeStarted: Boolean(serverClosePromise),
    }),
  };
}

function monitorChildProcess(child, label, {
  requireSignalIdentity = false,
} = {}) {
  let closeObserved = false;
  let processErrorObserved = false;
  let boundTuple;
  let sessionTracker;
  if (Number.isInteger(child.pid)) {
    try {
      boundTuple = readLinuxProcessTuple(child.pid);
      sessionTracker = new SessionGenerationTracker(
        sessionGenerationFromTuple(boundTuple),
        label,
      );
    } catch {
      // Callers that use this as a process-identity boundary explicitly check
      // identityBound(). Synthetic EventEmitter tests intentionally have none.
      boundTuple = undefined;
      sessionTracker = undefined;
    }
  }
  child.once("error", () => {
    processErrorObserved = true;
  });
  const closedPromise = new Promise((resolveClose) => {
    child.once("close", () => {
      closeObserved = true;
      resolveClose();
    });
  });
  const sessionMembers = () => {
    if (!sessionTracker) return [];
    return sessionTracker.members();
  };
  const identityCurrent = () => {
    if (!Number.isInteger(child.pid) || !boundTuple) return false;
    try {
      const current = readLinuxProcessTuple(child.pid);
      return current.starttime === boundTuple.starttime
        && current.pgrp === boundTuple.pgrp
        && current.session === boundTuple.session
        && current.uid === boundTuple.uid;
    } catch {
      return false;
    }
  };
  return {
    child,
    label,
    closed: () => closeObserved,
    processErrorObserved: () => processErrorObserved,
    processGroupAlive: () => sessionMembers().length > 0,
    sessionMembers,
    identityBound: () => Boolean(boundTuple),
    boundTuple: () => boundTuple,
    sessionGeneration: () => sessionTracker?.generation,
    identityCurrent,
    revalidateForSignal() {
      if (sessionMembers().length === 0) return false;
      if (requireSignalIdentity
        && !boundTuple) {
        throw new CaptureError(`${label}_IDENTITY_CHANGED_BEFORE_SIGNAL`);
      }
      return true;
    },
    boundProcessGroup: () => boundTuple?.pgrp,
    signalSession(signal) {
      if (!sessionTracker) throw new CaptureError(`${label}_SESSION_IDENTITY_UNAVAILABLE`);
      signalSessionGeneration(sessionTracker, signal, label);
    },
    treeGone: () => closeObserved && sessionMembers().length === 0,
    closedPromise,
  };
}

function signalProcessTree(lifecycle, signal) {
  if (!lifecycle) return;
  if (!Number.isInteger(lifecycle.child.pid)) return;
  if (typeof lifecycle.revalidateForSignal === "function"
    && !lifecycle.revalidateForSignal()) return;
  if (typeof lifecycle.signalSession !== "function") {
    throw new CaptureError(`${lifecycle.label || "CHILD"}_SESSION_SIGNAL_UNAVAILABLE`);
  }
  lifecycle.signalSession(signal);
}

async function waitForProcessTreeGone(lifecycle, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle.treeGone()) return;
    await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  if (lifecycle.treeGone()) return;
  throw new CaptureError(code);
}

async function terminateProcessTree(lifecycle, label, { abort = false } = {}) {
  if (!lifecycle || lifecycle.treeGone()) return;
  signalProcessTree(lifecycle, "SIGTERM");
  try {
    await waitForProcessTreeGone(
      lifecycle,
      abort ? 250 : PROCESS_TERM_TIMEOUT_MS,
      `${label}_TERM_TIMEOUT`,
    );
    return;
  } catch (error) {
    if (!(error instanceof CaptureError) || error.code !== `${label}_TERM_TIMEOUT`) throw error;
  }
  signalProcessTree(lifecycle, "SIGKILL");
  await waitForProcessTreeGone(
    lifecycle,
    PROCESS_KILL_TIMEOUT_MS,
    `${label}_PROCESS_TREE_DID_NOT_EXIT`,
  );
}

function readLinuxProcessTuple(pid) {
  const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
  const openParen = statLine.indexOf("(");
  const closeParen = statLine.lastIndexOf(")");
  if (openParen <= 0 || closeParen < openParen) {
    throw new CaptureError("PROC_STAT_SHAPE_INVALID");
  }
  const observedPid = Number(statLine.slice(0, openParen).trim());
  const fieldsAfterComm = statLine.slice(closeParen + 2).trim().split(/\s+/);
  // fieldsAfterComm[0] is field 3 (state), [1] ppid, [2] pgrp, [3] session,
  // and [19] starttime (field 22).
  const state = fieldsAfterComm[0];
  const ppid = Number(fieldsAfterComm[1]);
  const pgrp = Number(fieldsAfterComm[2]);
  const session = Number(fieldsAfterComm[3]);
  const starttime = fieldsAfterComm[19];
  const uid = statSync(`/proc/${pid}`).uid;
  if (observedPid !== pid
    || typeof state !== "string" || state.length !== 1
    || !Number.isInteger(ppid) || ppid < 0
    || !Number.isInteger(pgrp) || pgrp <= 0
    || !Number.isInteger(session) || session <= 0
    || !/^\d+$/.test(String(starttime || ""))) {
    throw new CaptureError("PROC_STARTTIME_INVALID");
  }
  return Object.freeze({ pid, ppid, pgrp, session, starttime, state, uid });
}

function listSessionMembers(sid, uid = process.getuid()) {
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(uid) || uid < 0) return [];
  const members = [];
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    throw new CaptureError("PROC_SESSION_SCAN_FAILED");
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const tuple = readLinuxProcessTuple(Number(entry.name));
      if (tuple.session === sid && tuple.uid === uid) members.push(tuple);
    } catch {
      // Process exited between readdir and stat; continue the bounded scan.
    }
  }
  return members.sort((left, right) => left.pid - right.pid);
}

function sessionGenerationFromTuple(tuple) {
  if (!tuple || !Number.isInteger(tuple.session) || !Number.isInteger(tuple.uid)) {
    throw new CaptureError("SESSION_GENERATION_TUPLE_INVALID");
  }
  let leader;
  try {
    leader = readLinuxProcessTuple(tuple.session);
  } catch {
    throw new CaptureError("SESSION_GENERATION_LEADER_UNAVAILABLE");
  }
  if (leader.pid !== tuple.session
    || leader.session !== tuple.session
    || leader.uid !== tuple.uid) {
    throw new CaptureError("SESSION_GENERATION_LEADER_INVALID");
  }
  return Object.freeze({
    sid: tuple.session,
    uid: tuple.uid,
    leaderStarttime: leader.starttime,
  });
}

class SessionGenerationTracker {
  constructor(generation, label) {
    if (!generation
      || !Number.isInteger(generation.sid) || generation.sid <= 0
      || !Number.isInteger(generation.uid) || generation.uid < 0
      || typeof generation.leaderStarttime !== "string"
      || !/^\d+$/.test(generation.leaderStarttime)) {
      throw new CaptureError(`${label}_SESSION_GENERATION_INVALID`);
    }
    this.generation = Object.freeze({ ...generation });
    this.label = label;
    this.terminal = false;
    this.members();
  }

  members() {
    if (this.terminal) return [];
    const { sid, uid, leaderStarttime } = this.generation;
    const validateLeaderGeneration = () => {
      try {
        const currentLeader = readLinuxProcessTuple(sid);
        if (currentLeader.session !== sid
          || currentLeader.uid !== uid
          || currentLeader.starttime !== leaderStarttime) {
          // Linux cannot reuse a SID while any member of the old session is
          // alive. A different /proc/<sid> generation therefore proves the
          // original generation is terminal and must never be signalled.
          this.terminal = true;
          throw new CaptureError(`${this.label}_SESSION_GENERATION_CHANGED`);
        }
        return true;
      } catch (error) {
        if (error instanceof CaptureError
          && error.code === `${this.label}_SESSION_GENERATION_CHANGED`) throw error;
        // The original session leader may exit while descendants remain. In
        // that state /proc/<sid> is absent, but the SID cannot be reused until
        // the final member exits.
        return false;
      }
    };
    validateLeaderGeneration();
    const members = listSessionMembers(sid, uid);
    // Revalidate after the scan as well. In particular, if the leader was
    // absent at the first check, a newly visible /proc/<sid> must not turn a
    // stale SID into a different generation between validation and signal.
    validateLeaderGeneration();
    if (members.length === 0) this.terminal = true;
    return members;
  }
}

function sameProcessTuple(left, right) {
  return left.pid === right.pid
    && left.starttime === right.starttime
    && left.pgrp === right.pgrp
    && left.session === right.session
    && left.uid === right.uid;
}

function signalExactProcessTuple(tuple, signal, label) {
  try {
    const current = readLinuxProcessTuple(tuple.pid);
    if (!sameProcessTuple(current, tuple)) {
      throw new CaptureError(`${label}_SESSION_MEMBER_CHANGED`);
    }
    process.kill(tuple.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
}

const sessionFreezeWaitCell = new Int32Array(new SharedArrayBuffer(4));

function processCannotFork(tuple) {
  return tuple && ["T", "t", "Z", "X", "x"].includes(tuple.state);
}

function tupleGenerationKey(tuple) {
  return `${tuple.pid}:${tuple.starttime}`;
}

function freezeSessionGeneration(tracker, label, {
  signalTuple = signalExactProcessTuple,
  waitForSignalDelivery = () => Atomics.wait(sessionFreezeWaitCell, 0, 0, 1),
  clock = Date.now,
  timeoutMs = 500,
} = {}) {
  if (typeof signalTuple !== "function"
    || typeof waitForSignalDelivery !== "function"
    || typeof clock !== "function"
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CaptureError(`${label}_SESSION_FREEZE_DEPENDENCY_INVALID`);
  }
  const deadline = clock() + timeoutMs;
  let lastObserved = [];
  while (clock() < deadline) {
    const before = tracker.members();
    if (before.length === 0) return [];
    for (const member of before) {
      if (!processCannotFork(member)) signalTuple(member, "SIGSTOP", label);
    }
    // SIGSTOP delivery is asynchronous with respect to /proc state. Yield the
    // controller thread so every exact tuple can reach a non-forking state.
    waitForSignalDelivery();
    const after = tracker.members();
    for (const member of after) {
      if (!processCannotFork(member)) {
        signalTuple(member, "SIGSTOP", label);
      }
    }
    const beforeKeys = new Set(before.map(tupleGenerationKey));
    const stable = after.every((member) => beforeKeys.has(tupleGenerationKey(member)));
    if (stable && after.every(processCannotFork)) {
      // A second stopped-state scan is the fence. Once every member is
      // T/t/Z/X and the exact tuple set has not grown, no member can fork
      // between this return and the requested TERM/KILL.
      waitForSignalDelivery();
      const confirmed = tracker.members();
      const afterKeys = new Set(after.map(tupleGenerationKey));
      if (confirmed.every((member) => afterKeys.has(tupleGenerationKey(member))
        && processCannotFork(member))) {
        return confirmed;
      }
      lastObserved = confirmed;
    } else {
      lastObserved = after;
    }
  }
  for (const member of lastObserved) {
    if (!processCannotFork(member)) {
      try { signalTuple(member, "SIGSTOP", label); } catch {}
    }
  }
  throw new CaptureError(`${label}_SESSION_FREEZE_UNSTABLE`);
}

function signalSessionGeneration(tracker, signal, label) {
  const failures = [];
  let frozen;
  try {
    frozen = freezeSessionGeneration(tracker, label);
  } catch (error) {
    throw new CaptureError(`${label}_SESSION_SIGNAL_FAILED`, { cause: error });
  }
  if (signal !== "SIGSTOP") {
    for (const member of frozen) {
      try { signalExactProcessTuple(member, signal, label); } catch (error) { failures.push(error); }
    }
    if (signal !== "SIGKILL") {
      for (const member of frozen) {
        try { signalExactProcessTuple(member, "SIGCONT", label); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length !== 0) throw new CaptureError(`${label}_SESSION_SIGNAL_FAILED`);
}

function bindPtyProducerIdentity(identityPath, wrapperTuple) {
  const entry = lstatSync(identityPath);
  if (!entry.isFile() || entry.isSymbolicLink()
    || entry.uid !== process.getuid()
    || (entry.mode & 0o777) !== 0o600) {
    throw new CaptureError("TUI_PRODUCER_IDENTITY_FILE_INVALID");
  }
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch {
    throw new CaptureError("TUI_PRODUCER_IDENTITY_JSON_INVALID");
  }
  for (const key of ["pid", "pgid", "sid"]) {
    if (!Number.isInteger(identity?.[key]) || identity[key] <= 0) {
      throw new CaptureError("TUI_PRODUCER_IDENTITY_VALUE_INVALID");
    }
  }
  if (typeof identity.starttime !== "string" || !/^\d+$/.test(identity.starttime)) {
    throw new CaptureError("TUI_PRODUCER_STARTTIME_INVALID");
  }
  if (!wrapperTuple
    || !Number.isInteger(wrapperTuple.pid)
    || identity.pid === wrapperTuple.pid
    || (Number.isInteger(wrapperTuple.pgrp) && identity.pgid === wrapperTuple.pgrp)
    || (Number.isInteger(wrapperTuple.session) && identity.sid === wrapperTuple.session)) {
    throw new CaptureError("TUI_WRAPPER_AND_PRODUCER_PGID_NOT_INDEPENDENT");
  }
  let tupleA;
  let tupleB;
  try {
    tupleA = readLinuxProcessTuple(identity.pid);
    tupleB = readLinuxProcessTuple(identity.pid);
  } catch {
    if (identity.pid === identity.sid) {
      const generation = {
        sid: identity.sid,
        uid: process.getuid(),
        leaderStarttime: identity.starttime,
      };
      const tracker = new SessionGenerationTracker(generation, "TUI_PRODUCER_BIND");
      if (tracker.members().length > 0) {
        return Object.freeze({
          pid: identity.pid,
          pgid: identity.pgid,
          sid: identity.sid,
          starttime: identity.starttime,
          uid: generation.uid,
          sessionLeaderStarttime: generation.leaderStarttime,
        });
      }
    }
    throw new CaptureError("TUI_PRODUCER_IDENTITY_STALE");
  }
  if (tupleA.starttime !== identity.starttime
    || tupleA.pgrp !== identity.pgid
    || tupleA.session !== identity.sid
    || tupleA.uid !== process.getuid()
    || tupleB.starttime !== tupleA.starttime
    || tupleB.pgrp !== tupleA.pgrp
    || tupleB.session !== tupleA.session
    || tupleB.uid !== tupleA.uid) {
    throw new CaptureError("TUI_PRODUCER_IDENTITY_STALE");
  }
  const generation = sessionGenerationFromTuple(tupleA);
  if (generation.sid !== identity.sid) {
    throw new CaptureError("TUI_PRODUCER_SESSION_GENERATION_INVALID");
  }
  return Object.freeze({
    pid: identity.pid,
    pgid: identity.pgid,
    sid: identity.sid,
    starttime: identity.starttime,
    uid: tupleA.uid,
    sessionLeaderStarttime: generation.leaderStarttime,
  });
}

function monitorFixedProducerIdentity(identity, expectedExecutable, label) {
  const expected = realpathSync(expectedExecutable);
  const sessionTracker = new SessionGenerationTracker({
    sid: identity.sid,
    uid: identity.uid,
    leaderStarttime: identity.sessionLeaderStarttime,
  }, label);
  const tupleCurrent = () => {
    try {
      const tuple = readLinuxProcessTuple(identity.pid);
      if (tuple.starttime !== identity.starttime
        || tuple.pgrp !== identity.pgid
        || tuple.session !== identity.sid
        || tuple.uid !== identity.uid) return false;
      return true;
    } catch {
      return false;
    }
  };
  const executableReady = () => {
    if (!tupleCurrent()) return false;
    try {
      return realpathSync(readlinkSync(`/proc/${identity.pid}/exe`)) === expected;
    } catch {
      return false;
    }
  };
  const sessionMembers = () => {
    return sessionTracker.members();
  };
  const revalidateForSignal = () => {
    if (tupleCurrent()) return true;
    return sessionMembers().length > 0;
  };
  return {
    label,
    identityCurrent: tupleCurrent,
    executableReady,
    sessionMembers,
    processGroupAlive: () => sessionMembers().length > 0,
    treeGone: () => !tupleCurrent() && sessionMembers().length === 0,
    signal(signal) {
      if (!revalidateForSignal()) return;
      signalSessionGeneration(sessionTracker, signal, label);
    },
  };
}

function monitorTuiProcessTree(wrapperLifecycle, producerLifecycle) {
  return {
    wrapper: wrapperLifecycle,
    producer: producerLifecycle,
    treeGone: () => wrapperLifecycle.treeGone() && producerLifecycle.treeGone(),
  };
}

function readDirectChildPids(parentPid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new CaptureError("TUI_WRAPPER_CHILD_SCAN_FAILED");
  }
  if (!raw) return [];
  const pids = raw.split(/\s+/).map(Number);
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new CaptureError("TUI_WRAPPER_CHILD_SCAN_INVALID");
  }
  return pids;
}

function identityFromDirectChild(childPid, wrapperPid, wrapperTuple) {
  const tupleA = readLinuxProcessTuple(childPid);
  const tupleB = readLinuxProcessTuple(childPid);
  if (tupleA.starttime !== tupleB.starttime
    || tupleA.pgrp !== tupleB.pgrp
    || tupleA.session !== tupleB.session
    || tupleA.uid !== tupleB.uid
    || tupleA.uid !== process.getuid()
    || tupleA.ppid !== wrapperPid
    || (wrapperTuple && tupleA.session === wrapperTuple.session)) {
    throw new CaptureError("TUI_DIRECT_CHILD_IDENTITY_INVALID");
  }
  const generation = sessionGenerationFromTuple(tupleA);
  return Object.freeze({
    pid: tupleA.pid,
    pgid: tupleA.pgrp,
    sid: tupleA.session,
    starttime: tupleA.starttime,
    uid: tupleA.uid,
    sessionLeaderStarttime: generation.leaderStarttime,
  });
}

function validateLaunchGeneration(launchGeneration) {
  if (typeof launchGeneration !== "string" || !/^[a-f0-9]{64}$/.test(launchGeneration)) {
    throw new CaptureError("TUI_LAUNCH_GENERATION_INVALID");
  }
  return launchGeneration;
}

function environmentBlockContainsLaunchGeneration(raw, launchGeneration) {
  if (!Buffer.isBuffer(raw)) throw new CaptureError("TUI_LAUNCH_ENVIRONMENT_BLOCK_INVALID");
  if (raw.length === 0) return false;
  const exact = Buffer.from(`${TUI_LAUNCH_GENERATION_ENV}=${launchGeneration}`);
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf(0, start);
    const boundary = end === -1 ? raw.length : end;
    if (raw.subarray(start, boundary).equals(exact)) return true;
    start = boundary + 1;
  }
  return false;
}

function environmentContainsLaunchGeneration(pid, launchGeneration) {
  try {
    return environmentBlockContainsLaunchGeneration(
      readFileSync(`/proc/${pid}/environ`),
      launchGeneration,
    );
  } catch {
    return false;
  }
}

function scanLaunchGenerationCohort(launchGeneration, wrapperTuple) {
  validateLaunchGeneration(launchGeneration);
  if (!wrapperTuple
    || !Number.isInteger(wrapperTuple.pid)) {
    throw new CaptureError("TUI_LAUNCH_WRAPPER_IDENTITY_INVALID");
  }
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    throw new CaptureError("TUI_LAUNCH_GENERATION_SCAN_FAILED");
  }
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === wrapperTuple.pid) continue;
    let tupleA;
    try {
      tupleA = readLinuxProcessTuple(pid);
    } catch {
      continue;
    }
    if (tupleA.uid !== process.getuid()
      || (Number.isInteger(wrapperTuple.session)
        && tupleA.session === wrapperTuple.session)
      || !environmentContainsLaunchGeneration(pid, launchGeneration)) continue;
    let tupleB;
    try {
      tupleB = readLinuxProcessTuple(pid);
    } catch {
      throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE");
    }
    if (!sameProcessTuple(tupleA, tupleB)) {
      throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE");
    }
    let secondExact;
    try {
      secondExact = environmentBlockContainsLaunchGeneration(
        readFileSync(`/proc/${pid}/environ`),
        launchGeneration,
      );
    } catch {
      throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE");
    }
    if (!secondExact) {
      throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE");
    }
    members.push(tupleB);
  }
  const sessionIds = new Set(members.map(({ session }) => session));
  if (sessionIds.size > 1) {
    throw new CaptureError("TUI_LAUNCH_GENERATION_MULTIPLE_SESSIONS");
  }
  return members.sort((left, right) => left.pid - right.pid);
}

function identityFromLaunchGeneration(launchGeneration, wrapperTuple) {
  const cohort = scanLaunchGenerationCohort(launchGeneration, wrapperTuple);
  const leaders = cohort.filter(({ pid, pgrp, session }) => pid === session && pgrp === session);
  if (leaders.length > 1) {
    throw new CaptureError("TUI_LAUNCH_GENERATION_MULTIPLE_LEADERS");
  }
  if (leaders.length === 0) return undefined;
  const leader = leaders[0];
  let generation;
  try {
    generation = sessionGenerationFromTuple(leader);
  } catch {
    throw new CaptureError("TUI_LAUNCH_GENERATION_UNSTABLE");
  }
  return Object.freeze({
    pid: leader.pid,
    pgid: leader.pgrp,
    sid: leader.session,
    starttime: leader.starttime,
    uid: leader.uid,
    sessionLeaderStarttime: generation.leaderStarttime,
  });
}

function monitorLaunchGenerationCohort(launchGeneration, wrapperReference, label) {
  validateLaunchGeneration(launchGeneration);
  if (typeof wrapperReference !== "function") {
    throw new CaptureError(`${label}_WRAPPER_REFERENCE_INVALID`);
  }
  const remembered = new Map();
  const members = () => {
    const fresh = scanLaunchGenerationCohort(launchGeneration, wrapperReference());
    for (const tuple of fresh) remembered.set(tupleGenerationKey(tuple), tuple);
    const current = new Map(fresh.map((tuple) => [tupleGenerationKey(tuple), tuple]));
    // /proc/<pid>/environ becomes empty after exec and for zombies. Once an
    // exact generation member has been observed, retain that immutable
    // pid/starttime tuple until it truly disappears; marker absence alone is
    // never terminal evidence.
    for (const [key, tuple] of remembered) {
      if (current.has(key)) continue;
      try {
        const observed = readLinuxProcessTuple(tuple.pid);
        if (sameProcessTuple(observed, tuple)) {
          current.set(key, observed);
          continue;
        }
      } catch {
        // Exact process generation has disappeared.
      }
      remembered.delete(key);
    }
    return [...current.values()].sort((left, right) => left.pid - right.pid);
  };
  const tracker = { members };
  return {
    members,
    treeGone: () => members().length === 0,
    signal(signal) {
      signalSessionGeneration(tracker, signal, label);
    },
  };
}

function observeLinearizedLaunchHandoff(observePublished, observePrepublication) {
  if (typeof observePublished !== "function" || typeof observePrepublication !== "function") {
    throw new CaptureError("TUI_LAUNCH_HANDOFF_OBSERVER_INVALID");
  }
  const firstPublished = observePublished();
  if (firstPublished) return firstPublished;
  let prepublication;
  let prepublicationError;
  try {
    prepublication = observePrepublication();
  } catch (error) {
    prepublicationError = error;
  }
  if (prepublication) return prepublication;
  // Required second read: publication may linearize while the hereditary
  // generation is being scanned and disappear from that scan after exec.
  const secondPublished = observePublished();
  if (secondPublished) return secondPublished;
  if (prepublicationError) throw prepublicationError;
  return undefined;
}

function commitTuiIdentityCleanup({
  identityPath,
  wrapperGone,
  producerGone,
  cohortGone,
  failures,
}) {
  if (typeof identityPath !== "string"
    || !Array.isArray(failures)
    || typeof wrapperGone !== "boolean"
    || typeof producerGone !== "boolean"
    || typeof cohortGone !== "boolean") {
    throw new CaptureError("TUI_IDENTITY_CLEANUP_COMMIT_INVALID");
  }
  if (!wrapperGone || !producerGone || !cohortGone || failures.length !== 0) {
    throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
  }
  rmSync(identityPath, { force: true });
  rmSync(`${identityPath}.tmp`, { force: true });
}

async function reconcilePriorTuiCloseForAbort(priorClose, lifecycle, startup) {
  if (!lifecycle || typeof lifecycle.treeGone !== "function"
    || !startup || typeof startup.cleanup !== "function") {
    throw new CaptureError("TUI_ABORT_RECONCILE_DEPENDENCY_INVALID");
  }
  if (priorClose) await Promise.resolve(priorClose).catch(() => {});
  if (!lifecycle.treeGone()) return false;
  // A prior graceful path may have terminated the processes yet failed its
  // identity cleanup commit. Abort must retry and propagate this result; tree
  // termination alone is not a successful close.
  await startup.cleanup();
  return true;
}

async function waitForFixedProducerGone(lifecycle, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle.treeGone()) return;
    await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  if (!lifecycle.treeGone()) throw new CaptureError(code);
}

async function terminateFixedProducer(lifecycle, label, { abort = false } = {}) {
  if (!lifecycle || lifecycle.treeGone()) return;
  lifecycle.signal("SIGTERM");
  try {
    await waitForFixedProducerGone(
      lifecycle,
      abort ? 250 : PROCESS_TERM_TIMEOUT_MS,
      `${label}_TERM_TIMEOUT`,
    );
    return;
  } catch (error) {
    if (!(error instanceof CaptureError) || error.code !== `${label}_TERM_TIMEOUT`) throw error;
  }
  lifecycle.signal("SIGKILL");
  await waitForFixedProducerGone(
    lifecycle,
    PROCESS_KILL_TIMEOUT_MS,
    `${label}_PROCESS_TREE_DID_NOT_EXIT`,
  );
}

async function terminateUnboundChildHandle(lifecycle, label) {
  if (lifecycle.closed()) return;
  const { child } = lifecycle;
  if (!Number.isInteger(child.pid)) throw new CaptureError(`${label}_PID_UNAVAILABLE`);
  const signal = (value) => {
    if (lifecycle.closed()) return;
    if (!child.kill(value) && !lifecycle.closed()) {
      throw new CaptureError(`${label}_${value}_FAILED`);
    }
  };
  signal("SIGTERM");
  signal("SIGCONT");
  try {
    await withTimeout(lifecycle.closedPromise, 250, `${label}_TERM_TIMEOUT`);
    return;
  } catch (error) {
    if (!(error instanceof CaptureError) || error.code !== `${label}_TERM_TIMEOUT`) throw error;
  }
  signal("SIGKILL");
  await withTimeout(
    lifecycle.closedPromise,
    PROCESS_KILL_TIMEOUT_MS,
    `${label}_PROCESS_DID_NOT_EXIT`,
  );
}

function bindTuiProducerStartup({
  child,
  identityPath,
  launchGeneration,
  expectedExecutable,
  label = "TUI",
  wrapperLifecycleFactory = monitorChildProcess,
}) {
  if (typeof wrapperLifecycleFactory !== "function") {
    throw new CaptureError("TUI_WRAPPER_LIFECYCLE_FACTORY_INVALID");
  }
  const wrapperLifecycle = wrapperLifecycleFactory(child, `${label}_WRAPPER`, {
    requireSignalIdentity: true,
  });
  validateLaunchGeneration(launchGeneration);
  const wrapperReference = () => wrapperLifecycle.boundTuple() || { pid: child.pid };
  const launchCohort = monitorLaunchGenerationCohort(
    launchGeneration,
    wrapperReference,
    `${label}_LAUNCH_COHORT`,
  );
  let cachedProvisionalIdentity;
  let producerIdentity;
  let producerLifecycle;

  const bindProducer = (identity) => {
    if (producerLifecycle) return producerLifecycle;
    producerIdentity = identity;
    producerLifecycle = monitorFixedProducerIdentity(
      identity,
      expectedExecutable,
      `${label}_PRODUCER`,
    );
    return producerLifecycle;
  };

  const observe = () => {
    if (producerLifecycle) return producerLifecycle;
    let finalIdentityError;
    const observeIdentityFiles = () => {
      for (const candidatePath of [identityPath, `${identityPath}.tmp`]) {
        if (!existsSync(candidatePath)) continue;
        try {
          return bindProducer(bindPtyProducerIdentity(candidatePath, wrapperReference()));
        } catch (error) {
          if (candidatePath === identityPath) finalIdentityError = error;
        }
      }
      return undefined;
    };
    const bound = observeLinearizedLaunchHandoff(observeIdentityFiles, () => {
      if (!wrapperLifecycle.closed() && Number.isInteger(child.pid)) {
        let childPids = [];
        try { childPids = readDirectChildPids(child.pid); } catch {}
        const candidates = childPids.map((pid) => {
          try {
            return identityFromDirectChild(pid, child.pid, wrapperLifecycle.boundTuple());
          } catch {
            return undefined;
          }
        }).filter(Boolean);
        if (candidates.length > 1) {
          throw new CaptureError("TUI_MULTIPLE_PROVISIONAL_PRODUCERS");
        }
        if (candidates.length === 1) cachedProvisionalIdentity = candidates[0];
      }
      if (!cachedProvisionalIdentity) {
        cachedProvisionalIdentity = identityFromLaunchGeneration(
          launchGeneration,
          wrapperReference(),
        );
      }
      return cachedProvisionalIdentity ? bindProducer(cachedProvisionalIdentity) : undefined;
    });
    if (bound) return bound;
    if (finalIdentityError) throw finalIdentityError;
    return undefined;
  };

  const waitForIdentity = async (timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const bound = observe();
      if (bound) return bound;
      if (wrapperLifecycle.closed()) {
        // One final observation is mandatory after wrapper-first exit: an
        // atomically published identity may outlive the wrapper.
        const finalBound = observe();
        if (finalBound) return finalBound;
        throw new CaptureError("TUI_WRAPPER_EXITED_BEFORE_PRODUCER_BIND");
      }
      await sleep(10);
    }
    throw new CaptureError("TUI_PRODUCER_IDENTITY_BIND_TIMEOUT");
  };

  const waitForExecutable = async (timeoutMs = 15_000) => {
    const lifecycle = producerLifecycle || await waitForIdentity(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (lifecycle.executableReady()) return lifecycle;
      if (wrapperLifecycle.closed() || !lifecycle.identityCurrent()) {
        throw new CaptureError("TUI_PRODUCER_EXECUTABLE_READINESS_FAILED");
      }
      await sleep(10);
    }
    throw new CaptureError("TUI_PRODUCER_EXECUTABLE_READINESS_TIMEOUT");
  };

  const cleanup = async () => {
    const failures = [];
    const recordDiscoveryFailure = (error) => {
      if (error instanceof CaptureError
        && error.code === "TUI_PRODUCER_IDENTITY_STALE") return;
      failures.push(error);
    };
    // Always inspect final/tmp identities first, even if wrapper-first exit
    // has already made the wrapper tree terminal.
    try { observe(); } catch (error) { recordDiscoveryFailure(error); }
    if (!wrapperLifecycle.closed()) {
      try {
        if (wrapperLifecycle.identityBound()) signalProcessTree(wrapperLifecycle, "SIGSTOP");
        else if (!child.kill("SIGSTOP") && !wrapperLifecycle.closed()) {
          throw new CaptureError(`${label}_UNBOUND_WRAPPER_STOP_FAILED`);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    const discoveryDeadline = Date.now() + 150;
    while (!producerLifecycle && Date.now() < discoveryDeadline) {
      try { observe(); } catch (error) { recordDiscoveryFailure(error); }
      if (!producerLifecycle) await sleep(10);
    }
    const cleanupResults = await Promise.allSettled([
      producerLifecycle
        ? terminateFixedProducer(producerLifecycle, `${label}_PRODUCER_STARTUP`, { abort: true })
        : terminateFixedProducer(launchCohort, `${label}_LAUNCH_COHORT_STARTUP`, { abort: true }),
      wrapperLifecycle.identityBound()
        ? terminateProcessTree(wrapperLifecycle, `${label}_WRAPPER_STARTUP`, { abort: true })
        : terminateUnboundChildHandle(wrapperLifecycle, `${label}_UNBOUND_WRAPPER_STARTUP`),
    ]);
    failures.push(...cleanupResults.filter(({ status }) => status === "rejected"));
    // Reconcile both sides of the atomic handoff after the wrapper is gone.
    // A live pre-publication process is in the hereditary cohort; a process
    // that has dropped the cohort marker has already published final identity.
    for (let round = 0; round < 4; round += 1) {
      try { observe(); } catch (error) { recordDiscoveryFailure(error); }
      const finalCleanup = [];
      if (producerLifecycle && !producerLifecycle.treeGone()) {
        finalCleanup.push(terminateFixedProducer(
          producerLifecycle,
          `${label}_PRODUCER_FINAL_DISCOVERY`,
          { abort: true },
        ));
      }
      if (!launchCohort.treeGone()) {
        finalCleanup.push(terminateFixedProducer(
          launchCohort,
          `${label}_LAUNCH_COHORT_FINAL_DISCOVERY`,
          { abort: true },
        ));
      }
      if (finalCleanup.length === 0) break;
      const results = await Promise.allSettled(finalCleanup);
      failures.push(...results.filter(({ status }) => status === "rejected"));
    }
    let wrapperGone = false;
    let producerGone = false;
    let cohortGone = false;
    try { wrapperGone = wrapperLifecycle.treeGone(); } catch (error) { failures.push(error); }
    try { producerGone = !producerLifecycle || producerLifecycle.treeGone(); } catch (error) { failures.push(error); }
    try { cohortGone = launchCohort.treeGone(); } catch (error) { failures.push(error); }
    // Preserve final/tmp identity on every failed cleanup attempt. It is the
    // only post-unset recovery handle; deletion is the commit after all three
    // independent lifecycles have been proven terminal.
    commitTuiIdentityCleanup({
      identityPath,
      wrapperGone,
      producerGone,
      cohortGone,
      failures,
    });
  };

  return {
    wrapperLifecycle,
    observe,
    waitForIdentity,
    waitForExecutable,
    cleanup,
    producerIdentity: () => producerIdentity,
    producerLifecycle: () => producerLifecycle,
    launchCohort: () => launchCohort,
    composite: () => producerLifecycle
      ? monitorTuiProcessTree(wrapperLifecycle, producerLifecycle)
      : undefined,
  };
}

async function waitForCompositeTreeGone(lifecycle, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle.treeGone()) return;
    await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  if (lifecycle.treeGone()) return;
  throw new CaptureError(code);
}

async function terminateTuiProcessTree(lifecycle, label, { abort = false } = {}) {
  if (!lifecycle || lifecycle.treeGone()) return;
  const signalFailures = [];
  const signalBoth = async (signal) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => lifecycle.producer.signal(signal)),
      Promise.resolve().then(() => signalProcessTree(lifecycle.wrapper, signal)),
    ]);
    signalFailures.push(...results.filter(({ status }) => status === "rejected"));
  };
  // Revalidate immutable tuple/session membership before every signal. One
  // group's failure never prevents the other group from being cleaned up.
  await signalBoth("SIGTERM");
  try {
    await waitForCompositeTreeGone(
      lifecycle,
      abort ? 250 : PROCESS_TERM_TIMEOUT_MS,
      `${label}_TERM_TIMEOUT`,
    );
    if (signalFailures.length !== 0) throw new CaptureError(`${label}_SIGNAL_FAILED`);
    return;
  } catch (error) {
    if (!(error instanceof CaptureError) || error.code !== `${label}_TERM_TIMEOUT`) throw error;
  }
  await signalBoth("SIGKILL");
  await waitForCompositeTreeGone(
    lifecycle,
    PROCESS_KILL_TIMEOUT_MS,
    `${label}_PROCESS_TREES_DID_NOT_EXIT`,
  );
  if (signalFailures.length !== 0) throw new CaptureError(`${label}_SIGNAL_FAILED`);
}

async function writeStreamBounded(stream, bytes, label, timeoutMs = IO_TIMEOUT_MS) {
  await withTimeout(new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectWrite(error);
      else resolveWrite();
    };
    const onError = () => settle(new CaptureError(`${label}_WRITE_FAILED`));
    const onClose = () => settle(new CaptureError(`${label}_CLOSED_DURING_WRITE`));
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      stream.write(bytes, (error) => {
        if (error) settle(new CaptureError(`${label}_WRITE_FAILED`));
        else settle();
      });
    } catch {
      settle(new CaptureError(`${label}_WRITE_FAILED`));
    }
  }), timeoutMs, `${label}_WRITE_TIMEOUT`, () => stream.destroy());
}

async function waitFor(predicate, timeoutMs, code, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new CaptureError(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function buildPtyIdentityPrelude(identityPath, {
  moveExecutable = "/usr/bin/mv",
} = {}) {
  if (typeof moveExecutable !== "string" || !moveExecutable.startsWith("/")) {
    throw new CaptureError("TUI_IDENTITY_MOVE_EXECUTABLE_INVALID");
  }
  return [
    "set -eu",
    "umask 077",
    `test -n "\${${TUI_LAUNCH_GENERATION_ENV}:-}"`,
    "producer_pid=$$",
    "IFS= read -r producer_stat < \"/proc/$producer_pid/stat\"",
    "producer_tail=${producer_stat##*) }",
    "set -- $producer_tail",
    "producer_pgid=$3",
    "producer_sid=$4",
    "producer_starttime=${20}",
    `printf '{\"pid\":%s,\"pgid\":%s,\"sid\":%s,\"starttime\":\"%s\"}\\n' \"$producer_pid\" \"$producer_pgid\" \"$producer_sid\" \"$producer_starttime\" > ${shellQuote(`${identityPath}.tmp`)}`,
    `/usr/bin/chmod 600 ${shellQuote(`${identityPath}.tmp`)}`,
    `${shellQuote(moveExecutable)} -f ${shellQuote(`${identityPath}.tmp`)} ${shellQuote(identityPath)}`,
    `test -f ${shellQuote(identityPath)}`,
    `test ! -L ${shellQuote(identityPath)}`,
    `test -s ${shellQuote(identityPath)}`,
    `unset ${TUI_LAUNCH_GENERATION_ENV}`,
  ].join("; ");
}

function encodeNativeFrame(outer) {
  const payload = Buffer.from(JSON.stringify(outer));
  if (payload.length > MAX_FRAME_BYTES) throw new CaptureError("LOCAL_FRAME_TOO_LARGE");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function innerAcp(outer) {
  if (outer?.type !== "acp") return undefined;
  if (typeof outer.payload === "string") return JSON.parse(outer.payload);
  if (outer.payload && typeof outer.payload === "object") return outer.payload;
  throw new CaptureError("NATIVE_ACP_PAYLOAD_INVALID");
}

function outerWithInner(template, inner) {
  return {
    ...template,
    type: "acp",
    payload: typeof template?.payload === "string" ? JSON.stringify(inner) : inner,
  };
}

function containsMarker(value, marker) {
  try {
    return JSON.stringify(value).includes(marker);
  } catch {
    return false;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function rpcCorrelationKey(lane, id) {
  if (typeof lane !== "string" || lane.length === 0) {
    throw new CaptureError("RPC_CORRELATION_LANE_INVALID");
  }
  try {
    return JSON.stringify([lane, jsonRpcIdKey(id)]);
  } catch {
    throw new CaptureError("RPC_CORRELATION_ID_INVALID");
  }
}

function classifyJsonRpc(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { kind: "invalid", reason: "message_shape" };
  }
  if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") {
    return { kind: "invalid", reason: "jsonrpc_version" };
  }
  const hasMethod = own(message, "method");
  const hasId = own(message, "id");
  const hasResult = own(message, "result");
  const hasError = own(message, "error");
  if (hasMethod) {
    if (typeof message.method !== "string" || message.method.length === 0
      || hasResult || hasError) {
      return { kind: "invalid", reason: "method_shape" };
    }
    if (hasId) {
      try {
        jsonRpcIdKey(message.id);
      } catch {
        return { kind: "invalid", reason: "request_id" };
      }
      return { kind: "request", method: message.method, idType: typeof message.id };
    }
    return { kind: "notification", method: message.method };
  }
  if (!hasId || hasResult === hasError) {
    return { kind: "invalid", reason: "response_shape" };
  }
  try {
    jsonRpcIdKey(message.id);
  } catch {
    return { kind: "invalid", reason: "response_id" };
  }
  return { kind: "response", idType: typeof message.id };
}

class RpcOutstandingLedger {
  constructor(label) {
    this.label = label;
    this.requests = new Map();
  }

  registerRequest(lane, message, metadata = {}) {
    const classification = classifyJsonRpc(message);
    if (classification.kind !== "request") {
      throw new CaptureError("RPC_LEDGER_REGISTER_NON_REQUEST");
    }
    const key = rpcCorrelationKey(lane, message.id);
    if (this.requests.has(key)) {
      throw new CaptureError("RPC_CORRELATION_DUPLICATE_REQUEST_KEY");
    }
    let resolveForwarded;
    let rejectForwarded;
    const forwarded = new Promise((resolveCommit, rejectCommit) => {
      resolveForwarded = resolveCommit;
      rejectForwarded = rejectCommit;
    });
    forwarded.catch(() => {});
    this.requests.set(key, {
      ...metadata,
      lane,
      method: message.method,
      idType: classification.idType,
      state: "registered",
      forwarded,
      resolveForwarded,
      rejectForwarded,
    });
  }

  assertResponse(lane, message) {
    const classification = classifyJsonRpc(message);
    if (classification.kind !== "response") {
      throw new CaptureError("RPC_LEDGER_MATCH_NON_RESPONSE");
    }
    const key = rpcCorrelationKey(lane, message.id);
    const request = this.requests.get(key);
    if (!request) {
      throw new CaptureError("RPC_CORRELATION_RESPONSE_WITHOUT_REQUEST");
    }
    if (request.state !== "forwarded_open") {
      throw new CaptureError("RPC_RESPONSE_BEFORE_REQUEST_EGRESS_COMMIT");
    }
    return key;
  }

  commitRequestForward(lane, message) {
    const classification = classifyJsonRpc(message);
    if (classification.kind !== "request") {
      throw new CaptureError("RPC_LEDGER_COMMIT_NON_REQUEST");
    }
    const key = rpcCorrelationKey(lane, message.id);
    const request = this.requests.get(key);
    if (!request) throw new CaptureError("RPC_REQUEST_COMMIT_WITHOUT_REGISTER");
    if (request.state !== "registered") {
      throw new CaptureError("RPC_REQUEST_EGRESS_DUPLICATE_COMMIT");
    }
    request.state = "forwarded_open";
    request.resolveForwarded();
  }

  failRequestForward(lane, message, error) {
    const key = rpcCorrelationKey(lane, message.id);
    const request = this.requests.get(key);
    if (!request || request.state !== "registered") return false;
    request.state = "forward_failed";
    request.rejectForwarded(asCaptureError(error, "RPC_REQUEST_EGRESS_FAILED"));
    return true;
  }

  async waitForRequestForward(lane, message, timeoutMs = IO_TIMEOUT_MS) {
    const key = rpcCorrelationKey(lane, message.id);
    const request = this.requests.get(key);
    if (!request) throw new CaptureError("RPC_CORRELATION_RESPONSE_WITHOUT_REQUEST");
    if (request.state === "forwarded_open") return;
    if (request.state !== "registered") {
      throw new CaptureError("RPC_REQUEST_EGRESS_NOT_OPEN");
    }
    await withTimeout(
      request.forwarded,
      timeoutMs,
      "RPC_REQUEST_EGRESS_COMMIT_TIMEOUT",
    );
    if (request.state !== "forwarded_open") {
      throw new CaptureError("RPC_REQUEST_EGRESS_NOT_OPEN");
    }
  }

  completeRequest(lane, id, { allowMissing = false } = {}) {
    const key = rpcCorrelationKey(lane, id);
    if (!this.requests.has(key)) {
      if (allowMissing) return false;
      throw new CaptureError("RPC_CORRELATION_RESPONSE_WITHOUT_REQUEST");
    }
    this.requests.delete(key);
    return true;
  }

  commitResponse(lane, message) {
    this.assertResponse(lane, message);
    this.completeRequest(lane, message.id);
  }

  completeLocally(lane, id) {
    const key = rpcCorrelationKey(lane, id);
    const request = this.requests.get(key);
    if (!request) throw new CaptureError("RPC_CORRELATION_RESPONSE_WITHOUT_REQUEST");
    if (request.state !== "registered") {
      throw new CaptureError("RPC_LOCAL_COMPLETION_AFTER_FORWARD");
    }
    request.state = "local_busy_committed";
    request.resolveForwarded();
    this.requests.delete(key);
  }

  size() {
    return this.requests.size;
  }

  snapshot() {
    const grouped = new Map();
    for (const request of this.requests.values()) {
      const key = JSON.stringify([
        request.lane,
        request.method,
        request.idType,
        request.state,
      ]);
      const current = grouped.get(key) || {
        lane: request.lane,
        method: request.method,
        idType: request.idType,
        state: request.state,
        count: 0,
      };
      current.count += 1;
      grouped.set(key, current);
    }
    return {
      count: this.requests.size,
      groups: [...grouped.values()].sort((left, right) =>
        left.lane.localeCompare(right.lane)
        || left.method.localeCompare(right.method)
        || left.idType.localeCompare(right.idType)
        || left.state.localeCompare(right.state)),
    };
  }
}

const ADMISSION_MODES = Object.freeze({
  NORMAL: "NORMAL",
  REJECT: "REJECT",
  DRAINING: "DRAINING",
});

function clientAdmissionAction(mode, classification) {
  if (!Object.values(ADMISSION_MODES).includes(mode)) {
    throw new CaptureError("ADMISSION_MODE_INVALID");
  }
  if (!classification || classification.kind === "invalid") {
    return "fatal";
  }
  if (classification.kind === "response") return "forward_response";
  if (mode === ADMISSION_MODES.NORMAL) return "forward";
  if (classification.kind === "request") return "local_busy";
  if (classification.kind === "notification") return "suppress_notification";
  return "fatal";
}

function assertDrainSnapshotReady({
  mode,
  accepting,
  serverCloseStarted,
  ledgerCount,
  pendingWork,
  writerPending,
  writerBufferedBytes,
}) {
  if (mode !== ADMISSION_MODES.DRAINING || accepting || !serverCloseStarted) {
    throw new CaptureError("DRAIN_NOT_STARTED");
  }
  if (ledgerCount !== 0 || pendingWork !== 0
    || writerPending !== 0 || writerBufferedBytes !== 0) {
    throw new CaptureError("DRAIN_OUTSTANDING_WORK");
  }
}

function assertProducerShutdownArmable({
  mode,
  accepting,
  drainReady,
  serverCloseStarted,
  closing,
  closed,
}) {
  if (closing || closed
    || mode !== ADMISSION_MODES.DRAINING
    || accepting
    || !drainReady
    || !serverCloseStarted) {
    throw new CaptureError("PRODUCER_SHUTDOWN_ARM_BEFORE_DRAIN");
  }
}

class DrainReadinessTracker {
  constructor(label) {
    this.label = label;
    this.epoch = 0;
    this.readyEpoch = -1;
    this.ready = false;
  }

  noteIngress(isDraining) {
    this.epoch += 1;
    if (isDraining) this.ready = false;
  }

  markReady() {
    this.ready = true;
    this.readyEpoch = this.epoch;
  }

  validate() {
    if (!this.ready || this.readyEpoch !== this.epoch) {
      throw new CaptureError(`${this.label}_DRAIN_READY_STALE`);
    }
  }

  snapshot() {
    return {
      ready: this.ready,
      epoch: this.epoch,
      readyEpoch: this.readyEpoch,
    };
  }
}

async function coordinatedDrainAndArm(entries, {
  timeoutMs = QUIESCENCE_TIMEOUT_MS * 3,
  label = "COORDINATED_DRAIN",
} = {}) {
  if (!Array.isArray(entries) || entries.length < 2
    || entries.some(({ listener, producerGone }) =>
      !listener
      || typeof listener.drainToZero !== "function"
      || typeof listener.validateDrainReady !== "function"
      || typeof listener.armProducerShutdown !== "function"
      || typeof producerGone !== "function")) {
    throw new CaptureError(`${label}_ENTRIES_INVALID`);
  }
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    await withTimeout(
      Promise.all(entries.map(({ listener }) => listener.drainToZero())),
      Math.max(1, deadline - Date.now()),
      `${label}_TIMEOUT`,
    );
    try {
      // No await is permitted between the all-listener validation and the
      // all-listener arm commit. JavaScript run-to-completion makes this one
      // coordinated admission tick: either every current snapshot validates,
      // or none is armed and the whole cohort drains again.
      for (const { listener } of entries) listener.validateDrainReady();
    } catch (error) {
      if (!(error instanceof CaptureError)
        || (!/DRAIN_READY_STALE$/.test(error.code)
          && error.code !== "DRAIN_OUTSTANDING_WORK")) throw error;
      continue;
    }
    for (const { listener, producerGone } of entries) {
      listener.armProducerShutdown(producerGone);
    }
    return { attempts };
  }
  throw new CaptureError(`${label}_TIMEOUT`);
}

function isExpectedProducerShutdownSocketError(error) {
  return new Set([
    "ECONNRESET",
    "EPIPE",
    "ENOTCONN",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_PREMATURE_CLOSE",
  ]).has(error?.code);
}

function shouldSuppressShutdownSocketError({
  direction,
  producerShutdown,
  producerGone,
  error,
}) {
  return direction === "producer-facing-ingress"
    && producerShutdown === true
    && producerGone === true
    && isExpectedProducerShutdownSocketError(error);
}

function wireHalfOpenDirection({
  label,
  source,
  target,
  decoder,
  chainSnapshot,
  writer,
  onActivity = () => {},
  onFatal,
  aborting = () => false,
}) {
  const state = {
    label,
    endSeen: false,
    closeSeen: false,
    closeHadError: false,
    resetSeen: false,
    decoderClean: false,
    chainDrained: false,
    writerDrained: false,
    targetEnded: false,
    eofSettled: false,
    eofFailure: undefined,
  };
  let eofPromise;
  const fail = (error, fallbackCode) => {
    const failure = asCaptureError(error, fallbackCode);
    if (!state.eofFailure) state.eofFailure = failure;
    onFatal(failure);
    return failure;
  };
  source.once("end", () => {
    state.endSeen = true;
    onActivity();
    eofPromise = (async () => {
      decoder.assertClean();
      state.decoderClean = true;
      await chainSnapshot();
      state.chainDrained = true;
      await writer.flush();
      state.writerDrained = true;
      writer.seal();
      if (!target.destroyed && !target.writableEnded) target.end();
      state.targetEnded = true;
      state.eofSettled = true;
      onActivity();
    })().catch((error) => {
      state.eofSettled = true;
      onActivity();
      fail(error, `${label}_EOF_PROPAGATION_FAILED`);
    });
    eofPromise.catch(() => {});
  });
  source.once("close", (hadError) => {
    state.closeSeen = true;
    state.closeHadError = Boolean(hadError);
    onActivity();
    if (!aborting() && (!state.endSeen || hadError)) {
      state.resetSeen = true;
      fail(new CaptureError(`${label}_CLOSE_WITHOUT_CLEAN_EOF`));
    }
  });
  source.on("error", (error) => {
    if (aborting()) return;
    state.resetSeen = true;
    fail(error, `${label}_SOCKET_ERROR`);
  });
  return {
    state,
    eofPromise: () => eofPromise || Promise.resolve(),
    terminalClean: () => state.endSeen
      && state.eofSettled
      && state.decoderClean
      && state.chainDrained
      && state.writerDrained
      && state.targetEnded
      && state.closeSeen
      && !state.closeHadError
      && !state.resetSeen
      && !state.eofFailure,
    safeSnapshot: () => ({
      label: state.label,
      endSeen: state.endSeen,
      closeSeen: state.closeSeen,
      closeHadError: state.closeHadError,
      resetSeen: state.resetSeen,
      decoderClean: state.decoderClean,
      chainDrained: state.chainDrained,
      writerDrained: state.writerDrained,
      targetEnded: state.targetEnded,
      eofSettled: state.eofSettled,
    }),
  };
}

function visibleText(raw) {
  return raw
    .toString("utf8")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

class TerminalScreen {
  constructor(rows = 40, columns = 140) {
    this.rows = rows;
    this.columns = columns;
    this.grid = Array.from({ length: rows }, () => Array(columns).fill(" "));
    this.row = 0;
    this.column = 0;
    this.saved = { row: 0, column: 0 };
    this.pending = "";
    this.scrollback = [];
    this.decoder = new TextDecoder("utf-8");
  }

  feed(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let cursor = 0;
    while (cursor < this.pending.length) {
      const character = this.pending[cursor];
      if (character !== "\x1b") {
        const codePoint = this.pending.codePointAt(cursor);
        const value = String.fromCodePoint(codePoint);
        cursor += value.length;
        this.writeCharacter(value);
        continue;
      }
      if (cursor + 1 >= this.pending.length) break;
      const next = this.pending[cursor + 1];
      if (next === "[") {
        const match = this.pending.slice(cursor).match(/^\x1b\[([0-?]*)([ -\/]*)([@-~])/);
        if (!match) break;
        this.applyCsi(match[1], match[3]);
        cursor += match[0].length;
        continue;
      }
      if (next === "]") {
        const rest = this.pending.slice(cursor + 2);
        const bel = rest.indexOf("\x07");
        const terminator = rest.indexOf("\x1b\\");
        if (bel < 0 && terminator < 0) break;
        const end = bel >= 0 && (terminator < 0 || bel < terminator)
          ? cursor + 2 + bel + 1
          : cursor + 2 + terminator + 2;
        cursor = end;
        continue;
      }
      if (next === "P") {
        const end = this.pending.indexOf("\x1b\\", cursor + 2);
        if (end < 0) break;
        cursor = end + 2;
        continue;
      }
      if (next === "7") this.saved = { row: this.row, column: this.column };
      if (next === "8") ({ row: this.row, column: this.column } = this.saved);
      if (next === "D") this.lineFeed();
      if (next === "E") { this.lineFeed(); this.column = 0; }
      if (next === "M") this.row = Math.max(0, this.row - 1);
      cursor += 2;
    }
    this.pending = this.pending.slice(cursor);
    if (this.pending.length > 16_384) this.pending = this.pending.slice(-16_384);
  }

  writeCharacter(character) {
    if (character === "\r") { this.column = 0; return; }
    if (character === "\n") { this.lineFeed(); return; }
    if (character === "\b") { this.column = Math.max(0, this.column - 1); return; }
    if (character === "\t") { this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8); return; }
    if (character < " " || character === "\x7f") return;
    if (this.column >= this.columns) { this.column = 0; this.lineFeed(); }
    this.grid[this.row][this.column] = character;
    const width = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1;
    if (width === 2 && this.column + 1 < this.columns) this.grid[this.row][this.column + 1] = " ";
    this.column += width;
  }

  lineFeed() {
    this.row += 1;
    if (this.row < this.rows) return;
    this.scrollback.push(this.grid.shift().join("").trimEnd());
    if (this.scrollback.length > 500) this.scrollback.shift();
    this.grid.push(Array(this.columns).fill(" "));
    this.row = this.rows - 1;
  }

  applyCsi(rawParameters, final) {
    const parameters = rawParameters.replace(/^\?/, "").split(";").map((value) =>
      value === "" ? 0 : Number(value)).map((value) => Number.isFinite(value) ? value : 0);
    const first = parameters[0] || 1;
    if (final === "A") this.row = Math.max(0, this.row - first);
    else if (final === "B") this.row = Math.min(this.rows - 1, this.row + first);
    else if (final === "C") this.column = Math.min(this.columns - 1, this.column + first);
    else if (final === "D") this.column = Math.max(0, this.column - first);
    else if (final === "E") { this.row = Math.min(this.rows - 1, this.row + first); this.column = 0; }
    else if (final === "F") { this.row = Math.max(0, this.row - first); this.column = 0; }
    else if (final === "G") this.column = Math.max(0, Math.min(this.columns - 1, first - 1));
    else if (final === "d") this.row = Math.max(0, Math.min(this.rows - 1, first - 1));
    else if (final === "H" || final === "f") {
      this.row = Math.max(0, Math.min(this.rows - 1, (parameters[0] || 1) - 1));
      this.column = Math.max(0, Math.min(this.columns - 1, (parameters[1] || 1) - 1));
    } else if (final === "J") {
      const mode = parameters[0] || 0;
      if (mode === 2 || mode === 3) this.grid = Array.from({ length: this.rows }, () => Array(this.columns).fill(" "));
      else if (mode === 0) {
        this.grid[this.row].fill(" ", this.column);
        for (let row = this.row + 1; row < this.rows; row += 1) this.grid[row].fill(" ");
      }
    } else if (final === "K") {
      const mode = parameters[0] || 0;
      if (mode === 0) this.grid[this.row].fill(" ", this.column);
      else if (mode === 1) this.grid[this.row].fill(" ", 0, this.column + 1);
      else if (mode === 2) this.grid[this.row].fill(" ");
    } else if (final === "s") this.saved = { row: this.row, column: this.column };
    else if (final === "u") ({ row: this.row, column: this.column } = this.saved);
    else if (final === "S") for (let count = 0; count < first; count += 1) this.lineFeed();
    else if (final === "X") this.grid[this.row].fill(" ", this.column, Math.min(this.columns, this.column + first));
    else if (final === "P") this.grid[this.row].splice(this.column, first, ...Array(first).fill(" "));
    else if (final === "@") this.grid[this.row].splice(this.column, 0, ...Array(first).fill(" "));
    this.grid[this.row] = this.grid[this.row].slice(0, this.columns);
  }

  text() {
    return [...this.scrollback, ...this.grid.map((row) => row.join("").trimEnd())].join("\n");
  }
}

function childEnvironment(home, authPath) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GROK_HOME: home,
    GROK_AUTH_PATH: authPath,
    GROK_FOLDER_TRUST: "1",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
  };
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  const scope = Object.keys(auth).find((key) => /^https?:\/\/.+::[^:]+$/.test(key));
  if (scope) {
    const split = scope.lastIndexOf("::");
    env.GROK_OIDC_ISSUER = scope.slice(0, split);
    env.GROK_OIDC_CLIENT_ID = scope.slice(split + 2);
  }
  return env;
}

class IncrementalNativeDecoder {
  constructor(label, onFrame) {
    this.label = label;
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.counters = {
      reads: 0,
      inputBytes: 0,
      completeFrames: 0,
      splitPrefixReads: 0,
      splitPayloadReads: 0,
      coalescedReads: 0,
      maximumAdvertisedFrameBytes: 0,
    };
  }

  push(chunk) {
    const bytes = Buffer.from(chunk);
    this.counters.reads += 1;
    this.counters.inputBytes += bytes.length;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const frames = [];
    let emitted = 0;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      this.counters.maximumAdvertisedFrameBytes = Math.max(
        this.counters.maximumAdvertisedFrameBytes,
        length,
      );
      if (length > MAX_FRAME_BYTES) throw new CaptureError("NATIVE_FRAME_EXCEEDS_1MIB_CEILING");
      if (this.buffer.length < 4 + length) {
        this.counters.splitPayloadReads += 1;
        break;
      }
      const frame = this.buffer.subarray(0, 4 + length);
      const payload = frame.subarray(4);
      this.buffer = this.buffer.subarray(4 + length);
      let outer;
      try {
        outer = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new CaptureError("NATIVE_FRAME_JSON_INVALID");
      }
      const parsed = { frame: Buffer.from(frame), outer, inner: innerAcp(outer) };
      frames.push(parsed);
      emitted += 1;
      this.counters.completeFrames += 1;
      this.onFrame?.(parsed);
    }
    if (this.buffer.length > 0 && this.buffer.length < 4) {
      this.counters.splitPrefixReads += 1;
    }
    if (emitted > 1) this.counters.coalescedReads += 1;
    return frames;
  }

  assertClean() {
    if (this.buffer.length !== 0) throw new CaptureError("NATIVE_DECODER_TRUNCATED_TAIL");
  }
}

class FrameWriter {
  constructor(
    socket,
    label,
    recorder,
    recordMeta,
    maximumSegmentBytes = 4096,
    { writeTimeoutMs = IO_TIMEOUT_MS, onActivity = () => {} } = {},
  ) {
    this.socket = socket;
    this.label = label;
    this.recorder = recorder;
    this.recordMeta = recordMeta;
    this.maximumSegmentBytes = maximumSegmentBytes;
    this.writeTimeoutMs = writeTimeoutMs;
    this.onActivity = onActivity;
    this.tail = Promise.resolve();
    this.failure = undefined;
    this.sealed = false;
    this.pendingSegments = 0;
    this.counters = {
      frames: 0,
      requestedBytes: 0,
      completedBytes: 0,
      writeSegments: 0,
      deliberatelySegmentedFrames: 0,
      backpressureEvents: 0,
      drainEvents: 0,
    };
  }

  writeFrame(frame, { forceSplitPrefix = false } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.sealed) return Promise.reject(new CaptureError("NATIVE_WRITER_CLOSED"));
    const bytes = Buffer.from(frame);
    this.tail = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.sealed) throw new CaptureError("NATIVE_WRITER_CLOSED");
      this.counters.frames += 1;
      this.counters.requestedBytes += bytes.length;
      const segments = [];
      if (forceSplitPrefix && bytes.length > 4) {
        segments.push(bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4));
      } else {
        for (let offset = 0; offset < bytes.length; offset += this.maximumSegmentBytes) {
          segments.push(bytes.subarray(offset, Math.min(bytes.length, offset + this.maximumSegmentBytes)));
        }
      }
      if (segments.length > 1) this.counters.deliberatelySegmentedFrames += 1;
      for (let index = 0; index < segments.length; index += 1) {
        await this.writeSegment(segments[index]);
        // Make the live tap observe the split-prefix path deterministically.
        // This is transport segmentation after a complete frame passed the
        // admission gate; it never exposes a partial frame to policy logic.
        if (forceSplitPrefix && index < segments.length - 1) await sleep(5);
      }
    }).catch((error) => {
      const failure = asCaptureError(error, "NATIVE_SOCKET_WRITE_FAILED");
      if (!this.failure) this.failure = failure;
      if (!this.socket.destroyed) this.socket.destroy();
      throw failure;
    });
    this.tail.catch(() => {});
    return this.tail;
  }

  async writeSegment(segment) {
    this.counters.writeSegments += 1;
    this.recorder.record({ ...this.recordMeta, boundary: "write", bytes: segment });
    this.pendingSegments += 1;
    this.onActivity();
    try {
      await new Promise((resolveWrite, rejectWrite) => {
        let settled = false;
        let writeReturned = false;
        let callbackDone = false;
        let drainRequired = false;
        let drainSeen = false;
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          this.socket.removeListener("error", onError);
          this.socket.removeListener("close", onClose);
          this.socket.removeListener("drain", onDrain);
        };
        const settle = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) {
            if (!this.socket.destroyed) this.socket.destroy();
            rejectWrite(error);
          } else {
            resolveWrite();
          }
        };
        const maybeComplete = () => {
          if (!writeReturned || !callbackDone) return;
          if (drainRequired && !drainSeen) return;
          settle();
        };
        const onError = () => settle(new CaptureError("NATIVE_SOCKET_WRITE_FAILED"));
        const onClose = () => settle(new CaptureError("NATIVE_SOCKET_CLOSED_BEFORE_WRITE_COMPLETE"));
        const onDrain = () => {
          if (!drainSeen) this.counters.drainEvents += 1;
          drainSeen = true;
          this.onActivity();
          maybeComplete();
        };
        this.socket.once("error", onError);
        this.socket.once("close", onClose);
        this.socket.once("drain", onDrain);
        timer = setTimeout(() => {
          settle(new CaptureError("NATIVE_SOCKET_WRITE_TIMEOUT"));
        }, this.writeTimeoutMs);
        try {
          const accepted = this.socket.write(segment, (error) => {
            if (error) {
              settle(new CaptureError("NATIVE_SOCKET_WRITE_FAILED"));
              return;
            }
            callbackDone = true;
            this.onActivity();
            maybeComplete();
          });
          drainRequired = !accepted;
          if (drainRequired) this.counters.backpressureEvents += 1;
          writeReturned = true;
          maybeComplete();
        } catch {
          settle(new CaptureError("NATIVE_SOCKET_WRITE_FAILED"));
        }
      });
      this.counters.completedBytes += segment.length;
      this.onActivity();
    } finally {
      this.pendingSegments -= 1;
      this.onActivity();
    }
  }

  async flush() {
    await withTimeout(
      this.tail,
      this.writeTimeoutMs + 250,
      "NATIVE_WRITER_FLUSH_TIMEOUT",
      () => {
        if (!this.socket.destroyed) this.socket.destroy();
      },
    );
    if (this.failure) throw this.failure;
    if (this.counters.completedBytes !== this.counters.requestedBytes) {
      throw new CaptureError("NATIVE_PARTIAL_WRITE_ACCOUNTING_MISMATCH");
    }
  }

  seal() {
    this.sealed = true;
  }

  abort() {
    this.sealed = true;
    if (!this.socket.destroyed) this.socket.destroy();
  }

  status() {
    return {
      pendingSegments: this.pendingSegments,
      writableLength: Number(this.socket.writableLength || 0),
      failed: Boolean(this.failure),
      sealed: this.sealed,
    };
  }
}

async function waitForTransportQuiescence({
  label,
  chainSnapshots = [],
  writers = [],
  sockets = [],
  decoders = [],
  activityEpoch = () => 0,
  pendingWork = () => 0,
  fault = () => undefined,
  timeoutMs = QUIESCENCE_TIMEOUT_MS,
  quietMs = QUIESCENCE_QUIET_MS,
  terminal = false,
  completionFence,
  observedCompletionFence = () => true,
}) {
  if (terminal && typeof completionFence !== "function") {
    throw new CaptureError(`${label}_TERMINAL_COMPLETION_FENCE_REQUIRED`);
  }
  if (!terminal && completionFence !== undefined) {
    throw new CaptureError(`${label}_COMPLETION_FENCE_REQUIRES_TERMINAL_MODE`);
  }
  if (typeof observedCompletionFence !== "function") {
    throw new CaptureError(`${label}_INVALID_OBSERVED_COMPLETION_FENCE`);
  }
  const deadline = Date.now() + timeoutMs;
  let stableEpoch = activityEpoch();
  let stableSince = Date.now();
  let observedFenceReached = false;
  while (Date.now() < deadline) {
    const observedFault = fault();
    if (observedFault) throw observedFault;
    const remaining = Math.max(1, deadline - Date.now());
    await withTimeout(
      Promise.all(chainSnapshots.map((snapshot) => snapshot())),
      remaining,
      `${label}_QUIESCENCE_TIMEOUT`,
    );
    await withTimeout(
      Promise.all(writers.map((writer) => writer.flush())),
      Math.max(1, deadline - Date.now()),
      `${label}_QUIESCENCE_TIMEOUT`,
      () => writers.forEach((writer) => writer.abort()),
    );
    const epoch = activityEpoch();
    if (epoch !== stableEpoch) {
      stableEpoch = epoch;
      stableSince = Date.now();
    }
    const partialBytes = decoders.reduce((sum, decoder) => sum + decoder.buffer.length, 0);
    const pending = pendingWork()
      + writers.reduce((sum, writer) => sum + writer.status().pendingSegments, 0);
    const writableBytes = sockets.reduce(
      (sum, socket) => sum + Number(socket?.writableLength || 0),
      0,
    );
    let completionSatisfied = false;
    if (terminal) {
      const completion = completionFence();
      if (!completion
        || typeof completion.producerGone !== "boolean"
        || !Number.isInteger(completion.ingressTotal)
        || completion.ingressTotal <= 0
        || !Number.isInteger(completion.ingressTerminated)
        || completion.ingressTerminated < 0
        || completion.ingressTerminated > completion.ingressTotal
        || !Number.isInteger(completion.protocolOutstanding)
        || completion.protocolOutstanding < 0) {
        throw new CaptureError(`${label}_INVALID_TERMINAL_COMPLETION_FENCE`);
      }
      completionSatisfied = completion.producerGone
        && completion.ingressTerminated === completion.ingressTotal
        && completion.protocolOutstanding === 0;
    } else {
      // Quiet time is deliberately only an observed-drain heuristic. It is
      // never evidence that a producer cannot emit a future frame.
      const observedCompletion = observedCompletionFence();
      if (typeof observedCompletion !== "boolean") {
        throw new CaptureError(`${label}_INVALID_OBSERVED_COMPLETION_FENCE`);
      }
      if (!observedCompletion) {
        observedFenceReached = false;
      } else if (!observedFenceReached) {
        observedFenceReached = true;
        stableSince = Date.now();
      }
      completionSatisfied = observedFenceReached && Date.now() - stableSince >= quietMs;
    }
    if (partialBytes === 0
      && pending === 0
      && writableBytes === 0
      && completionSatisfied) {
      const finalFault = fault();
      if (finalFault) throw finalFault;
      return;
    }
    await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  if (decoders.some((decoder) => decoder.buffer.length !== 0)) {
    throw new CaptureError("PARTIAL_FRAME_AT_BARRIER");
  }
  throw new CaptureError(terminal
    ? `${label}_TERMINAL_COMPLETION_FENCE_TIMEOUT`
    : `${label}_QUIESCENCE_TIMEOUT`);
}

function runDecoderSelfTest() {
  const seen = [];
  const decoder = new IncrementalNativeDecoder("selftest", (frame) => seen.push(frame));
  const first = encodeNativeFrame({ type: "ping", nonce: "shape-only-a" });
  const second = encodeNativeFrame({ type: "pong", nonce: "shape-only-b" });
  decoder.push(first.subarray(0, 2));
  decoder.push(first.subarray(2, 7));
  decoder.push(Buffer.concat([first.subarray(7), second]));
  decoder.assertClean();
  if (seen.length !== 2
    || decoder.counters.splitPrefixReads < 1
    || decoder.counters.splitPayloadReads < 1
    || decoder.counters.coalescedReads !== 1) {
    throw new CaptureError("FRAME_DECODER_SPLIT_COALESCED_SELFTEST_FAILED");
  }
  const ceiling = new IncrementalNativeDecoder("ceiling");
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  let ceilingRejected = false;
  try {
    ceiling.push(oversized);
  } catch (error) {
    ceilingRejected = error instanceof CaptureError
      && error.code === "NATIVE_FRAME_EXCEEDS_1MIB_CEILING";
  }
  if (!ceilingRejected) throw new CaptureError("FRAME_CEILING_SELFTEST_FAILED");
  return {
    splitPrefix: true,
    splitPayload: true,
    coalescedFrames: true,
    independentCeilingBytes: MAX_FRAME_BYTES,
    oversizedHeaderRejected: true,
  };
}

class AdmissionState {
  constructor() {
    this.rejected = false;
    this.rejectedAt = 0;
    this.originalIdPreserved = false;
    this.busyResponseSent = false;
    this.rejectedPromptUpstreamFrames = 0;
    this.rejectedPromptUpstreamBytes = 0;
    this.subsequentRejectedTextFrames = 0;
    this.subsequentSteerOrReplayFrames = 0;
    this.mutatingFramesSeenInWindow = 0;
    this.mutatingFramesBlockedInWindow = 0;
    this.postBusyMutatingFramesBlocked = 0;
    this.nonMutatingFramesSuppressedInWindow = 0;
    this.allowedAcpPromptFrames = 0;
    this.allowedAnswerFramesToTui = 0;
    this.allowedCaptureEnabled = false;
    this.allowedTuiAgentText = "";
    this.tuiRecoveryPromptFrames = 0;
    this.tuiRecoveryRequestId = undefined;
    this.tuiRecoveryResponseSeen = false;
    this.tuiRecoveryStopReason = undefined;
  }
}

function isTuiMutatingMethod(method) {
  if (method === "session/prompt") return true;
  return typeof method === "string" && /(?:^|\/)(?:steer|inject|replay)(?:$|\/)/i.test(method);
}

async function startLeaderFacingTap({ name, tapPath, leaderPath, recorder, onFatal }) {
  rmSync(tapPath, { force: true });
  let accepted = 0;
  let activity = 0;
  let pendingWork = 0;
  let listenerFault;
  let closing = false;
  let accepting = true;
  let mode = ADMISSION_MODES.NORMAL;
  const drainReadiness = new DrainReadinessTracker(`${name.toUpperCase()}_TAP`);
  let closed = false;
  let producerShutdownArmed = false;
  let producerGoneCheck = () => false;
  let closePhase = "open";
  let closePromise;
  let abortPromise;
  let serverClosePromise;
  const sockets = [];
  const ingressStates = [];
  const writers = [];
  const decoders = [];
  const chainSnapshots = [];
  const rpcOutstanding = new RpcOutstandingLedger(`${name}-leader-tap`);
  const rpcLanes = {
    gatewayToRealLeader: `${name}-leader-tap-1:gateway_to_real_leader`,
    realLeaderToGateway: `${name}-leader-tap-1:real_leader_to_gateway`,
  };
  const metrics = {
    gatewayIngressReadEvents: 0,
    gatewayIngressBytes: 0,
    gatewayIngressCompleteFrames: 0,
    gatewayIngressRequestFrames: 0,
    gatewayIngressRequestBytes: 0,
    gatewayIngressResponseFrames: 0,
    framesForwardedToRealLeader: 0,
    bytesForwardedToRealLeader: 0,
    framesForwardedBackToGateway: 0,
    bytesForwardedBackToGateway: 0,
  };
  const touch = () => { activity += 1; };
  const recordFatal = (error, fallbackCode = "LEADER_TAP_FATAL") => {
    const failure = asCaptureError(error, fallbackCode);
    if (!listenerFault) listenerFault = failure;
    onFatal(failure);
    for (const socket of sockets) if (!socket.destroyed) socket.destroy();
    return failure;
  };
  let aborting = false;
  const server = createHalfOpenServer((gatewaySocket) => {
    touch();
    if (!accepting || closing) {
      gatewaySocket.destroy();
      return;
    }
    accepted += 1;
    if (accepted !== 1) {
      gatewaySocket.destroy();
      recordFatal(new CaptureError(`${name.toUpperCase()}_TAP_MULTIPLE_CLIENTS`));
      return;
    }
    const realLeaderSocket = createHalfOpenConnection(leaderPath);
    sockets.push(gatewaySocket, realLeaderSocket);
    const connection = `${name}-leader-tap-1`;
    const toRealLeader = new FrameWriter(
      realLeaderSocket,
      `${name}-tap-to-real-leader`,
      recorder,
      {
        role: `${name}-leader-facing-tap`,
        transport: "leader-native-ipc",
        connection,
        stream: "real-leader-facing",
        direction: "tap_to_real_leader",
      },
      4096,
      { onActivity: touch },
    );
    const toGateway = new FrameWriter(
      gatewaySocket,
      `${name}-tap-to-gateway`,
      recorder,
      {
        role: `${name}-leader-facing-tap`,
        transport: "leader-native-ipc",
        connection,
        stream: "gateway-facing",
        direction: "tap_to_gateway",
      },
      4096,
      { onActivity: touch },
    );
    writers.push(toRealLeader, toGateway);
    let gatewayChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    let forceSplitToRealLeader = true;
    chainSnapshots.push(() => Promise.all([gatewayChain, leaderChain]));
    const gatewayDecoder = new IncrementalNativeDecoder(`${name}-tap-gateway`, (parsed) => {
      drainReadiness.noteIngress(mode === ADMISSION_MODES.DRAINING);
      const message = parsed.inner === undefined
        ? { jsonrpc: "2.0", method: `native/${String(parsed.outer?.type || "invalid")}` }
        : parsed.inner;
      const classification = classifyJsonRpc(message);
      if (classification.kind === "invalid") {
        throw new CaptureError("TAP_GATEWAY_RPC_CLASSIFICATION_INVALID");
      }
      if (classification.kind === "request") {
        rpcOutstanding.registerRequest(rpcLanes.gatewayToRealLeader, message, {
          direction: "gateway_to_real_leader",
        });
      }
      metrics.gatewayIngressCompleteFrames += 1;
      if (classification.kind === "request") {
        metrics.gatewayIngressRequestFrames += 1;
        metrics.gatewayIngressRequestBytes += parsed.frame.length;
      }
      if (classification.kind === "response") metrics.gatewayIngressResponseFrames += 1;
      pendingWork += 1;
      touch();
      gatewayChain = gatewayChain.then(async () => {
        const split = forceSplitToRealLeader;
        forceSplitToRealLeader = false;
        if (classification.kind === "response") {
          await rpcOutstanding.waitForRequestForward(
            rpcLanes.realLeaderToGateway,
            message,
          );
          rpcOutstanding.assertResponse(rpcLanes.realLeaderToGateway, message);
        }
        await toRealLeader.writeFrame(parsed.frame, { forceSplitPrefix: split });
        if (classification.kind === "request") {
          rpcOutstanding.commitRequestForward(rpcLanes.gatewayToRealLeader, message);
        } else if (classification.kind === "response") {
          rpcOutstanding.commitResponse(rpcLanes.realLeaderToGateway, message);
        }
        metrics.framesForwardedToRealLeader += 1;
        metrics.bytesForwardedToRealLeader += parsed.frame.length;
      }).catch((error) => recordFatal(error, "TAP_GATEWAY_FORWARD_FAILED"))
        .finally(() => {
          pendingWork -= 1;
          touch();
        });
    });
    const leaderDecoder = new IncrementalNativeDecoder(`${name}-tap-real-leader`, (parsed) => {
      drainReadiness.noteIngress(mode === ADMISSION_MODES.DRAINING);
      const message = parsed.inner === undefined
        ? { jsonrpc: "2.0", method: `native/${String(parsed.outer?.type || "invalid")}` }
        : parsed.inner;
      const classification = classifyJsonRpc(message);
      if (classification.kind === "invalid") {
        throw new CaptureError("TAP_LEADER_RPC_CLASSIFICATION_INVALID");
      }
      if (classification.kind === "request") {
        rpcOutstanding.registerRequest(rpcLanes.realLeaderToGateway, message, {
          direction: "real_leader_to_gateway",
        });
      }
      pendingWork += 1;
      touch();
      leaderChain = leaderChain.then(async () => {
        if (classification.kind === "response") {
          await rpcOutstanding.waitForRequestForward(
            rpcLanes.gatewayToRealLeader,
            message,
          );
          rpcOutstanding.assertResponse(rpcLanes.gatewayToRealLeader, message);
        }
        await toGateway.writeFrame(parsed.frame);
        if (classification.kind === "request") {
          rpcOutstanding.commitRequestForward(rpcLanes.realLeaderToGateway, message);
        } else if (classification.kind === "response") {
          rpcOutstanding.commitResponse(rpcLanes.gatewayToRealLeader, message);
        }
        metrics.framesForwardedBackToGateway += 1;
        metrics.bytesForwardedBackToGateway += parsed.frame.length;
      }).catch((error) => recordFatal(error, "TAP_LEADER_FORWARD_FAILED"))
        .finally(() => {
          pendingWork -= 1;
          touch();
        });
    });
    decoders.push(gatewayDecoder, leaderDecoder);
    const gatewayIngress = wireHalfOpenDirection({
      label: `${name.toUpperCase()}_TAP_GATEWAY_INGRESS`,
      source: gatewaySocket,
      target: realLeaderSocket,
      decoder: gatewayDecoder,
      chainSnapshot: () => gatewayChain,
      writer: toRealLeader,
      onActivity: touch,
      onFatal: (error) => recordFatal(error, "TAP_GATEWAY_HALF_OPEN_FAILED"),
      aborting: () => aborting,
    });
    const leaderIngress = wireHalfOpenDirection({
      label: `${name.toUpperCase()}_TAP_LEADER_INGRESS`,
      source: realLeaderSocket,
      target: gatewaySocket,
      decoder: leaderDecoder,
      chainSnapshot: () => leaderChain,
      writer: toGateway,
      onActivity: touch,
      onFatal: (error) => recordFatal(error, "TAP_LEADER_HALF_OPEN_FAILED"),
      aborting: () => aborting,
    });
    ingressStates.push(gatewayIngress, leaderIngress);
    gatewaySocket.on("data", (chunk) => {
      touch();
      metrics.gatewayIngressReadEvents += 1;
      metrics.gatewayIngressBytes += chunk.length;
      recorder.record({
        role: `${name}-leader-facing-tap`,
        transport: "leader-native-ipc",
        connection,
        stream: "gateway-facing",
        direction: "gateway_to_tap",
        boundary: "read",
        bytes: chunk,
      });
      try {
        gatewayDecoder.push(chunk);
      } catch (error) {
        recordFatal(error, "TAP_GATEWAY_DECODER_FAILED");
        gatewaySocket.destroy();
        realLeaderSocket.destroy();
      }
    });
    realLeaderSocket.on("data", (chunk) => {
      touch();
      recorder.record({
        role: "real-shared-leader",
        transport: "leader-native-ipc",
        connection,
        stream: "real-leader-facing",
        direction: "real_leader_to_tap",
        boundary: "read",
        bytes: chunk,
      });
      try {
        leaderDecoder.push(chunk);
      } catch (error) {
        recordFatal(error, "TAP_LEADER_DECODER_FAILED");
        gatewaySocket.destroy();
        realLeaderSocket.destroy();
      }
    });
  });
  const serverCloseLifecycle = createServerCloseLifecycle(
    server,
    `${name.toUpperCase()}_TAP`,
  );
  server.on("error", (error) => {
    if (!closing) recordFatal(error, "LEADER_TAP_SERVER_ERROR");
  });
  try {
    await listenUnixServer(server, tapPath, `${name.toUpperCase()}_TAP`);
    chmodSync(tapPath, 0o600);
  } catch (error) {
    closing = true;
    let cleanupFailed = false;
    try {
      await closeServerBounded(server, `${name.toUpperCase()}_TAP`, 500);
    } catch {
      cleanupFailed = true;
    }
    rmSync(tapPath, { force: true });
    if (cleanupFailed) throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
    throw asCaptureError(error, "LEADER_TAP_LISTEN_FAILED");
  }
  const barrier = (completionFence) => {
    if (typeof completionFence !== "function") {
      return Promise.reject(new CaptureError(`${name.toUpperCase()}_TAP_OBSERVED_FENCE_REQUIRED`));
    }
    return waitForTransportQuiescence({
      label: `${name.toUpperCase()}_TAP`,
      chainSnapshots,
      writers,
      sockets,
      decoders,
      activityEpoch: () => activity,
      pendingWork: () => pendingWork,
      fault: () => listenerFault,
      observedCompletionFence: completionFence,
    });
  };
  const terminalBarrier = () => waitForTransportQuiescence({
    label: `${name.toUpperCase()}_TAP`,
    chainSnapshots,
    writers,
    sockets,
    decoders,
    activityEpoch: () => activity,
    pendingWork: () => pendingWork,
    fault: () => listenerFault,
    terminal: true,
    completionFence: () => ({
      producerGone: producerGoneCheck(),
      ingressTotal: ingressStates.length,
      ingressTerminated: ingressStates.filter((ingress) => ingress.terminalClean()).length,
      protocolOutstanding: rpcOutstanding.size(),
    }),
  });
  const beginDrain = () => {
    if (closed || closing || closePhase !== "open"
      || mode === ADMISSION_MODES.DRAINING || serverClosePromise) {
      throw new CaptureError(`${name.toUpperCase()}_TAP_DRAIN_PHASE_INVALID`);
    }
    serverClosePromise = serverCloseLifecycle.beginDrain({ closing, closePhase });
    mode = ADMISSION_MODES.DRAINING;
    accepting = false;
    closePhase = "draining";
    touch();
  };
  const drainToZero = async () => {
    if (mode !== ADMISSION_MODES.DRAINING || accepting || !serverClosePromise) {
      throw new CaptureError(`${name.toUpperCase()}_TAP_DRAIN_NOT_STARTED`);
    }
    await barrier(() => rpcOutstanding.size() === 0);
    assertDrainSnapshotReady({
      mode,
      accepting,
      serverCloseStarted: Boolean(serverClosePromise),
      ledgerCount: rpcOutstanding.size(),
      pendingWork,
      writerPending: writers.reduce((sum, writer) => sum + writer.status().pendingSegments, 0),
      writerBufferedBytes: writers.reduce((sum, writer) => sum + writer.status().writableLength, 0),
    });
    drainReadiness.markReady();
    closePhase = "drain_ready";
    touch();
  };
  const validateDrainReady = () => {
    drainReadiness.validate();
    assertDrainSnapshotReady({
      mode,
      accepting,
      serverCloseStarted: Boolean(serverClosePromise),
      ledgerCount: rpcOutstanding.size(),
      pendingWork,
      writerPending: writers.reduce((sum, writer) => sum + writer.status().pendingSegments, 0),
      writerBufferedBytes: writers.reduce((sum, writer) => sum + writer.status().writableLength, 0),
    });
    return true;
  };
  const armProducerShutdown = (isProducerGone) => {
    validateDrainReady();
    assertProducerShutdownArmable({
      mode,
      accepting,
      drainReady: drainReadiness.ready,
      serverCloseStarted: Boolean(serverClosePromise),
      closing,
      closed,
    });
    if (typeof isProducerGone !== "function") {
      throw new CaptureError(`${name.toUpperCase()}_TAP_PRODUCER_GONE_CHECK_REQUIRED`);
    }
    producerGoneCheck = isProducerGone;
    producerShutdownArmed = true;
    closePhase = "producer_shutdown_armed";
    touch();
  };
  const gracefulClose = () => {
    if (closed) return Promise.resolve();
    if (abortPromise) return abortPromise;
    if (closePromise) return closePromise;
    closePhase = "graceful_closing";
    closePromise = (async () => {
      if (!producerShutdownArmed) {
        throw new CaptureError(`${name.toUpperCase()}_TAP_PRODUCER_SHUTDOWN_REQUIRED`);
      }
      await terminalBarrier();
      closing = true;
      await withTimeout(
        Promise.all([
          serverCloseLifecycle.graceful(),
          ...ingressStates.map((ingress) => ingress.eofPromise()),
          ...sockets.map(waitForStreamClose),
        ]),
        IO_TIMEOUT_MS,
        `${name.toUpperCase()}_TAP_GRACEFUL_CLOSE_TIMEOUT`,
      );
      // Ingress is closed here, so a residual decoder tail is terminal.
      decoders.forEach((decoder) => decoder.assertClean());
      if (listenerFault) throw listenerFault;
      closed = true;
      closePhase = "closed";
      rmSync(tapPath, { force: true });
    })().catch((error) => {
      if (!closed) closePhase = "graceful_failed";
      throw error;
    });
    return closePromise;
  };
  const abortClose = () => {
    if (closed) return Promise.resolve();
    if (abortPromise) return abortPromise;
    closePhase = "abort_pending";
    closing = true;
    accepting = false;
    aborting = true;
    abortPromise = (async () => {
      if (closed) return;
      const abortingClose = serverCloseLifecycle.abort(() => {
        writers.forEach((writer) => writer.abort());
        for (const socket of sockets) socket.destroy();
      });
      closePhase = "aborting";
      await withTimeout(
        abortingClose,
        500,
        `${name.toUpperCase()}_TAP_ABORT_SERVER_CLOSE_TIMEOUT`,
      );
      closed = true;
      closePhase = "closed";
      rmSync(tapPath, { force: true });
    })().catch((error) => {
      closePhase = "abort_failed";
      throw error;
    });
    return abortPromise;
  };
  return {
    accepted: () => accepted,
    closed: () => closed,
    metrics: () => ({ ...metrics }),
    decoderCounters: () => decoders.map((decoder) => ({
      label: decoder.label,
      ...decoder.counters,
    })),
    writerCounters: () => writers.map((writer) => ({
      label: writer.label,
      ...writer.counters,
    })),
    flush: barrier,
    beginDrain,
    drainToZero,
    validateDrainReady,
    armProducerShutdown,
    beginProducerShutdown: armProducerShutdown,
    diagnostics: () => ({
      mode,
      accepting,
      drainReadiness: drainReadiness.snapshot(),
      producerShutdownArmed,
      ledger: rpcOutstanding.snapshot(),
      ingress: ingressStates.map((ingress) => ingress.safeSnapshot()),
      writerCounters: writers.map(({ label, counters }) => ({
        label,
        frames: counters.frames,
        requestedBytes: counters.requestedBytes,
        completedBytes: counters.completedBytes,
        pendingSegments: writers.find((writer) => writer.label === label)?.status().pendingSegments || 0,
      })),
    }),
    gracefulClose,
    abortClose,
  };
}

async function startGatewayListener({
  name,
  listenerPath,
  leaderPath,
  recorder,
  admission,
  onFatal,
}) {
  rmSync(listenerPath, { force: true });
  const sockets = [];
  const decoders = [];
  const writers = [];
  const chainSnapshots = [];
  const rpcOutstanding = new RpcOutstandingLedger(`${name}-gateway`);
  const rpcLanes = {
    clientToLeader: `${name}-native-1:client_to_leader`,
    leaderToClient: `${name}-native-1:leader_to_client`,
  };
  let accepted = 0;
  let forceSplitToLeader = true;
  let activity = 0;
  let pendingWork = 0;
  let listenerFault;
  let closing = false;
  let accepting = true;
  let mode = ADMISSION_MODES.NORMAL;
  const drainReadiness = new DrainReadinessTracker(`${name.toUpperCase()}_GATEWAY`);
  let closed = false;
  let producerShutdownArmed = false;
  let producerGoneCheck = () => false;
  let closePhase = "open";
  let closePromise;
  let abortPromise;
  let serverClosePromise;
  let aborting = false;
  const ingressStates = [];
  const metrics = {
    completeFramesFromClient: 0,
    completeFramesFromLeader: 0,
    framesForwardedToLeader: 0,
    bytesForwardedToLeader: 0,
    framesForwardedToClient: 0,
    bytesForwardedToClient: 0,
    locallyRejectedFrames: 0,
    localResponseFrames: 0,
    suppressedNotifications: 0,
    clientResponsesForwardedWhileBlocked: 0,
    blockedRequestFrames: 0,
  };
  const touch = () => { activity += 1; };
  const recordFatal = (error, fallbackCode = "GATEWAY_LISTENER_FATAL") => {
    const failure = asCaptureError(error, fallbackCode);
    if (!listenerFault) listenerFault = failure;
    onFatal(failure);
    for (const socket of sockets) if (!socket.destroyed) socket.destroy();
    return failure;
  };

  const server = createHalfOpenServer((clientSocket) => {
    touch();
    if (!accepting || closing) {
      clientSocket.destroy();
      return;
    }
    accepted += 1;
    if (accepted !== 1) {
      clientSocket.destroy();
      recordFatal(new CaptureError(`${name.toUpperCase()}_MULTIPLE_CLIENTS`));
      return;
    }
    const leaderSocket = createHalfOpenConnection(leaderPath);
    sockets.push(clientSocket, leaderSocket);
    const connection = `${name}-native-1`;
    const toLeader = new FrameWriter(
      leaderSocket,
      `${name}-to-leader`,
      recorder,
      {
        role: `${name}-gateway`,
        transport: "leader-native-ipc",
        connection,
        stream: "leader-facing",
        direction: "gateway_to_leader",
      },
      4096,
      { onActivity: touch },
    );
    const toClient = new FrameWriter(
      clientSocket,
      `leader-to-${name}`,
      recorder,
      {
        role: `${name}-gateway`,
        transport: "leader-native-ipc",
        connection,
        stream: "client-facing",
        direction: "gateway_to_client",
      },
      4096,
      { onActivity: touch },
    );
    writers.push(toLeader, toClient);
    let clientChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    chainSnapshots.push(() => Promise.all([clientChain, leaderChain]));

    const clientDecoder = new IncrementalNativeDecoder(`${name}-client`, (parsed) => {
      drainReadiness.noteIngress(mode === ADMISSION_MODES.DRAINING);
      const message = parsed.inner === undefined
        ? { jsonrpc: "2.0", method: `native/${String(parsed.outer?.type || "invalid")}` }
        : parsed.inner;
      const classification = classifyJsonRpc(message);
      if (classification.kind === "invalid") {
        throw new CaptureError("GATEWAY_CLIENT_RPC_CLASSIFICATION_INVALID");
      }
      if (classification.kind === "request") {
        rpcOutstanding.registerRequest(rpcLanes.clientToLeader, message, {
          direction: "client_to_leader",
        });
      }
      metrics.completeFramesFromClient += 1;
      pendingWork += 1;
      touch();
      clientChain = clientChain.then(async () => {
        const inner = parsed.inner;
        const hasRejectedText = containsMarker(inner, REJECTED_MARKER);
        const action = clientAdmissionAction(mode, classification);
        if (action === "fatal") {
          throw new CaptureError("GATEWAY_CLIENT_ADMISSION_CLASSIFICATION_INVALID");
        }
        if (action === "local_busy") {
          metrics.blockedRequestFrames += 1;
          metrics.locallyRejectedFrames += 1;
          if (name === "tui") {
            const mutating = isTuiMutatingMethod(inner?.method);
            if (mutating) {
              admission.mutatingFramesSeenInWindow += 1;
              admission.mutatingFramesBlockedInWindow += 1;
            }
            const expectedRejectedPrompt = mode === ADMISSION_MODES.REJECT
              && inner?.method === "session/prompt"
              && inner?.id !== undefined
              && hasRejectedText;
            if (!admission.rejected && expectedRejectedPrompt) {
              admission.rejected = true;
              admission.rejectedAt = Date.now();
            } else if (admission.rejected && mutating) {
              admission.postBusyMutatingFramesBlocked += 1;
              if (hasRejectedText) admission.subsequentRejectedTextFrames += 1;
              if (/session\/prompt|steer|inject|replay/i.test(String(inner?.method || ""))) {
                admission.subsequentSteerOrReplayFrames += 1;
              }
            }
          }
          const responseInner = {
            jsonrpc: "2.0",
            id: inner.id,
            error: {
              code: -32001,
              message: "Busy",
              data: {
                reason: mode === ADMISSION_MODES.DRAINING
                  ? "gateway_draining"
                  : "gateway_admission_busy",
                retryable: false,
              },
            },
          };
          const responseOuter = outerWithInner(parsed.outer, responseInner);
          const isMeasuredRejectedPrompt = name === "tui"
            && mode === ADMISSION_MODES.REJECT
            && inner?.method === "session/prompt"
            && hasRejectedText;
          if (isMeasuredRejectedPrompt && !admission.busyResponseSent) {
            admission.originalIdPreserved = responseInner.id === inner.id;
          }
          await toClient.writeFrame(encodeNativeFrame(responseOuter));
          // Commit only after the Busy response writer callback succeeds.
          rpcOutstanding.completeLocally(rpcLanes.clientToLeader, inner.id);
          if (isMeasuredRejectedPrompt) admission.busyResponseSent = true;
          metrics.localResponseFrames += 1;
          return;
        }
        if (action === "suppress_notification") {
          metrics.suppressedNotifications += 1;
          if (name === "tui") admission.nonMutatingFramesSuppressedInWindow += 1;
          return;
        }
        if (action === "forward_response" && mode !== ADMISSION_MODES.NORMAL) {
          metrics.clientResponsesForwardedWhileBlocked += 1;
        }
        if (name === "tui" && inner?.method === "session/prompt"
          && containsMarker(inner, "TUI_GATE_")
          && containsMarker(inner, "RECOVERY_")) {
          admission.tuiRecoveryPromptFrames += 1;
          admission.tuiRecoveryRequestId = inner.id;
        }
        if (name === "acp" && inner?.method === "session/prompt"
          && containsMarker(inner, "FRAME_GATE_")
          && containsMarker(inner, "ALLOWED_")) {
          admission.allowedAcpPromptFrames += 1;
        }
        if (hasRejectedText) {
          admission.rejectedPromptUpstreamFrames += 1;
          admission.rejectedPromptUpstreamBytes += parsed.frame.length;
        }
        const split = forceSplitToLeader;
        forceSplitToLeader = false;
        if (classification.kind === "response") {
          await rpcOutstanding.waitForRequestForward(
            rpcLanes.leaderToClient,
            message,
          );
          rpcOutstanding.assertResponse(rpcLanes.leaderToClient, message);
        }
        await toLeader.writeFrame(parsed.frame, { forceSplitPrefix: split });
        if (classification.kind === "request") {
          rpcOutstanding.commitRequestForward(rpcLanes.clientToLeader, message);
        } else if (classification.kind === "response") {
          rpcOutstanding.commitResponse(rpcLanes.leaderToClient, message);
        }
        metrics.framesForwardedToLeader += 1;
        metrics.bytesForwardedToLeader += parsed.frame.length;
      }).catch((error) => recordFatal(error, "GATEWAY_CLIENT_FORWARD_FAILED"))
        .finally(() => {
          pendingWork -= 1;
          touch();
        });
    });

    const leaderDecoder = new IncrementalNativeDecoder(`${name}-leader`, (parsed) => {
      drainReadiness.noteIngress(mode === ADMISSION_MODES.DRAINING);
      const message = parsed.inner === undefined
        ? { jsonrpc: "2.0", method: `native/${String(parsed.outer?.type || "invalid")}` }
        : parsed.inner;
      const classification = classifyJsonRpc(message);
      if (classification.kind === "invalid") {
        throw new CaptureError("GATEWAY_LEADER_RPC_CLASSIFICATION_INVALID");
      }
      if (classification.kind === "request") {
        rpcOutstanding.registerRequest(rpcLanes.leaderToClient, message, {
          direction: "leader_to_client",
        });
      }
      metrics.completeFramesFromLeader += 1;
      pendingWork += 1;
      touch();
      leaderChain = leaderChain.then(async () => {
        if (classification.kind === "response") {
          await rpcOutstanding.waitForRequestForward(
            rpcLanes.clientToLeader,
            message,
          );
          rpcOutstanding.assertResponse(rpcLanes.clientToLeader, message);
        }
        if (name === "tui" && containsMarker(parsed.inner, ALLOWED_ANSWER)) {
          admission.allowedAnswerFramesToTui += 1;
          progress.allowedAnswerNativeFramesToTui = admission.allowedAnswerFramesToTui;
        }
        if (name === "tui" && admission.allowedCaptureEnabled
          && parsed.inner?.method === "session/update"
          && parsed.inner?.params?.update?.sessionUpdate === "agent_message_chunk"
          && typeof parsed.inner?.params?.update?.content?.text === "string") {
          admission.allowedTuiAgentText += parsed.inner.params.update.content.text;
        }
        if (name === "tui"
          && admission.tuiRecoveryRequestId !== undefined
          && parsed.inner?.method === undefined
          && parsed.inner?.id === admission.tuiRecoveryRequestId
          && (parsed.inner?.result !== undefined || parsed.inner?.error !== undefined)) {
          admission.tuiRecoveryResponseSeen = true;
          admission.tuiRecoveryStopReason = parsed.inner?.result?.stopReason;
        }
        await toClient.writeFrame(parsed.frame);
        if (classification.kind === "request") {
          rpcOutstanding.commitRequestForward(rpcLanes.leaderToClient, message);
        } else if (classification.kind === "response") {
          rpcOutstanding.commitResponse(rpcLanes.clientToLeader, message);
        }
        metrics.framesForwardedToClient += 1;
        metrics.bytesForwardedToClient += parsed.frame.length;
      }).catch((error) => recordFatal(error, "GATEWAY_LEADER_FORWARD_FAILED"))
        .finally(() => {
          pendingWork -= 1;
          touch();
        });
    });
    decoders.push(clientDecoder, leaderDecoder);
    const clientIngress = wireHalfOpenDirection({
      label: `${name.toUpperCase()}_GATEWAY_CLIENT_INGRESS`,
      source: clientSocket,
      target: leaderSocket,
      decoder: clientDecoder,
      chainSnapshot: () => clientChain,
      writer: toLeader,
      onActivity: touch,
      onFatal: (error) => recordFatal(error, "GATEWAY_CLIENT_HALF_OPEN_FAILED"),
      aborting: () => aborting,
    });
    const leaderIngress = wireHalfOpenDirection({
      label: `${name.toUpperCase()}_GATEWAY_LEADER_INGRESS`,
      source: leaderSocket,
      target: clientSocket,
      decoder: leaderDecoder,
      chainSnapshot: () => leaderChain,
      writer: toClient,
      onActivity: touch,
      onFatal: (error) => recordFatal(error, "GATEWAY_LEADER_HALF_OPEN_FAILED"),
      aborting: () => aborting,
    });
    ingressStates.push(clientIngress, leaderIngress);

    clientSocket.on("data", (chunk) => {
      touch();
      recorder.record({
        role: `real-${name}-client`,
        transport: "leader-native-ipc",
        connection,
        stream: "client-facing",
        direction: "client_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      try {
        clientDecoder.push(chunk);
      } catch (error) {
        recordFatal(error, "CLIENT_DECODER_FAILED");
        clientSocket.destroy();
        leaderSocket.destroy();
      }
    });
    leaderSocket.on("data", (chunk) => {
      touch();
      recorder.record({
        role: "shared-leader",
        transport: "leader-native-ipc",
        connection,
        stream: "leader-facing",
        direction: "leader_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      try {
        leaderDecoder.push(chunk);
      } catch (error) {
        recordFatal(error, "LEADER_DECODER_FAILED");
        clientSocket.destroy();
        leaderSocket.destroy();
      }
    });
  });

  const serverCloseLifecycle = createServerCloseLifecycle(
    server,
    `${name.toUpperCase()}_GATEWAY`,
  );

  server.on("error", (error) => {
    if (!closing) recordFatal(error, "GATEWAY_SERVER_ERROR");
  });
  try {
    await listenUnixServer(server, listenerPath, `${name.toUpperCase()}_GATEWAY`);
    chmodSync(listenerPath, 0o600);
  } catch (error) {
    closing = true;
    let cleanupFailed = false;
    try {
      await closeServerBounded(server, `${name.toUpperCase()}_GATEWAY`, 500);
    } catch {
      cleanupFailed = true;
    }
    rmSync(listenerPath, { force: true });
    if (cleanupFailed) throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
    throw asCaptureError(error, "GATEWAY_LISTEN_FAILED");
  }
  const barrier = (completionFence) => {
    if (typeof completionFence !== "function") {
      return Promise.reject(new CaptureError(`${name.toUpperCase()}_GATEWAY_OBSERVED_FENCE_REQUIRED`));
    }
    return waitForTransportQuiescence({
      label: `${name.toUpperCase()}_GATEWAY`,
      chainSnapshots,
      writers,
      sockets,
      decoders,
      activityEpoch: () => activity,
      pendingWork: () => pendingWork,
      fault: () => listenerFault,
      observedCompletionFence: completionFence,
    });
  };
  const terminalBarrier = () => waitForTransportQuiescence({
    label: `${name.toUpperCase()}_GATEWAY`,
    chainSnapshots,
    writers,
    sockets,
    decoders,
    activityEpoch: () => activity,
    pendingWork: () => pendingWork,
    fault: () => listenerFault,
    terminal: true,
    completionFence: () => ({
      producerGone: producerGoneCheck(),
      ingressTotal: ingressStates.length,
      ingressTerminated: ingressStates.filter((ingress) => ingress.terminalClean()).length,
      protocolOutstanding: rpcOutstanding.size(),
    }),
  });
  const setRejectMode = (enabled) => {
    if (mode === ADMISSION_MODES.DRAINING || closing || closed) {
      throw new CaptureError(`${name.toUpperCase()}_GATEWAY_REJECT_PHASE_INVALID`);
    }
    mode = enabled ? ADMISSION_MODES.REJECT : ADMISSION_MODES.NORMAL;
    touch();
  };
  const beginDrain = () => {
    if (closed || closing || closePhase !== "open"
      || mode === ADMISSION_MODES.DRAINING || serverClosePromise) {
      throw new CaptureError(`${name.toUpperCase()}_GATEWAY_DRAIN_PHASE_INVALID`);
    }
    serverClosePromise = serverCloseLifecycle.beginDrain({ closing, closePhase });
    mode = ADMISSION_MODES.DRAINING;
    accepting = false;
    closePhase = "draining";
    touch();
  };
  const drainToZero = async () => {
    if (mode !== ADMISSION_MODES.DRAINING || accepting || !serverClosePromise) {
      throw new CaptureError(`${name.toUpperCase()}_GATEWAY_DRAIN_NOT_STARTED`);
    }
    await barrier(() => rpcOutstanding.size() === 0);
    assertDrainSnapshotReady({
      mode,
      accepting,
      serverCloseStarted: Boolean(serverClosePromise),
      ledgerCount: rpcOutstanding.size(),
      pendingWork,
      writerPending: writers.reduce((sum, writer) => sum + writer.status().pendingSegments, 0),
      writerBufferedBytes: writers.reduce((sum, writer) => sum + writer.status().writableLength, 0),
    });
    drainReadiness.markReady();
    closePhase = "drain_ready";
    touch();
  };
  const validateDrainReady = () => {
    drainReadiness.validate();
    assertDrainSnapshotReady({
      mode,
      accepting,
      serverCloseStarted: Boolean(serverClosePromise),
      ledgerCount: rpcOutstanding.size(),
      pendingWork,
      writerPending: writers.reduce((sum, writer) => sum + writer.status().pendingSegments, 0),
      writerBufferedBytes: writers.reduce((sum, writer) => sum + writer.status().writableLength, 0),
    });
    return true;
  };
  const armProducerShutdown = (isProducerGone) => {
    validateDrainReady();
    assertProducerShutdownArmable({
      mode,
      accepting,
      drainReady: drainReadiness.ready,
      serverCloseStarted: Boolean(serverClosePromise),
      closing,
      closed,
    });
    if (typeof isProducerGone !== "function") {
      throw new CaptureError(`${name.toUpperCase()}_GATEWAY_PRODUCER_GONE_CHECK_REQUIRED`);
    }
    producerGoneCheck = isProducerGone;
    producerShutdownArmed = true;
    closePhase = "producer_shutdown_armed";
    touch();
  };
  const gracefulClose = () => {
    if (closed) return Promise.resolve();
    if (abortPromise) return abortPromise;
    if (closePromise) return closePromise;
    closePhase = "graceful_closing";
    closePromise = (async () => {
      if (!producerShutdownArmed) {
        throw new CaptureError(`${name.toUpperCase()}_GATEWAY_PRODUCER_SHUTDOWN_REQUIRED`);
      }
      await terminalBarrier();
      closing = true;
      await withTimeout(
        Promise.all([
          serverCloseLifecycle.graceful(),
          ...ingressStates.map((ingress) => ingress.eofPromise()),
          ...sockets.map(waitForStreamClose),
        ]),
        IO_TIMEOUT_MS,
        `${name.toUpperCase()}_GATEWAY_GRACEFUL_CLOSE_TIMEOUT`,
      );
      decoders.forEach((decoder) => decoder.assertClean());
      if (listenerFault) throw listenerFault;
      closed = true;
      closePhase = "closed";
      rmSync(listenerPath, { force: true });
    })().catch((error) => {
      if (!closed) closePhase = "graceful_failed";
      throw error;
    });
    return closePromise;
  };
  const abortClose = () => {
    if (closed) return Promise.resolve();
    if (abortPromise) return abortPromise;
    closePhase = "abort_pending";
    closing = true;
    accepting = false;
    aborting = true;
    abortPromise = (async () => {
      if (closed) return;
      const abortingClose = serverCloseLifecycle.abort(() => {
        writers.forEach((writer) => writer.abort());
        for (const socket of sockets) socket.destroy();
      });
      closePhase = "aborting";
      await withTimeout(
        abortingClose,
        500,
        `${name.toUpperCase()}_GATEWAY_ABORT_SERVER_CLOSE_TIMEOUT`,
      );
      closed = true;
      closePhase = "closed";
      rmSync(listenerPath, { force: true });
    })().catch((error) => {
      closePhase = "abort_failed";
      throw error;
    });
    return abortPromise;
  };
  return {
    accepted: () => accepted,
    closed: () => closed,
    metrics: () => ({ ...metrics }),
    decoderCounters: () => decoders.map((decoder) => ({
      label: decoder.label,
      ...decoder.counters,
    })),
    writerCounters: () => writers.map((writer) => ({
      label: writer.label,
      ...writer.counters,
    })),
    flush: barrier,
    setRejectMode,
    beginDrain,
    drainToZero,
    validateDrainReady,
    armProducerShutdown,
    beginProducerShutdown: armProducerShutdown,
    diagnostics: () => ({
      mode,
      accepting,
      drainReadiness: drainReadiness.snapshot(),
      producerShutdownArmed,
      ledger: rpcOutstanding.snapshot(),
      ingress: ingressStates.map((ingress) => ingress.safeSnapshot()),
      writerCounters: writers.map((writer) => ({
        label: writer.label,
        frames: writer.counters.frames,
        requestedBytes: writer.counters.requestedBytes,
        completedBytes: writer.counters.completedBytes,
        pendingSegments: writer.status().pendingSegments,
      })),
    }),
    gracefulClose,
    abortClose,
  };
}

class AcpStdioClient {
  constructor({ binary, socketPath, cwd, env, recorder, onFatal }) {
    this.binary = binary;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.env = env;
    this.recorder = recorder;
    this.onFatal = onFatal;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.notifications = [];
    this.stderr = Buffer.alloc(0);
    this.closing = false;
    this.closePhase = "open";
    this.closePromise = undefined;
  }

  async connect() {
    this.child = spawn(this.binary, [
      "agent", "--leader", "--leader-socket", this.socketPath, "stdio",
    ], {
      cwd: this.cwd,
      env: this.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lifecycle = monitorChildProcess(this.child, "ACP_CHILD");
    this.child.once("close", () => {
      const error = new CaptureError("ACP_CHILD_CLOSED");
      this.rejectAllPending(error);
      if (!this.closing) this.onFatal(error);
    });
    this.child.once("error", () => {
      const error = new CaptureError("ACP_CHILD_PROCESS_ERROR");
      this.rejectAllPending(error);
      this.onFatal(error);
    });
    this.child.stdout.on("data", (chunk) => {
      try {
        this.onStdout(chunk);
      } catch (error) {
        const failure = asCaptureError(error, "ACP_STDOUT_PROCESSING_FAILED");
        this.rejectAllPending(failure);
        this.onFatal(failure);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-32_768);
    });
    try {
      const initialized = await this.call(
        "initialize",
        buildFrameAwareAcpInitializeParams(),
        30_000,
      );
      if (!Array.isArray(initialized?.authMethods)
        || !initialized.authMethods.some((method) => method?.id === "cached_token")) {
        throw new CaptureError("CACHED_TOKEN_AUTH_NOT_ADVERTISED");
      }
      await this.call("authenticate", {
        methodId: "cached_token",
        meta: { headless: true },
      }, 30_000);
    } catch (error) {
      try {
        await this.abortClose();
      } catch {
        throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
      }
      throw error;
    }
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params, timeoutMs = 90_000) {
    if (!this.child || this.closing || this.lifecycle?.closed()) {
      return Promise.reject(new CaptureError("ACP_CHILD_NOT_WRITABLE"));
    }
    const id = this.nextId++;
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    this.recorder.record({
      role: "acp-stdio-client",
      transport: "acp-stdio",
      connection: "acp-stdio-1",
      stream: "stdin",
      direction: "client_to_grok",
      boundary: "write",
      bytes,
    });
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new CaptureError("ACP_REQUEST_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (result) => {
          clearTimeout(timer);
          resolveRequest(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      try {
        this.child.stdin.write(bytes, (error) => {
          if (!error) return;
          const pending = this.pending.get(String(id));
          if (!pending) return;
          this.pending.delete(String(id));
          pending.reject(new CaptureError("ACP_STDIN_WRITE_FAILED"));
        });
      } catch {
        const pending = this.pending.get(String(id));
        this.pending.delete(String(id));
        pending?.reject(new CaptureError("ACP_STDIN_WRITE_FAILED"));
      }
    });
    promise.catch(() => {});
    return promise;
  }

  writeResponse(frame) {
    if (!this.child || this.closing || this.lifecycle?.closed()) return;
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    this.recorder.record({
      role: "acp-stdio-client",
      transport: "acp-stdio",
      connection: "acp-stdio-1",
      stream: "stdin",
      direction: "client_to_grok",
      boundary: "write",
      bytes,
    });
    try {
      this.child.stdin.write(bytes, (error) => {
        if (error) this.onFatal(new CaptureError("ACP_RESPONSE_WRITE_FAILED"));
      });
    } catch {
      this.onFatal(new CaptureError("ACP_RESPONSE_WRITE_FAILED"));
    }
  }

  call(method, params, timeoutMs) {
    return this.request(method, params, timeoutMs);
  }

  onStdout(chunk) {
    const bytes = Buffer.from(chunk);
    this.recorder.record({
      role: "acp-stdio-client",
      transport: "acp-stdio",
      connection: "acp-stdio-1",
      stream: "stdout",
      direction: "grok_to_client",
      boundary: "read",
      bytes,
    });
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    let newline;
    while ((newline = this.stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new CaptureError("ACP_STDOUT_NON_JSON");
      }
      if (message?.method && message?.id !== undefined) {
        const methodClass = message.method === "session/request_permission"
          ? "PERMISSION"
          : /^fs\//.test(message.method)
            ? "FILESYSTEM"
            : "OTHER";
        const error = new CaptureError(`UNEXPECTED_ACP_SERVER_REQUEST_${methodClass}`);
        this.writeResponse({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "capture scenario rejects unexpected client request" },
        });
        this.onFatal(error);
        this.rejectAllPending(error);
        continue;
      }
      if (message?.id !== undefined) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new CaptureError("ACP_JSONRPC_ERROR"));
        else pending.resolve(message.result);
      } else if (message?.method) {
        this.notifications.push({ at: Date.now(), message });
      }
    }
  }

  textSince(startedAt) {
    return this.notifications
      .filter(({ at }) => at >= startedAt)
      .map(({ message }) => {
        const update = message?.params?.update;
        return update?.sessionUpdate === "agent_message_chunk"
          && typeof update?.content?.text === "string"
          ? update.content.text
          : "";
      })
      .join("");
  }

  sawRejectedMarker(startedAt) {
    return this.notifications.some(({ at, message }) =>
      at >= startedAt && containsMarker(message, REJECTED_MARKER));
  }

  promptCompleteSince(startedAt) {
    return this.notifications.find(({ at, message }) =>
      at >= startedAt && message?.method === "_x.ai/session/prompt_complete");
  }

  treeGone() {
    return Boolean(this.lifecycle?.treeGone());
  }

  gracefulClose() {
    if (!this.child || this.lifecycle?.treeGone()) {
      this.rejectAllPending(new CaptureError("ACP_CLIENT_CLOSED"));
      return Promise.resolve();
    }
    if (this.closePromise) return this.closePromise;
    this.closePhase = "graceful_closing";
    this.closePromise = (async () => {
      this.closing = true;
      this.rejectAllPending(new CaptureError("ACP_CLIENT_CLOSING"));
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      try {
        await withTimeout(this.lifecycle.closedPromise, 750, "ACP_STDIN_CLOSE_TIMEOUT");
      } catch (error) {
        if (!(error instanceof CaptureError) || error.code !== "ACP_STDIN_CLOSE_TIMEOUT") throw error;
        await terminateProcessTree(this.lifecycle, "ACP_CHILD");
      }
      if (!this.lifecycle.treeGone()) {
        await terminateProcessTree(this.lifecycle, "ACP_CHILD");
      }
      this.closePhase = "closed";
    })().catch((error) => {
      this.closePhase = "graceful_failed";
      throw error;
    });
    return this.closePromise;
  }

  abortClose() {
    if (!this.child || this.lifecycle?.treeGone()) return Promise.resolve();
    if (this.closePhase === "abort_pending" || this.closePhase === "aborting") {
      return this.closePromise;
    }
    const priorClose = this.closePromise;
    this.closePhase = "abort_pending";
    this.closePromise = (async () => {
      if (priorClose) await priorClose.catch(() => {});
      if (this.lifecycle.treeGone()) return;
      this.closePhase = "aborting";
      this.closing = true;
      this.rejectAllPending(new CaptureError("ACP_CLIENT_ABORTED"));
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      await terminateProcessTree(this.lifecycle, "ACP_CHILD", { abort: true });
      this.closePhase = "closed";
    })().catch((error) => {
      this.closePhase = "abort_failed";
      throw error;
    });
    return this.closePromise;
  }
}

function buildFrameAwareAcpInitializeParams() {
  return {
    protocolVersion: "1",
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "test223-frame-aware-admission", version: "1" },
  };
}

async function startTui({
  binary,
  socketPath,
  cwd,
  sessionId,
  env,
  identityPath,
  protocolReady,
}) {
  if (typeof identityPath !== "string" || dirname(identityPath) === identityPath) {
    throw new CaptureError("TUI_PRODUCER_IDENTITY_PATH_REQUIRED");
  }
  if (typeof protocolReady !== "function") {
    throw new CaptureError("TUI_PROTOCOL_READINESS_CHECK_REQUIRED");
  }
  const identityDirectory = statSync(dirname(identityPath));
  if (!identityDirectory.isDirectory()
    || identityDirectory.uid !== process.getuid()
    || (identityDirectory.mode & 0o777) !== 0o700) {
    throw new CaptureError("TUI_PRODUCER_IDENTITY_DIRECTORY_NOT_PRIVATE");
  }
  rmSync(identityPath, { force: true });
  rmSync(`${identityPath}.tmp`, { force: true });
  const argv = [
    binary,
    "--leader", "--leader-socket", socketPath,
    "--cwd", cwd,
    "--resume", sessionId,
    "--permission-mode", "default",
    "--no-subagents",
    "--disallowed-tools", "search_tool,use_tool",
    "--no-alt-screen",
    "--minimal",
  ];
  const identityPrelude = buildPtyIdentityPrelude(identityPath);
  const command = `${identityPrelude}; stty rows 40 cols 140; exec ${argv.map(shellQuote).join(" ")}`;
  const launchGeneration = randomBytes(32).toString("hex");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd,
    env: {
      ...env,
      TERM: "xterm-256color",
      COLUMNS: "140",
      LINES: "40",
      // Explicit non-credential lifecycle key. The shell removes it only
      // after atomic identity publication, before exec of the Grok binary.
      [TUI_LAUNCH_GENERATION_ENV]: launchGeneration,
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startup = bindTuiProducerStartup({
    child,
    identityPath,
    launchGeneration,
    expectedExecutable: binary,
    label: "TUI",
  });
  const { wrapperLifecycle } = startup;
  let output = Buffer.alloc(0);
  const terminal = new TerminalScreen(40, 140);
  let ptyWrites = 0;
  let ptyWriteBytes = 0;
  const append = (chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]).subarray(-2_000_000);
    terminal.feed(chunk);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let producerLifecycle;
  let lifecycle;
  try {
    producerLifecycle = await startup.waitForIdentity(15_000);
    lifecycle = startup.composite();
    await startup.waitForExecutable(15_000);
    await waitFor(
      () => output.length >= 120 || wrapperLifecycle.closed(),
      15_000,
      "TUI_INITIAL_FRAME_TIMEOUT",
    );
    if (wrapperLifecycle.closed() || !producerLifecycle.executableReady()) {
      throw new CaptureError("TUI_EXITED_DURING_STARTUP");
    }
    await waitFor(
      () => protocolReady() || wrapperLifecycle.closed() || !producerLifecycle.executableReady(),
      15_000,
      "TUI_PROTOCOL_READINESS_TIMEOUT",
    );
    if (wrapperLifecycle.closed() || !producerLifecycle.executableReady() || !protocolReady()) {
      throw new CaptureError("TUI_EXITED_BEFORE_PROTOCOL_READINESS");
    }
  } catch (error) {
    child.stdin.destroy();
    try {
      await startup.cleanup();
    } catch {
      throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
    }
    throw error;
  }
  let closing = false;
  let closePhase = "open";
  let closePromise;
  return {
    child,
    async submit(prompt) {
      if (closing || wrapperLifecycle.closed() || !producerLifecycle.executableReady()) {
        throw new CaptureError("TUI_CHILD_NOT_WRITABLE");
      }
      const bytes = Buffer.from(`${prompt}\r`);
      ptyWrites += 1;
      ptyWriteBytes += bytes.length;
      await writeStreamBounded(child.stdin, bytes, "TUI_STDIN");
    },
    containsVisible(value) {
      return terminal.text().includes(value) || visibleText(output).includes(value);
    },
    alive() {
      return !wrapperLifecycle.closed() && producerLifecycle.executableReady();
    },
    treeGone() {
      return lifecycle.treeGone();
    },
    counters() {
      return { ptyWrites, ptyWriteBytes };
    },
    outputSha256() {
      return createHash("sha256").update(output).digest("hex");
    },
    gracefulClose() {
      if (closePromise) return closePromise;
      closePhase = "graceful_closing";
      closePromise = (async () => {
        closing = true;
        if (!lifecycle.treeGone()) {
          child.stdin.end();
          try {
            await waitForCompositeTreeGone(lifecycle, 750, "TUI_PTY_EOF_EXIT_TIMEOUT");
          } catch (error) {
            if (!(error instanceof CaptureError)
              || error.code !== "TUI_PTY_EOF_EXIT_TIMEOUT") throw error;
            await terminateTuiProcessTree(lifecycle, "TUI");
          }
        }
        await startup.cleanup();
        closePhase = "closed";
      })().catch((error) => {
        closePhase = "graceful_failed";
        throw error;
      });
      return closePromise;
    },
    abortClose() {
      if (closePhase === "abort_pending" || closePhase === "aborting") return closePromise;
      const priorClose = closePromise;
      closePhase = "abort_pending";
      closePromise = (async () => {
        if (await reconcilePriorTuiCloseForAbort(priorClose, lifecycle, startup)) {
          closePhase = "closed";
          return;
        }
        closePhase = "aborting";
        closing = true;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await terminateTuiProcessTree(lifecycle, "TUI", { abort: true });
        await startup.cleanup();
        closePhase = "closed";
      })().catch((error) => {
        closePhase = "abort_failed";
        throw error;
      });
      return closePromise;
    },
  };
}

async function main() {
  const binary = process.env.GROK_BINARY;
  const authPath = process.env.GROK_AUTH_PATH;
  const rawOutput = process.env.RAW_OUTPUT || process.argv[2];
  if (!binary) throw new CaptureError("GROK_BINARY_REQUIRED");
  if (!authPath) throw new CaptureError("GROK_AUTH_PATH_REQUIRED");
  if (!rawOutput) throw new CaptureError("RAW_OUTPUT_REQUIRED");
  const parserSelfTest = runDecoderSelfTest();

  const root = resolve(process.env.SCENARIO_ROOT || "/tmp/test223-frame-aware-admission");
  if (!root.startsWith("/tmp/")) throw new CaptureError("SCENARIO_ROOT_MUST_BE_TMP");
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const runtime = join(root, "runtime");
  for (const directory of [home, cwd, runtime]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = childEnvironment(home, authPath);
  const agentId = join(dirname(authPath), "agent_id");
  if (existsSync(agentId)) symlinkSync(agentId, join(home, "agent_id"));
  const versionResult = spawnSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (versionResult.status !== 0 || String(versionResult.stdout || "").trim() !== EXPECTED_VERSION) {
    throw new CaptureError("PINNED_GROK_VERSION_MISMATCH");
  }
  const pinnedBinarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const scriptSha256 = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");

  const leaderPath = join(runtime, "leader.sock");
  const tuiTapPath = join(runtime, "tui-leader-tap.sock");
  const acpTapPath = join(runtime, "acp-leader-tap.sock");
  const tuiGatewayPath = join(runtime, "tui-gateway.sock");
  const acpGatewayPath = join(runtime, "acp-gateway.sock");
  const leader = spawn(binary, [
    "agent", "leader",
    "--no-exit-on-disconnect",
    "--relay-on-demand",
    "--no-auto-update",
    "--leader-socket", leaderPath,
  ], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const leaderLifecycle = monitorChildProcess(leader, "LEADER");
  let leaderStderr = Buffer.alloc(0);
  leader.stderr.on("data", (chunk) => {
    leaderStderr = Buffer.concat([leaderStderr, Buffer.from(chunk)]).subarray(-32_768);
  });

  let recorder;
  let tuiTap;
  let acpTap;
  let tuiGateway;
  let acpGateway;
  let acp;
  let tui;
  let fatal;
  const onFatal = (error) => {
    if (!fatal) fatal = error instanceof CaptureError ? error : new CaptureError("GATEWAY_FATAL");
  };
  const admission = new AdmissionState();
  try {
    await waitFor(() => {
      if (leaderLifecycle.closed()) {
        throw new CaptureError("LEADER_EXITED_DURING_STARTUP");
      }
      if (!existsSync(leaderPath)) return false;
      const entry = lstatSync(leaderPath);
      return entry.isSocket() && !entry.isSymbolicLink();
    }, 15_000, "LEADER_SOCKET_TIMEOUT");
    if (statSync(leaderPath).uid !== process.getuid()) {
      throw new CaptureError("LEADER_SOCKET_OWNER_MISMATCH");
    }
    recorder = new ByteRecorder(rawOutput, CAPTURE, {
      generation: 1,
      grokBuild: "0.2.93-f00f96316d",
    });
    tuiTap = await startLeaderFacingTap({
      name: "tui",
      tapPath: tuiTapPath,
      leaderPath,
      recorder,
      onFatal,
    });
    acpTap = await startLeaderFacingTap({
      name: "acp",
      tapPath: acpTapPath,
      leaderPath,
      recorder,
      onFatal,
    });
    tuiGateway = await startGatewayListener({
      name: "tui",
      listenerPath: tuiGatewayPath,
      leaderPath: tuiTapPath,
      recorder,
      admission,
      onFatal,
    });
    acpGateway = await startGatewayListener({
      name: "acp",
      listenerPath: acpGatewayPath,
      leaderPath: acpTapPath,
      recorder,
      admission,
      onFatal,
    });
    acp = new AcpStdioClient({
      binary,
      socketPath: acpGatewayPath,
      cwd,
      env,
      recorder,
      onFatal,
    });
    await acp.connect();
    await waitFor(() => acpGateway.accepted() === 1, 10_000, "ACP_GATEWAY_NOT_CONNECTED");
    await waitFor(() => acpTap.accepted() === 1, 10_000, "ACP_LEADER_TAP_NOT_CONNECTED");
    const created = await acp.call("session/new", { cwd, mcpServers: [] }, 30_000);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new CaptureError("SESSION_NEW_NO_ID");
    const readyResult = await acp.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    });
    tui = await startTui({
      binary,
      socketPath: tuiGatewayPath,
      cwd,
      sessionId,
      env,
      identityPath: join(
        runtime,
        `tui-producer.${randomBytes(16).toString("hex")}.identity.json`,
      ),
      protocolReady: () => tuiGateway.accepted() === 1
        && tuiTap.accepted() === 1
        && tuiGateway.metrics().completeFramesFromClient > 0
        && tuiTap.metrics().gatewayIngressCompleteFrames > 0,
    });
    await waitFor(() => tuiGateway.accepted() === 1, 10_000, "TUI_GATEWAY_NOT_CONNECTED");
    await waitFor(() => tuiTap.accepted() === 1, 10_000, "TUI_LEADER_TAP_NOT_CONNECTED");
    if (fatal) throw fatal;

    const tuiAttachedFence = () => readyResult?.stopReason === "end_turn"
      && tui.alive()
      && tuiGateway.accepted() === 1
      && tuiTap.accepted() === 1;
    await Promise.all([
      tuiGateway.flush(tuiAttachedFence), tuiTap.flush(tuiAttachedFence),
    ]);
    const rejectionTapBefore = tuiTap.metrics();
    tuiGateway.setRejectMode(true);
    const rejectedStartedAt = Date.now();
    await tui.submit(`Reply exactly ${REJECTED_MARKER}.`);
    await waitFor(
      () => admission.busyResponseSent || fatal,
      10_000,
      "TUI_BUSY_RESPONSE_TIMEOUT",
    );
    if (fatal) throw fatal;
    const busyResponseFence = () => admission.rejected && admission.busyResponseSent;
    await tuiGateway.flush(busyResponseFence);
    if (!admission.rejected || !admission.originalIdPreserved || !admission.busyResponseSent) {
      throw new CaptureError("TUI_STRUCTURED_BUSY_REJECTION_NOT_PROVEN");
    }
    progress.rejectionProven = true;
    if (admission.rejectedPromptUpstreamFrames !== 0
      || admission.rejectedPromptUpstreamBytes !== 0) {
      throw new CaptureError("REJECTED_TUI_PROMPT_REACHED_LEADER");
    }
    await sleep(2_000);
    const rejectionWindowFence = () => busyResponseFence()
      && Date.now() - admission.rejectedAt >= 2_000;
    await Promise.all([
      tuiGateway.flush(rejectionWindowFence), tuiTap.flush(rejectionWindowFence),
    ]);
    const rejectionTapAfter = tuiTap.metrics();
    const rejectionTapDelta = {
      frames: rejectionTapAfter.gatewayIngressRequestFrames
        - rejectionTapBefore.gatewayIngressRequestFrames,
      bytes: rejectionTapAfter.gatewayIngressRequestBytes
        - rejectionTapBefore.gatewayIngressRequestBytes,
    };
    if (rejectionTapDelta.frames !== 0 || rejectionTapDelta.bytes !== 0) {
      throw new CaptureError("LEADER_TAP_REJECTION_WINDOW_DELTA_NONZERO");
    }
    tuiGateway.setRejectMode(false);
    if (fatal) throw fatal;
    if (!tui.alive()) throw new CaptureError("TUI_EXITED_AFTER_BUSY_REJECTION");
    progress.tuiAliveAfterRejection = true;
    if (admission.subsequentRejectedTextFrames !== 0
      || admission.subsequentSteerOrReplayFrames !== 0
      || acp.sawRejectedMarker(rejectedStartedAt)) {
      throw new CaptureError("TUI_RETRIED_STEERED_OR_REPLAYED_REJECTED_TEXT");
    }
    if (admission.mutatingFramesSeenInWindow !== admission.mutatingFramesBlockedInWindow
      || admission.mutatingFramesSeenInWindow < 1) {
      throw new CaptureError("REJECTION_WINDOW_MUTATION_ACCOUNTING_MISMATCH");
    }

    const recoveryStartedAt = Date.now();
    await tui.submit(RECOVERY_PROMPT);
    await waitFor(() => admission.tuiRecoveryPromptFrames === 1 || fatal, 10_000, "TUI_RECOVERY_PROMPT_NOT_FORWARDED");
    await waitFor(() => acp.promptCompleteSince(recoveryStartedAt) || fatal, 90_000, "TUI_RECOVERY_PROMPT_NOT_COMPLETED");
    await waitFor(() => admission.tuiRecoveryResponseSeen || fatal, 10_000, "TUI_RECOVERY_RESPONSE_NOT_SEEN");
    const recoveryText = acp.textSince(recoveryStartedAt).trim();
    if (recoveryText.length === 0 || admission.tuiRecoveryStopReason !== "end_turn") {
      throw new CaptureError("TUI_RECOVERY_PROTOCOL_COMPLETION_MISMATCH");
    }
    progress.tuiRecoveryCompleted = true;

    const allowedStartedAt = Date.now();
    admission.allowedCaptureEnabled = true;
    admission.allowedTuiAgentText = "";
    const promptResult = await acp.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: ALLOWED_PROMPT }],
    });
    progress.allowedPromptStopReason = promptResult?.stopReason;
    const answer = acp.textSince(allowedStartedAt).trim();
    progress.allowedAcpAnswerExact = answer === ALLOWED_ANSWER;
    if (!progress.allowedAcpAnswerExact || promptResult?.stopReason !== "end_turn") {
      throw new CaptureError("ALLOWED_ACP_PROMPT_RESULT_MISMATCH");
    }
    await waitFor(
      () => admission.allowedTuiAgentText.includes(ALLOWED_ANSWER) || fatal,
      10_000,
      "ALLOWED_ANSWER_NOT_BROADCAST_TO_TUI_NATIVE",
    );
    progress.allowedAnswerNativeFramesToTui = admission.allowedTuiAgentText.includes(ALLOWED_ANSWER)
      ? 1
      : 0;
    await waitFor(() => tui.containsVisible(ALLOWED_ANSWER) || fatal, 10_000, "ALLOWED_ANSWER_NOT_RENDERED_IN_TUI");
    progress.allowedAnswerRenderedInTui = tui.containsVisible(ALLOWED_ANSWER);
    if (fatal) throw fatal;
    const completedTurnsFence = () => progress.tuiRecoveryCompleted
      && progress.allowedAcpAnswerExact
      && progress.allowedAnswerRenderedInTui
      && promptResult?.stopReason === "end_turn";
    await Promise.all([
      tuiGateway.flush(completedTurnsFence),
      acpGateway.flush(completedTurnsFence),
      tuiTap.flush(completedTurnsFence),
      acpTap.flush(completedTurnsFence),
    ]);
    if (admission.allowedAcpPromptFrames !== 1) {
      throw new CaptureError("ALLOWED_ACP_PROMPT_FORWARD_COUNT_MISMATCH");
    }
    if (!tui.alive()) throw new CaptureError("TUI_EXITED_AFTER_ALLOWED_PROMPT");
    const pty = tui.counters();
    if (pty.ptyWrites !== 2) throw new CaptureError("UNEXPECTED_PTY_WRITE_COUNT");

    const listenerCounts = {
      tuiGateway: tuiGateway.accepted(),
      acpGateway: acpGateway.accepted(),
      tuiLeaderTap: tuiTap.accepted(),
      acpLeaderTap: acpTap.accepted(),
    };
    if (Object.values(listenerCounts).some((count) => count !== 1)) {
      throw new CaptureError("LISTENER_ACCEPT_COUNT_MISMATCH");
    }
    const gatewayWriters = [
      ...tuiGateway.writerCounters(),
      ...acpGateway.writerCounters(),
    ];
    if (gatewayWriters.length !== 4
      || gatewayWriters.some((writer) => writer.requestedBytes <= 0
        || writer.completedBytes !== writer.requestedBytes)) {
      throw new CaptureError("GATEWAY_WRITER_ACCOUNTING_MISMATCH");
    }
    const liveDecoders = [
      ...tuiGateway.decoderCounters(),
      ...acpGateway.decoderCounters(),
      ...tuiTap.decoderCounters(),
      ...acpTap.decoderCounters(),
    ];
    const liveSplit = liveDecoders.reduce((sum, decoder) =>
      sum + decoder.splitPrefixReads + decoder.splitPayloadReads, 0);
    const liveCoalesced = liveDecoders.reduce((sum, decoder) =>
      sum + decoder.coalescedReads, 0);
    if (liveSplit <= 0 || liveCoalesced <= 0) {
      throw new CaptureError("LIVE_SPLIT_COALESCED_PATH_NOT_OBSERVED");
    }

    // Freeze every producer before snapshotting counters or hashing the raw
    // capture. A TUI client may emit a final native log frame while exiting;
    // taking the summary before this shutdown used to leave the persisted byte
    // artifact four records ahead of the summary.
    const tuiOutputSha256 = tui.outputSha256();
    await Promise.all([
      tuiGateway.flush(completedTurnsFence),
      acpGateway.flush(completedTurnsFence),
      tuiTap.flush(completedTurnsFence),
      acpTap.flush(completedTurnsFence),
    ]);
    const closingTui = tui;
    const closingAcp = acp;
    const closedTuiGateway = tuiGateway;
    const closedAcpGateway = acpGateway;
    const closedTuiTap = tuiTap;
    const closedAcpTap = acpTap;
    // Stop admission atomically at all four public listeners before any
    // producer is asked to exit. Gateways enter DRAINING (new requests get a
    // local Busy, notifications may be suppressed, responses still flow).
    // Taps remain transparent but stop accepting replacement connections.
    closedTuiGateway.beginDrain();
    closedAcpGateway.beginDrain();
    closedTuiTap.beginDrain();
    closedAcpTap.beginDrain();
    await coordinatedDrainAndArm([
      { listener: closedTuiGateway, producerGone: () => closingTui.treeGone() },
      { listener: closedAcpGateway, producerGone: () => closingAcp.treeGone() },
    ], { label: "GATEWAY_COHORT_DRAIN" });
    await Promise.all([closingTui.gracefulClose(), closingAcp.gracefulClose()]);
    tui = undefined;
    acp = undefined;
    const childProducersGoneFence = () => closingTui.treeGone() && closingAcp.treeGone();

    let previousTransportSnapshot;
    let stableTransportRounds = 0;
    for (let attempt = 0; attempt < 20 && stableTransportRounds < 2; attempt += 1) {
      await Promise.all([
        closedTuiGateway.flush(childProducersGoneFence),
        closedAcpGateway.flush(childProducersGoneFence),
      ]);
      await Promise.all([
        closedTuiTap.flush(childProducersGoneFence),
        closedAcpTap.flush(childProducersGoneFence),
      ]);
      await Promise.all([
        closedTuiGateway.flush(childProducersGoneFence),
        closedAcpGateway.flush(childProducersGoneFence),
      ]);
      await sleep(10);
      const transportSnapshot = JSON.stringify({
        records: recorder.sequence,
        writers: [
          ...closedTuiGateway.writerCounters(),
          ...closedAcpGateway.writerCounters(),
          ...closedTuiTap.writerCounters(),
          ...closedAcpTap.writerCounters(),
        ],
      });
      if (transportSnapshot === previousTransportSnapshot) stableTransportRounds += 1;
      else stableTransportRounds = 0;
      previousTransportSnapshot = transportSnapshot;
    }
    if (stableTransportRounds < 2) {
      throw new CaptureError("TRANSPORT_DID_NOT_REACH_FIXED_POINT");
    }
    await Promise.all([
      closedTuiGateway.flush(childProducersGoneFence),
      closedAcpGateway.flush(childProducersGoneFence),
    ]);
    await Promise.all([
      closedTuiGateway.gracefulClose(), closedAcpGateway.gracefulClose(),
    ]);
    tuiGateway = undefined;
    acpGateway = undefined;

    await coordinatedDrainAndArm([
      { listener: closedTuiTap, producerGone: () => closedTuiGateway.closed() },
      { listener: closedAcpTap, producerGone: () => closedAcpGateway.closed() },
    ], { label: "TAP_COHORT_DRAIN" });
    await Promise.all([closedTuiTap.gracefulClose(), closedAcpTap.gracefulClose()]);
    tuiTap = undefined;
    acpTap = undefined;
    if (fatal) throw fatal;

    const finalGatewayWriters = [
      ...closedTuiGateway.writerCounters(),
      ...closedAcpGateway.writerCounters(),
    ];
    if (finalGatewayWriters.length !== 4
      || finalGatewayWriters.some((writer) => writer.requestedBytes <= 0
        || writer.completedBytes !== writer.requestedBytes)) {
      throw new CaptureError("FINAL_GATEWAY_WRITER_ACCOUNTING_MISMATCH");
    }
    const finalLiveDecoders = [
      ...closedTuiGateway.decoderCounters(),
      ...closedAcpGateway.decoderCounters(),
      ...closedTuiTap.decoderCounters(),
      ...closedAcpTap.decoderCounters(),
    ];
    const finalLiveSplit = finalLiveDecoders.reduce((sum, decoder) =>
      sum + decoder.splitPrefixReads + decoder.splitPayloadReads, 0);
    const finalLiveCoalesced = finalLiveDecoders.reduce((sum, decoder) =>
      sum + decoder.coalescedReads, 0);
    if (finalLiveSplit <= 0 || finalLiveCoalesced <= 0) {
      throw new CaptureError("FINAL_LIVE_SPLIT_COALESCED_PATH_NOT_OBSERVED");
    }

    await terminateProcessTree(leaderLifecycle, "LEADER");
    recorder.close();
    recorder = undefined;
    const rawBytes = readFileSync(rawOutput);
    return {
      ok: true,
      scenario: CAPTURE,
      protocolFreeze: false,
      grokVersion: EXPECTED_VERSION,
      pinnedBinarySha256,
      scriptSha256,
      parser: parserSelfTest,
      topology: {
        listeners: ["gateway-owned-tui", "gateway-owned-acp-child"],
        admissionOwner: "tui-gateway-listener",
        maximumFrameBytes: MAX_FRAME_BYTES,
        acceptedConnections: listenerCounts,
      },
      rejection: {
        method: "session/prompt",
        response: "json-rpc Busy error",
        originalJsonRpcIdPreserved: true,
        framesForwardedUpstreamForRejectedPrompt: 0,
        bytesForwardedUpstreamForRejectedPrompt: 0,
        independentLeaderTapWindowDelta: rejectionTapDelta,
        independentLeaderTapWindowDeltaScope: "blocked client request frames only",
        mutatingFramesSeen: admission.mutatingFramesSeenInWindow,
        mutatingFramesBlocked: admission.mutatingFramesBlockedInWindow,
        postBusyMutatingFramesBlocked: admission.postBusyMutatingFramesBlocked,
        nonMutatingFramesSuppressed: admission.nonMutatingFramesSuppressedInWindow,
        subsequentRetryFrames: 0,
        subsequentSteerOrReplayFrames: 0,
        rejectedTextObservedByAcpClient: false,
        tuiAlive: true,
      },
      tuiRecovery: {
        sessionPromptFramesForwarded: admission.tuiRecoveryPromptFrames,
        originalRequestCompleted: admission.tuiRecoveryResponseSeen,
        promptCompleteObserved: true,
        stopReason: admission.tuiRecoveryStopReason,
        nonEmptyAnswerObservedByAcp: true,
        tuiAlive: true,
      },
      allowed: {
        source: "ACP child through separate gateway listener",
        sessionPromptFramesForwarded: 1,
        stopReason: "end_turn",
        answerRenderedInTrueTui: true,
        expectedAnswerWasAbsentFromPrompt: !ALLOWED_PROMPT.includes(ALLOWED_ANSWER),
        tuiAlive: true,
      },
      ptyInput: {
        writes: pty.ptyWrites,
        bytes: pty.ptyWriteBytes,
        tmuxOrSendKeysUsed: false,
      },
      gatewayMetrics: {
        tui: closedTuiGateway.metrics(),
        acp: closedAcpGateway.metrics(),
        tuiDecoders: closedTuiGateway.decoderCounters(),
        acpDecoders: closedAcpGateway.decoderCounters(),
        tuiWriters: closedTuiGateway.writerCounters(),
        acpWriters: closedAcpGateway.writerCounters(),
        tuiLeaderTap: closedTuiTap.metrics(),
        acpLeaderTap: closedAcpTap.metrics(),
        tuiTapDecoders: closedTuiTap.decoderCounters(),
        acpTapDecoders: closedAcpTap.decoderCounters(),
        tuiTapWriters: closedTuiTap.writerCounters(),
        acpTapWriters: closedAcpTap.writerCounters(),
        gatewayAllFourWritersBalanced: true,
        liveSplitCounter: finalLiveSplit,
        liveCoalescedCounter: finalLiveCoalesced,
      },
      safeLifecycleDiagnostics: {
        tuiGateway: closedTuiGateway.diagnostics(),
        acpGateway: closedAcpGateway.diagnostics(),
        tuiLeaderTap: closedTuiTap.diagnostics(),
        acpLeaderTap: closedAcpTap.diagnostics(),
        containsRawIdsOrBodies: false,
      },
      tuiOutputSha256,
      rawCapture: {
        storage: "RAW_OUTPUT below RAW_DIR tmpfs only",
        records: rawBytes.toString("utf8").split("\n").filter(Boolean).length,
        sha256: createHash("sha256").update(rawBytes).digest("hex"),
      },
    };
  } finally {
    const cleanupFailures = [];
    const cleanupBatches = [
      [() => tui?.abortClose(), () => acp?.abortClose()],
      [() => tuiGateway?.abortClose(), () => acpGateway?.abortClose()],
      [() => tuiTap?.abortClose(), () => acpTap?.abortClose()],
      [() => terminateProcessTree(leaderLifecycle, "LEADER", { abort: true })],
    ];
    for (const batch of cleanupBatches) {
      const results = await Promise.allSettled(
        batch.map((operation) => Promise.resolve().then(operation)),
      );
      cleanupFailures.push(...results.filter(({ status }) => status === "rejected"));
    }
    try {
      recorder?.close();
    } catch (error) {
      cleanupFailures.push({ status: "rejected", reason: error });
    }
    if (cleanupFailures.length !== 0) {
      throw new CaptureError("FRAME_AWARE_CLEANUP_FAILED");
    }
  }
}

export {
  ADMISSION_MODES,
  CaptureError,
  DrainReadinessTracker,
  FrameWriter,
  IncrementalNativeDecoder,
  RpcOutstandingLedger,
  assertDrainSnapshotReady,
  assertProducerShutdownArmable,
  bindPtyProducerIdentity,
  bindTuiProducerStartup,
  buildFrameAwareAcpInitializeParams,
  buildPtyIdentityPrelude,
  classifyJsonRpc,
  clientAdmissionAction,
  commitTuiIdentityCleanup,
  coordinatedDrainAndArm,
  createHalfOpenConnection,
  createHalfOpenServer,
  createServerCloseLifecycle,
  environmentBlockContainsLaunchGeneration,
  freezeSessionGeneration,
  listSessionMembers,
  monitorFixedProducerIdentity,
  monitorChildProcess,
  monitorTuiProcessTree,
  observeLinearizedLaunchHandoff,
  reconcilePriorTuiCloseForAbort,
  readLinuxProcessTuple,
  shouldSuppressShutdownSocketError,
  terminateTuiProcessTree,
  terminateProcessTree,
  waitForTransportQuiescence,
  wireHalfOpenDirection,
};

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  let summary;
  let exitCode = 0;
  try {
    summary = await main();
  } catch (error) {
    exitCode = 1;
    summary = {
      ok: false,
      scenario: CAPTURE,
      protocolFreeze: false,
      errorCode: error instanceof CaptureError ? error.code : "UNEXPECTED_CAPTURE_FAILURE",
      observedBeforeFailure: progress,
      safety: {
        rawPayloadPrinted: false,
        rawIdsPrinted: false,
        rawPathsPrinted: false,
        rawAccountPrinted: false,
        tmuxOrSendKeysUsed: false,
      },
    };
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCode;
}
