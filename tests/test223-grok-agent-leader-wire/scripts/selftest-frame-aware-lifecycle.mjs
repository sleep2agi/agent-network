import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection as createDefaultConnection,
  createServer as createDefaultServer,
} from "node:net";
import { join } from "node:path";
import {
  CaptureError,
  DrainReadinessTracker,
  ADMISSION_MODES,
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
} from "./live-frame-aware-admission-capture.mjs";

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitUntil(predicate, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeIdentity(identityPath, identity) {
  writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  chmodSync(identityPath, 0o600);
}

function spawnPtyHarness({ identityPath, beforeIdentity = "", afterIdentity }) {
  const launchGeneration = randomBytes(32).toString("hex");
  const command = [
    beforeIdentity,
    buildPtyIdentityPrelude(identityPath),
    afterIdentity,
  ].filter(Boolean).join("; ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ANET_TUI_LAUNCH_GENERATION: launchGeneration,
    },
  });
  const startup = bindTuiProducerStartup({
    child,
    identityPath,
    launchGeneration,
    expectedExecutable: process.execPath,
    label: "SELFTEST_PTY",
  });
  return { child, startup, lifecycle: startup.wrapperLifecycle, launchGeneration };
}

const recorder = {
  record() {},
};

function frameAwareAcpInitializeContractIsStable() {
  const params = buildFrameAwareAcpInitializeParams();
  const expected = {
    protocolVersion: "1",
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "test223-frame-aware-admission", version: "1" },
  };
  if (JSON.stringify(params) !== JSON.stringify(expected)) {
    throw new Error("frame-aware ACP initialize contract drifted");
  }
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function encodeRpcFrame(message) {
  return encodeFrame({ type: "acp", payload: message });
}

class FakeSocket extends EventEmitter {
  constructor(writeImpl) {
    super();
    this.writeImpl = writeImpl;
    this.destroyed = false;
    this.closed = false;
    this.writableLength = 0;
    this.writableEnded = false;
    this.writeCalls = 0;
    this.destroyCalls = 0;
    this.endCalls = 0;
  }

  write(bytes, callback) {
    this.writeCalls += 1;
    return this.writeImpl.call(this, Buffer.from(bytes), callback);
  }

  destroy() {
    this.destroyCalls += 1;
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.writableLength = 0;
    queueMicrotask(() => this.emit("close"));
  }

  end(callback) {
    this.endCalls += 1;
    this.writableEnded = true;
    queueMicrotask(() => callback?.());
  }
}

function createSuccessfulSocket() {
  return new FakeSocket(function writeSuccessfully(bytes, callback) {
    this.writableLength += bytes.length;
    queueMicrotask(() => {
      this.writableLength -= bytes.length;
      callback();
    });
    return true;
  });
}

function createRpcWireHarness(label) {
  const clientSocket = createSuccessfulSocket();
  const leaderSocket = createSuccessfulSocket();
  let activity = 0;
  let pendingWork = 0;
  let clientChain = Promise.resolve();
  let leaderChain = Promise.resolve();
  const touch = () => { activity += 1; };
  const ledger = new RpcOutstandingLedger(label);
  const lanes = {
    clientToLeader: `${label}:client_to_leader`,
    leaderToClient: `${label}:leader_to_client`,
  };
  const toLeader = new FrameWriter(
    leaderSocket,
    `${label}-to-leader`,
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100, onActivity: touch },
  );
  const toClient = new FrameWriter(
    clientSocket,
    `${label}-to-client`,
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100, onActivity: touch },
  );
  const clientDecoder = new IncrementalNativeDecoder(`${label}-client`, (parsed) => {
    const classification = classifyJsonRpc(parsed.inner);
    if (classification.kind === "request") {
      ledger.registerRequest(lanes.clientToLeader, parsed.inner);
    } else if (classification.kind === "invalid") {
      throw new CaptureError("SELFTEST_CLIENT_RPC_INVALID");
    }
    pendingWork += 1;
    touch();
    clientChain = clientChain
      .then(async () => {
        if (classification.kind === "response") {
          ledger.assertResponse(lanes.leaderToClient, parsed.inner);
        }
        await toLeader.writeFrame(parsed.frame);
        if (classification.kind === "request") {
          ledger.commitRequestForward(lanes.clientToLeader, parsed.inner);
        } else if (classification.kind === "response") {
          ledger.commitResponse(lanes.leaderToClient, parsed.inner);
        }
      })
      .finally(() => {
        pendingWork -= 1;
        touch();
      });
  });
  const leaderDecoder = new IncrementalNativeDecoder(`${label}-leader`, (parsed) => {
    const classification = classifyJsonRpc(parsed.inner);
    if (classification.kind === "request") {
      ledger.registerRequest(lanes.leaderToClient, parsed.inner);
    } else if (classification.kind === "invalid") {
      throw new CaptureError("SELFTEST_LEADER_RPC_INVALID");
    }
    pendingWork += 1;
    touch();
    leaderChain = leaderChain
      .then(async () => {
        if (classification.kind === "response") {
          ledger.assertResponse(lanes.clientToLeader, parsed.inner);
        }
        await toClient.writeFrame(parsed.frame);
        if (classification.kind === "request") {
          ledger.commitRequestForward(lanes.leaderToClient, parsed.inner);
        } else if (classification.kind === "response") {
          ledger.commitResponse(lanes.clientToLeader, parsed.inner);
        }
      })
      .finally(() => {
        pendingWork -= 1;
        touch();
      });
  });
  const writers = [toLeader, toClient];
  const sockets = [leaderSocket, clientSocket];
  const decoders = [clientDecoder, leaderDecoder];
  const terminal = (timeoutMs = 120) => waitForTransportQuiescence({
    label,
    chainSnapshots: [() => clientChain, () => leaderChain],
    writers,
    sockets,
    decoders,
    activityEpoch: () => activity,
    pendingWork: () => pendingWork,
    timeoutMs,
    terminal: true,
    completionFence: () => ({
      producerGone: true,
      ingressTotal: 2,
      ingressTerminated: 2,
      protocolOutstanding: ledger.size(),
    }),
  });
  return {
    ledger,
    lanes,
    pushClient(message) {
      touch();
      clientDecoder.push(encodeRpcFrame(message));
      touch();
    },
    pushLeader(message) {
      touch();
      leaderDecoder.push(encodeRpcFrame(message));
      touch();
    },
    terminal,
    async drainForwarding() {
      await Promise.all([clientChain, leaderChain]);
      await Promise.all(writers.map((writer) => writer.flush()));
    },
    writerCounters() {
      return writers.map(({ counters }) => ({ ...counters }));
    },
  };
}

async function expectCaptureCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CaptureError && error.code === code) return;
    throw new Error(`expected ${code}, got ${error?.code || error?.message || error}`);
  }
  throw new Error(`expected ${code}, operation resolved`);
}

async function closeBeforeDrainIsSingleSettlement() {
  const socket = new FakeSocket(function writeCloseBeforeDrain(bytes, callback) {
    this.writableLength = bytes.length;
    setTimeout(() => {
      this.destroyed = true;
      this.closed = true;
      this.writableLength = 0;
      this.emit("close");
    }, 5);
    setTimeout(() => {
      callback();
      this.emit("drain");
    }, 20);
    return false;
  });
  const writer = new FrameWriter(
    socket,
    "selftest-close-before-drain",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100 },
  );
  await expectCaptureCode(
    writer.writeFrame(Buffer.from("one-frame")),
    "NATIVE_SOCKET_CLOSED_BEFORE_WRITE_COMPLETE",
  );
  await sleep(30);
  if (writer.counters.completedBytes !== 0 || socket.writeCalls !== 1) {
    throw new Error("close-before-drain was counted complete or replayed");
  }
  await expectCaptureCode(
    writer.writeFrame(Buffer.from("must-not-retry")),
    "NATIVE_SOCKET_CLOSED_BEFORE_WRITE_COMPLETE",
  );
  if (socket.writeCalls !== 1) throw new Error("failed writer retried a frame");
}

async function neverCallbackFailsBoundedly() {
  const socket = new FakeSocket(function writeWithoutCallback(bytes) {
    this.writableLength = bytes.length;
    return true;
  });
  const writer = new FrameWriter(
    socket,
    "selftest-never-callback",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 35 },
  );
  const startedAt = Date.now();
  await expectCaptureCode(
    writer.writeFrame(Buffer.from("one-frame")),
    "NATIVE_SOCKET_WRITE_TIMEOUT",
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 250 || !socket.destroyed || socket.writeCalls !== 1) {
    throw new Error("never-callback path was not bounded and fail-closed");
  }
}

async function partialFrameFailsAtBarrier() {
  const decoder = new IncrementalNativeDecoder("selftest-partial-barrier");
  decoder.push(Buffer.from([0x00, 0x00]));
  await expectCaptureCode(waitForTransportQuiescence({
    label: "SELFTEST_PARTIAL",
    decoders: [decoder],
    timeoutMs: 120,
    quietMs: 10,
  }), "PARTIAL_FRAME_AT_BARRIER");
}

async function terminalCompletionFencePreventsEarlyReturn() {
  let activity = 0;
  let producerGone = false;
  let ingressTerminated = 0;
  let protocolOutstanding = 0;
  const seen = [];
  const decoder = new IncrementalNativeDecoder(
    "selftest-terminal-delayed-complete",
    (frame) => {
      seen.push(frame);
      protocolOutstanding += 1;
      activity += 1;
      setTimeout(() => {
        protocolOutstanding -= 1;
        activity += 1;
      }, 45);
    },
  );
  const startedAt = Date.now();
  const delayed = setTimeout(() => {
    activity += 1;
    decoder.push(encodeFrame({ type: "delayed-beyond-quiet" }));
    activity += 1;
  }, 60);
  const producerClosed = setTimeout(() => {
    producerGone = true;
    ingressTerminated = 1;
    activity += 1;
  }, 85);
  await waitForTransportQuiescence({
    label: "SELFTEST_TERMINAL_DELAYED_COMPLETE",
    decoders: [decoder],
    activityEpoch: () => activity,
    timeoutMs: 350,
    quietMs: 10,
    terminal: true,
    completionFence: () => ({
      producerGone,
      ingressTotal: 1,
      ingressTerminated,
      protocolOutstanding,
    }),
  });
  clearTimeout(delayed);
  clearTimeout(producerClosed);
  if (seen.length !== 1 || protocolOutstanding !== 0 || Date.now() - startedAt < 100) {
    throw new Error("terminal fence returned before delayed frame and protocol completion");
  }
}

async function terminalModeRequiresExplicitFence() {
  await expectCaptureCode(waitForTransportQuiescence({
    label: "SELFTEST_TERMINAL_WITHOUT_FENCE",
    terminal: true,
    timeoutMs: 50,
    quietMs: 5,
  }), "SELFTEST_TERMINAL_WITHOUT_FENCE_TERMINAL_COMPLETION_FENCE_REQUIRED");
}

async function terminalFenceRequiresEveryCondition() {
  const cases = [
    {
      name: "PRODUCER_LIVE",
      completion: {
        producerGone: false,
        ingressTotal: 2,
        ingressTerminated: 2,
        protocolOutstanding: 0,
      },
    },
    {
      name: "INGRESS_OPEN",
      completion: {
        producerGone: true,
        ingressTotal: 2,
        ingressTerminated: 1,
        protocolOutstanding: 0,
      },
    },
    {
      name: "PROTOCOL_OUTSTANDING",
      completion: {
        producerGone: true,
        ingressTotal: 2,
        ingressTerminated: 2,
        protocolOutstanding: 1,
      },
    },
  ];
  for (const { name, completion } of cases) {
    await expectCaptureCode(waitForTransportQuiescence({
      label: `SELFTEST_TERMINAL_${name}`,
      terminal: true,
      completionFence: () => completion,
      timeoutMs: 35,
      quietMs: 5,
    }), `SELFTEST_TERMINAL_${name}_TERMINAL_COMPLETION_FENCE_TIMEOUT`);
  }
}

async function forwardedRequestWithoutResponseStaysOutstanding() {
  const harness = createRpcWireHarness("SELFTEST_RPC_MISSING_RESPONSE");
  harness.pushClient({
    jsonrpc: "2.0",
    id: 41,
    method: "session/prompt",
    params: { shape: "selftest" },
  });
  await harness.drainForwarding();
  const [toLeader] = harness.writerCounters();
  if (toLeader.frames !== 1
    || toLeader.requestedBytes === 0
    || toLeader.completedBytes !== toLeader.requestedBytes
    || harness.ledger.size() !== 1) {
    throw new Error("request was not fully forwarded and retained as outstanding");
  }
  await expectCaptureCode(
    harness.terminal(45),
    "SELFTEST_RPC_MISSING_RESPONSE_TERMINAL_COMPLETION_FENCE_TIMEOUT",
  );
}

async function requestResponsePairClearsOutstanding() {
  const harness = createRpcWireHarness("SELFTEST_RPC_PAIR");
  harness.pushClient({
    jsonrpc: "2.0",
    id: "pair-1",
    method: "session/prompt",
    params: { shape: "selftest" },
  });
  await harness.drainForwarding();
  harness.pushLeader({ jsonrpc: "2.0", id: "pair-1", result: { stopReason: "end_turn" } });
  await harness.drainForwarding();
  if (harness.ledger.size() !== 0) throw new Error("matching response did not clear request");
  await harness.terminal();
}

async function typedIdsAndDirectionsCannotCrossClear() {
  const harness = createRpcWireHarness("SELFTEST_RPC_TYPED_LANES");
  harness.pushClient({ jsonrpc: "2.0", id: 7, method: "client/request", params: {} });
  harness.pushClient({ jsonrpc: "2.0", id: "7", method: "client/request", params: {} });
  harness.pushLeader({ jsonrpc: "2.0", id: 7, method: "leader/request", params: {} });
  await harness.drainForwarding();
  if (harness.ledger.size() !== 3) {
    throw new Error("typed ids or opposite request lanes collided during registration");
  }
  harness.pushLeader({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  await harness.drainForwarding();
  if (harness.ledger.size() !== 2) {
    throw new Error("numeric response cleared string id or wrong-direction request");
  }
  await expectCaptureCode(
    harness.terminal(45),
    "SELFTEST_RPC_TYPED_LANES_TERMINAL_COMPLETION_FENCE_TIMEOUT",
  );
  harness.pushLeader({ jsonrpc: "2.0", id: "7", result: { ok: true } });
  harness.pushClient({ jsonrpc: "2.0", id: 7, error: { code: -1, message: "closed" } });
  await harness.drainForwarding();
  if (harness.ledger.size() !== 0) {
    throw new Error("exact typed/directional responses did not clear remaining requests");
  }
  await harness.terminal();
}

async function localBusyClearsOnlyAfterResponseWrite() {
  const ledger = new RpcOutstandingLedger("SELFTEST_RPC_LOCAL_BUSY");
  const lane = "SELFTEST_RPC_LOCAL_BUSY:client_to_leader";
  const request = {
    jsonrpc: "2.0",
    id: "busy-1",
    method: "session/prompt",
    params: { shape: "selftest" },
  };
  ledger.registerRequest(lane, request);
  // No cancel terminal method is present in the checked fixture. A guessed
  // cancel-looking notification must therefore leave the real request open.
  const cancelNotification = {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { id: "busy-1" },
  };
  if (classifyJsonRpc(cancelNotification).kind !== "notification") {
    throw new Error("cancel-looking notification was not classified as notification");
  }
  if (ledger.size() !== 1) {
    throw new Error("unobserved cancel shape incorrectly cleared outstanding request");
  }
  const socket = createSuccessfulSocket();
  const writer = new FrameWriter(
    socket,
    "selftest-local-busy-writer",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100 },
  );
  await writer.writeFrame(encodeRpcFrame({
    jsonrpc: "2.0",
    id: "busy-1",
    error: { code: -32001, message: "Busy" },
  }));
  await writer.flush();
  if (ledger.size() !== 1) throw new Error("request cleared before local Busy completion");
  ledger.completeLocally(lane, "busy-1");
  if (ledger.size() !== 0) throw new Error("written local Busy did not clear exact request");
}

function jsonRpcClassificationIsExact() {
  const cases = [
    [{ jsonrpc: "2.0", id: 1, method: "m", params: {} }, "request"],
    [{ jsonrpc: "2.0", method: "m", params: {} }, "notification"],
    [{ jsonrpc: "2.0", id: "one", result: {} }, "response"],
    [{ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }, "response"],
    [{ jsonrpc: "1.0", id: 1, method: "m" }, "invalid"],
    [{ jsonrpc: "2.0", id: 1, method: "m", result: {} }, "invalid"],
    [{ jsonrpc: "2.0", id: 1 }, "invalid"],
    [{ jsonrpc: "2.0", id: null, method: "m" }, "invalid"],
    [{ jsonrpc: "2.0", id: 1, result: {}, error: {} }, "invalid"],
  ];
  for (const [message, expected] of cases) {
    if (classifyJsonRpc(message).kind !== expected) {
      throw new Error(`classification mismatch for expected ${expected}`);
    }
  }
}

async function matchingResponseClosesOnlyAfterEgressCommit() {
  const ledger = new RpcOutstandingLedger("SELFTEST_RESPONSE_COMMIT");
  const lane = "SELFTEST_RESPONSE_COMMIT:client_to_leader";
  const request = { jsonrpc: "2.0", id: 88, method: "session/prompt", params: {} };
  ledger.registerRequest(lane, request);
  ledger.commitRequestForward(lane, request);
  const response = { jsonrpc: "2.0", id: 88, result: { ok: true } };
  const socket = new FakeSocket(function delayedResponseWrite(bytes, callback) {
    this.writableLength += bytes.length;
    setTimeout(() => {
      this.writableLength -= bytes.length;
      callback();
    }, 35);
    return true;
  });
  const writer = new FrameWriter(
    socket,
    "selftest-response-commit",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100 },
  );
  ledger.assertResponse(lane, response);
  const write = writer.writeFrame(encodeRpcFrame(response));
  await sleep(10);
  if (ledger.size() !== 1) throw new Error("response cleared before egress writer callback");
  await write;
  ledger.commitResponse(lane, response);
  if (ledger.size() !== 0) throw new Error("response did not clear after egress commit");
}

async function allBlockedRequestsReceiveBusyWithoutLeaderWrite() {
  const methods = [
    "session/prompt",
    "session/steer",
    "session/inject",
    "session/replay",
    "session/update",
  ];
  for (const [index, method] of methods.entries()) {
    const ledger = new RpcOutstandingLedger(`SELFTEST_BLOCKED_${index}`);
    const lane = `SELFTEST_BLOCKED_${index}:client_to_leader`;
    const request = {
      jsonrpc: "2.0",
      id: index % 2 === 0 ? index + 100 : `blocked-${index}`,
      method,
      params: { shape: "not-recorded" },
    };
    const classification = classifyJsonRpc(request);
    ledger.registerRequest(lane, request);
    if (clientAdmissionAction(ADMISSION_MODES.REJECT, classification) !== "local_busy") {
      throw new Error(`${method} was not rejected locally`);
    }
    const clientSocket = createSuccessfulSocket();
    const leaderSocket = createSuccessfulSocket();
    const clientWriter = new FrameWriter(
      clientSocket,
      `selftest-blocked-${index}`,
      recorder,
      {},
      4096,
      { writeTimeoutMs: 100 },
    );
    const busy = {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32001, message: "Busy" },
    };
    if (ledger.size() !== 1) throw new Error("blocked request was closed before Busy write");
    await clientWriter.writeFrame(encodeRpcFrame(busy));
    ledger.completeLocally(lane, request.id);
    if (ledger.size() !== 0 || clientSocket.writeCalls !== 1 || leaderSocket.writeCalls !== 0) {
      throw new Error(`${method} Busy did not close exactly once with Leader zero-write`);
    }
  }
}

async function responsesForwardInRejectAndDraining() {
  for (const mode of [ADMISSION_MODES.REJECT, ADMISSION_MODES.DRAINING]) {
    const ledger = new RpcOutstandingLedger(`SELFTEST_RESPONSE_${mode}`);
    const reverseLane = `SELFTEST_RESPONSE_${mode}:leader_to_client`;
    const request = {
      jsonrpc: "2.0",
      id: `reverse-${mode}`,
      method: "client/capability",
      params: {},
    };
    ledger.registerRequest(reverseLane, request);
    ledger.commitRequestForward(reverseLane, request);
    const response = { jsonrpc: "2.0", id: request.id, result: { ok: true } };
    const classification = classifyJsonRpc(response);
    if (clientAdmissionAction(mode, classification) !== "forward_response") {
      throw new Error(`${mode} dropped a client response`);
    }
    const leaderSocket = createSuccessfulSocket();
    const writer = new FrameWriter(
      leaderSocket,
      `selftest-response-${mode}`,
      recorder,
      {},
      4096,
      { writeTimeoutMs: 100 },
    );
    ledger.assertResponse(reverseLane, response);
    await writer.writeFrame(encodeRpcFrame(response));
    if (ledger.size() !== 1) throw new Error(`${mode} cleared response before egress commit`);
    ledger.commitResponse(reverseLane, response);
    if (ledger.size() !== 0 || leaderSocket.writeCalls !== 1) {
      throw new Error(`${mode} response did not forward and clear at commit`);
    }
  }
}

async function busyWriterCommitAndFailureAreFailClosed() {
  const lane = "SELFTEST_BUSY_CALLBACK:client_to_leader";
  const request = {
    jsonrpc: "2.0",
    id: "busy-callback",
    method: "session/prompt",
    params: {},
  };
  const ledger = new RpcOutstandingLedger("SELFTEST_BUSY_CALLBACK");
  ledger.registerRequest(lane, request);
  const delayedSocket = new FakeSocket(function delayedWrite(bytes, callback) {
    this.writableLength += bytes.length;
    setTimeout(() => {
      this.writableLength -= bytes.length;
      callback();
    }, 35);
    return true;
  });
  const delayedWriter = new FrameWriter(
    delayedSocket,
    "selftest-busy-delayed-callback",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100 },
  );
  const pendingWrite = delayedWriter.writeFrame(encodeRpcFrame({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32001, message: "Busy" },
  }));
  await sleep(10);
  if (ledger.size() !== 1) throw new Error("Busy ledger cleared before writer callback");
  await pendingWrite;
  ledger.completeLocally(lane, request.id);
  if (ledger.size() !== 0) throw new Error("Busy ledger did not clear after writer callback");

  const failedLedger = new RpcOutstandingLedger("SELFTEST_BUSY_FAILURE");
  failedLedger.registerRequest(lane, request);
  const failedSocket = new FakeSocket(function failedWrite(_bytes, callback) {
    queueMicrotask(() => callback(new Error("shape-only write failure")));
    return true;
  });
  const failedWriter = new FrameWriter(
    failedSocket,
    "selftest-busy-failure",
    recorder,
    {},
    4096,
    { writeTimeoutMs: 100 },
  );
  await expectCaptureCode(
    failedWriter.writeFrame(encodeRpcFrame({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32001, message: "Busy" },
    })),
    "NATIVE_SOCKET_WRITE_FAILED",
  );
  if (failedLedger.size() !== 1) throw new Error("failed Busy write incorrectly closed ledger");
}

function drainAndArmGuardsFailClosed() {
  const ready = {
    mode: ADMISSION_MODES.DRAINING,
    accepting: false,
    serverCloseStarted: true,
    ledgerCount: 0,
    pendingWork: 0,
    writerPending: 0,
    writerBufferedBytes: 0,
  };
  assertDrainSnapshotReady(ready);
  for (const mutation of [
    { ledgerCount: 1 },
    { pendingWork: 1 },
    { writerPending: 1 },
    { writerBufferedBytes: 1 },
  ]) {
    try {
      assertDrainSnapshotReady({ ...ready, ...mutation });
      throw new Error("outstanding drain snapshot was accepted");
    } catch (error) {
      if (!(error instanceof CaptureError) || error.code !== "DRAIN_OUTSTANDING_WORK") throw error;
    }
  }
  const armed = {
    mode: ADMISSION_MODES.DRAINING,
    accepting: false,
    drainReady: true,
    serverCloseStarted: true,
    closing: false,
    closed: false,
  };
  assertProducerShutdownArmable(armed);
  for (const mutation of [
    { mode: ADMISSION_MODES.NORMAL },
    { accepting: true },
    { drainReady: false },
    { serverCloseStarted: false },
  ]) {
    try {
      assertProducerShutdownArmable({ ...armed, ...mutation });
      throw new Error("producer shutdown armed before a completed drain");
    } catch (error) {
      if (!(error instanceof CaptureError)
        || error.code !== "PRODUCER_SHUTDOWN_ARM_BEFORE_DRAIN") throw error;
    }
  }
}

class SyntheticProductionDrainListener {
  constructor(label, { firstDrainDelayMs = 0, onFirstReady } = {}) {
    this.label = label;
    this.tracker = new DrainReadinessTracker(label);
    this.firstDrainDelayMs = firstDrainDelayMs;
    this.onFirstReady = onFirstReady;
    this.drains = 0;
    this.ledgerCount = 0;
    this.pendingWork = 0;
    this.writerPending = 0;
    this.writerBufferedBytes = 0;
    this.armed = false;
  }

  ingress({ ledger = 0, pending = 1, buffered = 1, completeAfterMs = 30 } = {}) {
    this.tracker.noteIngress(true);
    this.ledgerCount += ledger;
    this.pendingWork += pending;
    this.writerPending += pending;
    this.writerBufferedBytes += buffered;
    setTimeout(() => {
      this.ledgerCount -= ledger;
      this.pendingWork -= pending;
      this.writerPending -= pending;
      this.writerBufferedBytes -= buffered;
    }, completeAfterMs);
  }

  currentSnapshot() {
    return {
      mode: ADMISSION_MODES.DRAINING,
      accepting: false,
      serverCloseStarted: true,
      ledgerCount: this.ledgerCount,
      pendingWork: this.pendingWork,
      writerPending: this.writerPending,
      writerBufferedBytes: this.writerBufferedBytes,
    };
  }

  async drainToZero() {
    this.drains += 1;
    if (this.drains === 1 && this.firstDrainDelayMs > 0) {
      await sleep(this.firstDrainDelayMs);
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      try {
        assertDrainSnapshotReady(this.currentSnapshot());
        this.tracker.markReady();
        if (this.drains === 1) this.onFirstReady?.();
        return;
      } catch (error) {
        if (!(error instanceof CaptureError)
          || error.code !== "DRAIN_OUTSTANDING_WORK") throw error;
      }
      await sleep(2);
    }
    throw new CaptureError(`${this.label}_DRAIN_TIMEOUT`);
  }

  validateDrainReady() {
    this.tracker.validate();
    assertDrainSnapshotReady(this.currentSnapshot());
  }

  armProducerShutdown() {
    this.validateDrainReady();
    this.armed = true;
  }
}

async function coordinatedDrainInvalidationIsProductionBound() {
  let firstReadyResolve;
  const firstReady = new Promise((resolveReady) => { firstReadyResolve = resolveReady; });
  const gatewayA = new SyntheticProductionDrainListener("SYNTH_GATEWAY_A", {
    onFirstReady: () => {
      firstReadyResolve();
      setTimeout(() => gatewayA.ingress({
        ledger: 1,
        pending: 1,
        buffered: 64,
        completeAfterMs: 45,
      }), 2);
    },
  });
  const gatewayB = new SyntheticProductionDrainListener("SYNTH_GATEWAY_B", {
    firstDrainDelayMs: 20,
  });
  const coordinated = coordinatedDrainAndArm([
    { listener: gatewayA, producerGone: () => false },
    { listener: gatewayB, producerGone: () => false },
  ], { timeoutMs: 1_000, label: "SELFTEST_GATEWAY_COHORT" });
  await firstReady;
  await sleep(5);
  try {
    gatewayA.armProducerShutdown();
    throw new Error("late Busy frame did not invalidate ready before arm");
  } catch (error) {
    if (!(error instanceof CaptureError)
      || error.code !== "SYNTH_GATEWAY_A_DRAIN_READY_STALE") throw error;
  }
  const gatewayResult = await coordinated;
  if (!gatewayA.armed || !gatewayB.armed || gatewayResult.attempts < 2
    || gatewayA.drains < 2 || gatewayB.drains < 2) {
    throw new Error("gateway cohort did not redrain and arm together");
  }

  let tapReadyResolve;
  const tapReady = new Promise((resolveReady) => { tapReadyResolve = resolveReady; });
  const tapA = new SyntheticProductionDrainListener("SYNTH_TAP_A", {
    onFirstReady: () => {
      tapReadyResolve();
      setTimeout(() => tapA.ingress({
        ledger: 0,
        pending: 1,
        buffered: 32,
        completeAfterMs: 35,
      }), 2);
    },
  });
  const tapB = new SyntheticProductionDrainListener("SYNTH_TAP_B", {
    firstDrainDelayMs: 18,
  });
  const tapCoordinated = coordinatedDrainAndArm([
    { listener: tapA, producerGone: () => false },
    { listener: tapB, producerGone: () => false },
  ], { timeoutMs: 1_000, label: "SELFTEST_TAP_COHORT" });
  await tapReady;
  await sleep(5);
  try {
    tapA.validateDrainReady();
    throw new Error("late tap frame did not invalidate ready");
  } catch (error) {
    if (!(error instanceof CaptureError)
      || error.code !== "SYNTH_TAP_A_DRAIN_READY_STALE") throw error;
  }
  const tapResult = await tapCoordinated;
  if (!tapA.armed || !tapB.armed || tapResult.attempts < 2) {
    throw new Error("tap cohort did not redrain and arm together");
  }
}

function createHalfOpenHarness(label) {
  const front = createSuccessfulSocket();
  const backend = createSuccessfulSocket();
  const fatals = [];
  let frontChain = Promise.resolve();
  let backendChain = Promise.resolve();
  const toBackend = new FrameWriter(
    backend,
    `${label}-to-backend`,
    recorder,
    {},
    4096,
    { writeTimeoutMs: 150 },
  );
  const toFront = new FrameWriter(
    front,
    `${label}-to-front`,
    recorder,
    {},
    4096,
    { writeTimeoutMs: 150 },
  );
  const frontDecoder = new IncrementalNativeDecoder(`${label}-front`, ({ frame }) => {
    frontChain = frontChain.then(() => toBackend.writeFrame(frame));
  });
  const backendDecoder = new IncrementalNativeDecoder(`${label}-backend`, ({ frame }) => {
    backendChain = backendChain.then(() => toFront.writeFrame(frame));
  });
  const rememberFatal = (error) => { fatals.push(error); };
  const frontIngress = wireHalfOpenDirection({
    label: `${label}_FRONT`,
    source: front,
    target: backend,
    decoder: frontDecoder,
    chainSnapshot: () => frontChain,
    writer: toBackend,
    onFatal: rememberFatal,
  });
  const backendIngress = wireHalfOpenDirection({
    label: `${label}_BACKEND`,
    source: backend,
    target: front,
    decoder: backendDecoder,
    chainSnapshot: () => backendChain,
    writer: toFront,
    onFatal: rememberFatal,
  });
  return {
    front,
    backend,
    fatals,
    frontDecoder,
    backendDecoder,
    frontIngress,
    backendIngress,
    async settleEof() {
      await Promise.all([frontIngress.eofPromise(), backendIngress.eofPromise()]);
      await Promise.allSettled([frontChain, backendChain]);
    },
  };
}

async function halfOpenAllowsDelayedReverseResponse() {
  const harness = createHalfOpenHarness("SELFTEST_HALF_OPEN_DELAYED");
  harness.frontDecoder.push(encodeRpcFrame({
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: {},
  }));
  harness.front.emit("end");
  await sleep(80);
  if (!harness.backend.writableEnded || harness.front.writableEnded) {
    throw new Error("front EOF did not half-close only the forward direction");
  }
  harness.backendDecoder.push(encodeRpcFrame({
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  }));
  harness.backend.emit("end");
  await harness.settleEof();
  harness.front.emit("close", false);
  harness.backend.emit("close", false);
  await sleep(0);
  if (harness.fatals.length !== 0
    || harness.front.writeCalls !== 1
    || harness.backend.writeCalls !== 1
    || !harness.frontIngress.terminalClean()
    || !harness.backendIngress.terminalClean()) {
    throw new Error("delayed reverse response did not survive clean half-open relay");
  }
}

async function earlyOppositeFinIsRejected() {
  const harness = createHalfOpenHarness("SELFTEST_EARLY_FIN");
  harness.front.emit("end");
  await harness.frontIngress.eofPromise();
  // This models default allowHalfOpen=false: ending the forward target causes
  // the still-readable reverse source to close before its own clean EOF.
  harness.backend.emit("close", false);
  await sleep(0);
  if (!harness.fatals.some((error) =>
    error instanceof CaptureError
    && error.code === "SELFTEST_EARLY_FIN_BACKEND_CLOSE_WITHOUT_CLEAN_EOF")) {
    throw new Error("early opposite FIN was not rejected");
  }
}

async function partialFrameFollowedByFinIsRejected() {
  const harness = createHalfOpenHarness("SELFTEST_PARTIAL_FIN");
  harness.frontDecoder.push(Buffer.from([0x00, 0x00]));
  harness.front.emit("end");
  await harness.frontIngress.eofPromise();
  await sleep(0);
  if (!harness.fatals.some((error) =>
    error instanceof CaptureError && error.code === "NATIVE_DECODER_TRUNCATED_TAIL")) {
    throw new Error("partial frame followed by FIN was not rejected");
  }
}

async function wrongSideResetIsRejectedByHalfOpenState() {
  const harness = createHalfOpenHarness("SELFTEST_WRONG_SIDE_RESET");
  const reset = Object.assign(new Error("shape-only reset"), { code: "ECONNRESET" });
  harness.backend.emit("error", reset);
  harness.backend.emit("close", true);
  await sleep(0);
  if (!harness.fatals.some((error) =>
    error instanceof CaptureError
    && error.code === "SELFTEST_WRONG_SIDE_RESET_BACKEND_SOCKET_ERROR")) {
    throw new Error("wrong-side reset was suppressed");
  }
}

async function runRealUnixDelayedResponse({ productionAcceptedHalfOpen }) {
  const socketPath = `/tmp/test223-half-open-${process.pid}-${productionAcceptedHalfOpen ? "green" : "red"}.sock`;
  rmSync(socketPath, { force: true });
  const response = Buffer.from("delayed-response-after-peer-eof");
  let serverWriteError;
  let acceptedAllowHalfOpen;
  const server = productionAcceptedHalfOpen
    ? createHalfOpenServer(onConnection)
    : createDefaultServer(onConnection);
  function onConnection(socket) {
    acceptedAllowHalfOpen = socket.allowHalfOpen;
    socket.on("error", (error) => { serverWriteError ||= error; });
    socket.on("data", () => {});
    socket.on("end", () => {
      setTimeout(() => {
        socket.write(response, (error) => {
          if (error) serverWriteError ||= error;
          socket.end();
        });
      }, 80);
    });
  }
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  // Keep the outbound side on the production helper in both arms. This
  // mutation isolates the accepted-side allowHalfOpen contract.
  const client = createHalfOpenConnection(socketPath);
  const chunks = [];
  let clientError;
  client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  client.on("error", (error) => { clientError ||= error; });
  await new Promise((resolveConnect, rejectConnect) => {
    client.once("connect", resolveConnect);
    client.once("error", rejectConnect);
  });
  client.end(Buffer.from("request-before-eof"));
  await Promise.race([
    new Promise((resolveClose) => client.once("close", resolveClose)),
    sleep(500),
  ]);
  if (!client.destroyed) client.destroy();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  rmSync(socketPath, { force: true });
  return {
    received: Buffer.concat(chunks),
    acceptedAllowHalfOpen,
    serverWriteError,
    clientError,
  };
}

async function realUnixHalfOpenHelperIsRequired() {
  const green = await runRealUnixDelayedResponse({ productionAcceptedHalfOpen: true });
  if (green.acceptedAllowHalfOpen !== true
    || !green.received.equals(Buffer.from("delayed-response-after-peer-eof"))
    || green.serverWriteError || green.clientError) {
    throw new Error("production half-open helper lost delayed Unix response");
  }
  const red = await runRealUnixDelayedResponse({ productionAcceptedHalfOpen: false });
  if (red.acceptedAllowHalfOpen !== false
    || red.received.length !== 0) {
    throw new Error("removing allowHalfOpen did not turn real Unix boundary red");
  }
}

async function runRealUnixOutboundHalfOpen({ productionOutboundHalfOpen }) {
  const socketPath = `/tmp/test223-half-open-outbound-${process.pid}-${productionOutboundHalfOpen ? "green" : "red"}.sock`;
  rmSync(socketPath, { force: true });
  const response = Buffer.from("client-response-after-backend-eof");
  const received = [];
  let acceptedAllowHalfOpen;
  let clientAllowHalfOpen;
  let clientWriteError;
  let serverSocket;
  const server = createHalfOpenServer((socket) => {
    serverSocket = socket;
    acceptedAllowHalfOpen = socket.allowHalfOpen;
    socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    socket.on("error", () => {});
    socket.end(Buffer.from("backend-request-before-eof"));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const client = productionOutboundHalfOpen
    ? createHalfOpenConnection(socketPath)
    : createDefaultConnection(socketPath);
  clientAllowHalfOpen = client.allowHalfOpen;
  client.on("error", (error) => { clientWriteError ||= error; });
  client.on("data", () => {});
  await new Promise((resolveConnect, rejectConnect) => {
    client.once("connect", resolveConnect);
    client.once("error", rejectConnect);
  });
  await new Promise((resolveEnd) => client.once("end", resolveEnd));
  await sleep(80);
  try {
    client.write(response, (error) => {
      if (error) clientWriteError ||= error;
    });
    client.end();
  } catch (error) {
    clientWriteError ||= error;
  }
  await sleep(100);
  if (!client.destroyed) client.destroy();
  if (serverSocket && !serverSocket.destroyed) serverSocket.destroy();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  rmSync(socketPath, { force: true });
  return {
    acceptedAllowHalfOpen,
    clientAllowHalfOpen,
    received: Buffer.concat(received),
    clientWriteError,
  };
}

async function outboundHalfOpenHelperIsIndependentlyRequired() {
  const green = await runRealUnixOutboundHalfOpen({ productionOutboundHalfOpen: true });
  if (green.acceptedAllowHalfOpen !== true
    || green.clientAllowHalfOpen !== true
    || !green.received.equals(Buffer.from("client-response-after-backend-eof"))
    || green.clientWriteError) {
    throw new Error("production outbound half-open helper lost delayed client response");
  }
  const red = await runRealUnixOutboundHalfOpen({ productionOutboundHalfOpen: false });
  if (red.acceptedAllowHalfOpen !== true
    || red.clientAllowHalfOpen !== false
    || red.received.length !== 0) {
    throw new Error("removing only outbound allowHalfOpen did not turn the boundary red");
  }
}

async function serverCloseLifecycleIsSingleSettlement() {
  const expectDrainRed = (operation, label) => {
    let rejected = false;
    try { operation(); } catch (error) { rejected = error instanceof CaptureError; }
    if (!rejected) throw new Error(`${label} did not reject beginDrain`);
  };

  const abortFirstPath = `/tmp/test223-server-close-abort-first-${process.pid}.sock`;
  rmSync(abortFirstPath, { force: true });
  const abortFirstServer = createHalfOpenServer(() => {});
  let abortFirstPhysicalCloses = 0;
  const abortFirstRawClose = abortFirstServer.close.bind(abortFirstServer);
  abortFirstServer.close = (...args) => {
    abortFirstPhysicalCloses += 1;
    return abortFirstRawClose(...args);
  };
  await new Promise((resolveListen) => abortFirstServer.listen(abortFirstPath, resolveListen));
  const abortFirst = createServerCloseLifecycle(abortFirstServer, "SELFTEST_ABORT_FIRST");
  const aborted = abortFirst.abort(() => {});
  expectDrainRed(() => abortFirst.beginDrain(), "abort-first");
  await aborted;
  if (abortFirstPhysicalCloses !== 1
    || abortFirst.status().physicalCloseCalls !== 1) {
    throw new Error("abort-first retried physical server.close");
  }
  rmSync(abortFirstPath, { force: true });

  const concurrentPath = `/tmp/test223-server-close-concurrent-${process.pid}.sock`;
  rmSync(concurrentPath, { force: true });
  let acceptedSocket;
  let resolveAccepted;
  const accepted = new Promise((resolve) => { resolveAccepted = resolve; });
  const concurrentServer = createHalfOpenServer((socket) => {
    acceptedSocket = socket;
    resolveAccepted();
  });
  let concurrentPhysicalCloses = 0;
  const concurrentRawClose = concurrentServer.close.bind(concurrentServer);
  concurrentServer.close = (...args) => {
    concurrentPhysicalCloses += 1;
    return concurrentRawClose(...args);
  };
  await new Promise((resolveListen) => concurrentServer.listen(concurrentPath, resolveListen));
  const client = createHalfOpenConnection(concurrentPath);
  client.on("error", () => {});
  await new Promise((resolveConnect) => client.once("connect", resolveConnect));
  await accepted;
  const lifecycle = createServerCloseLifecycle(concurrentServer, "SELFTEST_CONCURRENT_CLOSE");
  expectDrainRed(
    () => lifecycle.beginDrain({ closing: true, closePhase: "open" }),
    "closing-state",
  );
  expectDrainRed(
    () => lifecycle.beginDrain({ closing: false, closePhase: "abort_pending" }),
    "abort-pending-state",
  );
  const drain = lifecycle.beginDrain();
  expectDrainRed(() => lifecycle.beginDrain(), "duplicate-drain");
  const graceful = lifecycle.graceful();
  let abortHookRan = false;
  const abort = lifecycle.abort(() => {
    abortHookRan = true;
    acceptedSocket.destroy();
    client.destroy();
  });
  if (!abortHookRan) throw new Error("abort hook queued behind graceful close");
  await Promise.all([drain, graceful, abort]);
  if (concurrentPhysicalCloses !== 1
    || lifecycle.status().physicalCloseCalls !== 1
    || lifecycle.status().phase !== "closed") {
    throw new Error("concurrent graceful/abort called physical server.close more than once");
  }
  rmSync(concurrentPath, { force: true });
}

async function delayedPartialCompletionSucceeds() {
  let activity = 1;
  const seen = [];
  const decoder = new IncrementalNativeDecoder(
    "selftest-delayed-partial-completion",
    (frame) => seen.push(frame),
  );
  const frame = encodeFrame({ type: "partial-then-complete" });
  decoder.push(frame.subarray(0, 2));
  const delayed = setTimeout(() => {
    activity += 1;
    decoder.push(frame.subarray(2));
    activity += 1;
  }, 80);
  await waitForTransportQuiescence({
    label: "SELFTEST_DELAYED_PARTIAL",
    decoders: [decoder],
    activityEpoch: () => activity,
    timeoutMs: 350,
  });
  clearTimeout(delayed);
  if (seen.length !== 1 || decoder.buffer.length !== 0) {
    throw new Error("delayed partial frame did not complete at barrier");
  }
}

async function cleanBarrierCompletesBoundedly() {
  const decoder = new IncrementalNativeDecoder("selftest-clean-barrier");
  const startedAt = Date.now();
  await waitForTransportQuiescence({
    label: "SELFTEST_CLEAN",
    decoders: [decoder],
    timeoutMs: 100,
    quietMs: 10,
  });
  if (Date.now() - startedAt > 250) throw new Error("clean barrier exceeded bound");
}

function shutdownErrorSuppressionIsDirectionBound() {
  const reset = Object.assign(new Error("shape-only reset"), { code: "ECONNRESET" });
  if (!shouldSuppressShutdownSocketError({
    direction: "producer-facing-ingress",
    producerShutdown: true,
    producerGone: true,
    error: reset,
  })) {
    throw new Error("closed producer ingress reset was not recognized");
  }
  if (shouldSuppressShutdownSocketError({
    direction: "leader-facing-downstream",
    producerShutdown: true,
    producerGone: true,
    error: reset,
  })) {
    throw new Error("wrong-side downstream reset was incorrectly suppressed");
  }
  if (shouldSuppressShutdownSocketError({
    direction: "producer-facing-ingress",
    producerShutdown: true,
    producerGone: false,
    error: reset,
  })) {
    throw new Error("producer ingress reset was suppressed before producer was gone");
  }
}

async function processStateNeedsCloseEvent() {
  const child = new EventEmitter();
  child.exitCode = 0;
  child.signalCode = null;
  child.pid = undefined;
  child.kill = () => false;
  const lifecycle = monitorChildProcess(child, "SELFTEST_FAKE_CHILD");
  if (lifecycle.closed()) throw new Error("exitCode incorrectly counted as close");
  child.emit("error", new Error("shape-only spawn error"));
  if (lifecycle.closed()) throw new Error("process error incorrectly counted as close");
  child.emit("close", 0, null);
  await lifecycle.closedPromise;
  if (!lifecycle.closed() || !lifecycle.treeGone()) {
    throw new Error("real close event did not close lifecycle");
  }
}

async function detachedProcessGroupTerminatesBoundedly() {
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ], {
    detached: true,
    stdio: "ignore",
  });
  const lifecycle = monitorChildProcess(child, "SELFTEST_PROCESS_GROUP");
  try {
    await sleep(30);
    if (!lifecycle.processGroupAlive()) throw new Error("detached process group never became alive");
    await terminateProcessTree(lifecycle, "SELFTEST_PROCESS_GROUP");
    if (!lifecycle.closed() || lifecycle.processGroupAlive() || !lifecycle.treeGone()) {
      throw new Error("TERM/KILL lifecycle returned before process group disappeared");
    }
  } finally {
    if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
}

async function exitedGroupLeaderDoesNotHideLiveDescendant() {
  const descendantProgram = "process.on('SIGHUP',()=>{});setInterval(()=>{},1000)";
  const parentProgram = [
    "set -m",
    `${shellQuote(process.execPath)} -e ${shellQuote(descendantProgram)} </dev/null >/dev/null 2>&1 &`,
    "disown",
    "sleep 0.3",
    "exit 0",
  ].join("\n");
  const child = spawn("bash", ["-c", parentProgram], {
    detached: true,
    stdio: "ignore",
  });
  const lifecycle = monitorChildProcess(child, "SELFTEST_EXITED_GROUP_LEADER");
  try {
    await Promise.race([
      lifecycle.closedPromise,
      sleep(1_000).then(() => { throw new Error("group leader did not exit"); }),
    ]);
    const members = lifecycle.sessionMembers();
    if (!lifecycle.closed()
      || !lifecycle.processGroupAlive()
      || lifecycle.treeGone()
      || !members.some(({ pgrp }) => pgrp !== lifecycle.boundTuple().pgrp)) {
      throw new Error("exited group leader hid a still-live descendant");
    }
    await terminateProcessTree(lifecycle, "SELFTEST_EXITED_GROUP_LEADER");
    if (lifecycle.processGroupAlive() || !lifecycle.treeGone()) {
      throw new Error("descendant process group survived bounded termination");
    }
  } finally {
    if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
}

function stoppedStateIsRequiredBeforeSessionSignalFence() {
  const tuple = Object.freeze({
    pid: 12345,
    pgrp: 12345,
    session: 12345,
    starttime: "67890",
    state: "R",
    uid: process.getuid(),
  });
  let state = "R";
  let waits = 0;
  let now = 0;
  const tracker = {
    members: () => [{ ...tuple, state }],
  };
  const frozen = freezeSessionGeneration(tracker, "SELFTEST_DELAYED_STOP", {
    signalTuple() {},
    waitForSignalDelivery() {
      waits += 1;
      now += 1;
      if (waits >= 2) state = "T";
    },
    clock: () => now,
    timeoutMs: 10,
  });
  if (waits < 2 || frozen.length !== 1 || frozen[0].state !== "T") {
    throw new Error("session fence returned before delayed SIGSTOP state was visible");
  }

  let redNow = 0;
  let rejected = false;
  try {
    freezeSessionGeneration({ members: () => [{ ...tuple, state: "R" }] }, "SELFTEST_NEVER_STOP", {
      signalTuple() {},
      waitForSignalDelivery() { redNow += 1; },
      clock: () => redNow,
      timeoutMs: 4,
    });
  } catch (error) {
    rejected = error instanceof CaptureError
      && error.code === "SELFTEST_NEVER_STOP_SESSION_FREEZE_UNSTABLE";
  }
  if (!rejected) throw new Error("session fence accepted a member that never stopped");
}

function launchGenerationToIdentityHandoffIsLinearized() {
  let fileReads = 0;
  let published = false;
  const expected = Object.freeze({ bound: "published-after-generation-scan" });
  const observed = observeLinearizedLaunchHandoff(
    () => {
      fileReads += 1;
      return published ? expected : undefined;
    },
    () => {
      // Model mv(final)+unset+exec occurring after the first file read but
      // before the generation scan can return a member.
      published = true;
      return undefined;
    },
  );
  if (observed !== expected || fileReads !== 2) {
    throw new Error("launch generation/file handoff was not linearized by a second file read");
  }

  let unstableReads = 0;
  const recovered = observeLinearizedLaunchHandoff(
    () => {
      unstableReads += 1;
      return unstableReads === 2 ? expected : undefined;
    },
    () => { throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE"); },
  );
  if (recovered !== expected || unstableReads !== 2) {
    throw new Error("published identity did not supersede an unstable generation scan");
  }
  let failClosed = false;
  try {
    observeLinearizedLaunchHandoff(
      () => undefined,
      () => { throw new CaptureError("TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE"); },
    );
  } catch (error) {
    failClosed = error instanceof CaptureError
      && error.code === "TUI_LAUNCH_GENERATION_MEMBER_UNSTABLE";
  }
  if (!failClosed) throw new Error("unstable generation scan without final identity did not fail closed");
}

function launchGenerationEnvironmentMatchIsExact() {
  const generation = "a".repeat(64);
  const key = "ANET_TUI_LAUNCH_GENERATION";
  const blocks = [
    Buffer.from(`${key}=prefix${generation}\0`),
    Buffer.from(`${key}=${generation}suffix\0`),
    Buffer.from(`OTHER=${key}=${generation}\0`),
    Buffer.from(`${key}=${generation.slice(0, 63)}\0`),
  ];
  for (const block of blocks) {
    if (environmentBlockContainsLaunchGeneration(block, generation)) {
      throw new Error("launch generation accepted a prefix/suffix/embedded environment value");
    }
  }
  if (!environmentBlockContainsLaunchGeneration(
    Buffer.from(`OTHER=value\0${key}=${generation}\0TAIL=value\0`),
    generation,
  )) {
    throw new Error("launch generation rejected an exact NUL-delimited environment entry");
  }
}

function identityPublicationFailureIsFailClosed() {
  const root = mkdtempSync("/tmp/test223-identity-publication-failure-");
  chmodSync(root, 0o700);
  const generation = randomBytes(32).toString("hex");
  try {
    for (const [name, moverBody] of [
      ["nonzero", "#!/bin/sh\nexit 42\n"],
      ["success-no-op", "#!/bin/sh\nexit 0\n"],
    ]) {
      const moverPath = join(root, `fake-mv-${name}`);
      const candidateIdentity = join(root, `${name}.json`);
      const candidateSentinel = join(root, `crossed-${name}`);
      writeFileSync(moverPath, moverBody, { mode: 0o700 });
      chmodSync(moverPath, 0o700);
      const command = [
        buildPtyIdentityPrelude(candidateIdentity, { moveExecutable: moverPath }),
        `printf crossed > ${shellQuote(candidateSentinel)}`,
      ].join("; ");
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { ...process.env, ANET_TUI_LAUNCH_GENERATION: generation },
        stdio: "ignore",
      });
      if (result.status === 0
        || existsSync(candidateIdentity)
        || existsSync(candidateSentinel)) {
        throw new Error(`${name} identity publication crossed marker removal/exec boundary`);
      }
    }

    const missingMarkerPath = join(root, "missing-marker.json");
    const missingMarkerSentinel = join(root, "crossed-missing-marker");
    const missing = spawnSync("/bin/sh", ["-c", [
      buildPtyIdentityPrelude(missingMarkerPath),
      `printf crossed > ${shellQuote(missingMarkerSentinel)}`,
    ].join("; ")], {
      env: { ...process.env, ANET_TUI_LAUNCH_GENERATION: "" },
      stdio: "ignore",
    });
    if (missing.status === 0
      || existsSync(missingMarkerPath)
      || existsSync(missingMarkerSentinel)) {
      throw new Error("missing launch generation crossed identity publication boundary");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function identityCleanupCommitPreservesRecoveryEvidenceOnFailure() {
  const root = mkdtempSync("/tmp/test223-identity-cleanup-commit-");
  chmodSync(root, 0o700);
  const identityPath = join(root, "producer.json");
  writeFileSync(identityPath, '{"pid":1,"pgid":1,"sid":1,"starttime":"1"}\n', { mode: 0o600 });
  writeFileSync(`${identityPath}.tmp`, "pending\n", { mode: 0o600 });
  let rejected = false;
  try {
    commitTuiIdentityCleanup({
      identityPath,
      wrapperGone: true,
      producerGone: false,
      cohortGone: true,
      failures: [new Error("injected first-attempt termination failure")],
    });
  } catch (error) {
    rejected = error instanceof CaptureError && error.code === "FRAME_AWARE_CLEANUP_FAILED";
  }
  if (!rejected || !existsSync(identityPath) || !existsSync(`${identityPath}.tmp`)) {
    throw new Error("failed cleanup attempt deleted its only recovery identity");
  }
  commitTuiIdentityCleanup({
    identityPath,
    wrapperGone: true,
    producerGone: true,
    cohortGone: true,
    failures: [],
  });
  if (existsSync(identityPath) || existsSync(`${identityPath}.tmp`)) {
    throw new Error("successful cleanup commit retained stale identity evidence");
  }
  rmSync(root, { recursive: true, force: true });
}

async function abortRetriesCleanupAfterGracefulFailure() {
  const lifecycle = { treeGone: () => true };
  let cleanupCalls = 0;
  const startup = {
    async cleanup() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new CaptureError("INJECTED_GRACEFUL_CLEANUP_FAILURE");
    },
  };
  const priorClose = Promise.resolve().then(() => startup.cleanup());
  const reconciled = await reconcilePriorTuiCloseForAbort(priorClose, lifecycle, startup);
  if (!reconciled || cleanupCalls !== 2) {
    throw new Error("abort did not retry cleanup after graceful tree termination failure");
  }

  let persistentRejected = false;
  try {
    await reconcilePriorTuiCloseForAbort(
      Promise.reject(new CaptureError("INJECTED_PRIOR_CLOSE_FAILURE")),
      lifecycle,
      { cleanup: async () => { throw new CaptureError("INJECTED_RETRY_CLEANUP_FAILURE"); } },
    );
  } catch (error) {
    persistentRejected = error instanceof CaptureError
      && error.code === "INJECTED_RETRY_CLEANUP_FAILURE";
  }
  if (!persistentRejected) throw new Error("abort swallowed a repeated cleanup failure");
}

async function independentWrapperAndProducerGroupsAreBothTerminated() {
  const root = mkdtempSync("/tmp/test223-pty-identity-");
  chmodSync(root, 0o700);
  const identityPath = join(root, "producer.json");
  const harness = spawnPtyHarness({
    identityPath,
    afterIdentity: `exec ${shellQuote(process.execPath)} -e ${shellQuote("process.on('SIGHUP',()=>{});setInterval(()=>{},1000)")}`,
  });
  const wrapperLifecycle = harness.lifecycle;
  let producerLifecycle;
  let originalIdentity;
  await waitUntil(() => existsSync(identityPath), 1_000, "producer identity was not published");
  originalIdentity = JSON.parse(readFileSync(identityPath, "utf8"));
  const wrapperTuple = wrapperLifecycle.boundTuple();
  const mutations = [
    { ...originalIdentity, pgid: originalIdentity.pgid + 100_000 },
    { ...originalIdentity, sid: originalIdentity.sid + 100_000 },
    { ...originalIdentity, starttime: String(BigInt(originalIdentity.starttime) + 1n) },
  ];
  for (const mutation of mutations) {
    writeIdentity(identityPath, mutation);
    let rejected = false;
    try {
      bindPtyProducerIdentity(identityPath, wrapperTuple);
    } catch (error) {
      rejected = error instanceof CaptureError;
    }
    if (!rejected) throw new Error("production identity binder accepted a tuple mutation");
  }
  writeIdentity(identityPath, originalIdentity);
  producerLifecycle = await harness.startup.waitForIdentity(1_000);
  const boundIdentity = harness.startup.producerIdentity();
  let generationMutationRejected = false;
  try {
    monitorFixedProducerIdentity({
      ...boundIdentity,
      sessionLeaderStarttime: String(BigInt(boundIdentity.sessionLeaderStarttime) + 1n),
    }, process.execPath, "SELFTEST_TUI_PRODUCER_GENERATION_MUTATION");
  } catch (error) {
    generationMutationRejected = error instanceof CaptureError;
  }
  if (!generationMutationRejected) {
    throw new Error("session generation mutation did not fail closed");
  }
  const composite = monitorTuiProcessTree(wrapperLifecycle, producerLifecycle);
  try {
    await harness.startup.waitForExecutable(1_000);
    const producerEnvironment = readFileSync(`/proc/${boundIdentity.pid}/environ`);
    if (environmentBlockContainsLaunchGeneration(
      producerEnvironment,
      harness.launchGeneration,
    )) {
      throw new Error("internal launch generation reached the final producer executable");
    }
    if (wrapperLifecycle.child.pid === boundIdentity.pid
      || !wrapperLifecycle.processGroupAlive()
      || !producerLifecycle.processGroupAlive()
      || composite.treeGone()) {
      throw new Error("independent wrapper/producer groups were not both live");
    }
    await terminateTuiProcessTree(composite, "SELFTEST_TUI_COMPOSITE");
    if (!composite.treeGone()) {
      throw new Error("composite termination left wrapper or producer group alive");
    }
  } finally {
    await terminateTuiProcessTree(
      composite,
      "SELFTEST_TUI_COMPOSITE",
      { abort: true },
    ).catch(() => {});
    await harness.startup.cleanup().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

async function startupCleanupCoversIdentityPublicationBoundary() {
  const directChildren = (pid) => {
    try {
      const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      return raw ? raw.split(/\s+/).map(Number) : [];
    } catch {
      return [];
    }
  };
  const sessionMembers = (sid, uid) => {
    const found = [];
    // /proc enumeration is intentionally local to this fault injection; the
    // production generation-safe scan remains in the controller under test.
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const tuple = readLinuxProcessTuple(Number(entry.name));
        if (tuple.session === sid && tuple.uid === uid) found.push(tuple);
      } catch {}
    }
    return found;
  };
  const runScenario = async ({
    name,
    beforeIdentity = "",
    afterIdentity,
    bindPublished,
    expectUnpublished = false,
    retireWrapperBeforeCleanup = false,
  }) => {
    const root = mkdtempSync(`/tmp/test223-pty-startup-${name}-`);
    chmodSync(root, 0o700);
    const identityPath = join(root, "producer.json");
    const harness = spawnPtyHarness({ identityPath, beforeIdentity, afterIdentity });
    let producerLifecycle;
    try {
      if (bindPublished) {
        await waitUntil(
          () => existsSync(identityPath),
          1_000,
          `${name} identity was not published`,
        );
        producerLifecycle = await harness.startup.waitForIdentity(1_000);
        if (producerLifecycle.executableReady()) {
          throw new Error(`${name} unexpectedly crossed executable readiness`);
        }
      } else if (expectUnpublished) {
        await sleep(40);
        if (existsSync(identityPath)) {
          throw new Error(`${name} unexpectedly published identity`);
        }
        if (retireWrapperBeforeCleanup) {
          if (!harness.startup.observe()) {
            throw new Error(`${name} did not cache provisional direct-child identity`);
          }
          await terminateProcessTree(
            harness.lifecycle,
            `SELFTEST_${name.toUpperCase()}_WRAPPER_FIRST`,
          );
          if (!harness.lifecycle.treeGone()) {
            throw new Error(`${name} wrapper did not retire before cleanup`);
          }
        }
      } else {
        await Promise.race([
          harness.lifecycle.closedPromise,
          waitUntil(() => existsSync(identityPath), 1_000, `${name} produced no lifecycle evidence`),
        ]);
      }
      await harness.startup.cleanup();
      if (!harness.lifecycle.treeGone()
        || (producerLifecycle && !producerLifecycle.treeGone())
        || existsSync(identityPath)
        || existsSync(`${identityPath}.tmp`)) {
        throw new Error(`${name} startup cleanup returned before both process trees were gone`);
      }
    } finally {
      await harness.startup.cleanup().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  };

  // Exact reviewer regression: the independent PTY session exists, no
  // identity has been published, and the production controller has never
  // observed/cached it before the wrapper is killed.
  {
    const root = mkdtempSync("/tmp/test223-pty-startup-preobserve-");
    chmodSync(root, 0o700);
    const identityPath = join(root, "producer.json");
    const decoyIdentityPath = join(root, "decoy-producer.json");
    const harness = spawnPtyHarness({
      identityPath,
      beforeIdentity: "trap '' HUP TERM; sleep 5",
      afterIdentity: `exec ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>{},1000)")}`,
    });
    const decoy = spawnPtyHarness({
      identityPath: decoyIdentityPath,
      afterIdentity: `exec ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>{},1000)")}`,
    });
    let producerTuple;
    let decoyProducer;
    try {
      decoyProducer = await decoy.startup.waitForIdentity(1_000);
      await decoy.startup.waitForExecutable(1_000);
      producerTuple = await waitUntil(() => {
        if (existsSync(identityPath)) return undefined;
        const childPid = directChildren(harness.child.pid)[0];
        if (!Number.isInteger(childPid)) return undefined;
        try {
          const tuple = readLinuxProcessTuple(childPid);
          return tuple.pid === tuple.session && tuple.session !== harness.lifecycle.boundTuple()?.session
            ? tuple
            : undefined;
        } catch {
          return undefined;
        }
      }, 1_000, "preobserve independent producer did not appear");
      if (harness.startup.producerLifecycle()) {
        throw new Error("preobserve controller unexpectedly cached producer before fault");
      }
      process.kill(harness.child.pid, "SIGKILL");
      await Promise.race([
        harness.lifecycle.closedPromise,
        sleep(1_000).then(() => { throw new Error("preobserve wrapper did not close"); }),
      ]);
      if (existsSync(identityPath) || harness.startup.producerLifecycle()) {
        throw new Error("preobserve fault crossed identity/observation boundary");
      }
      const survivor = readLinuxProcessTuple(producerTuple.pid);
      if (survivor.starttime !== producerTuple.starttime) {
        throw new Error("preobserve fixture did not retain the original producer");
      }
      await harness.startup.cleanup();
      if (!harness.startup.producerLifecycle()?.treeGone()
        || sessionMembers(producerTuple.session, producerTuple.uid).length !== 0) {
        throw new Error("preobserve cleanup returned with the unobserved producer alive");
      }
      if (!decoyProducer.executableReady() || decoy.startup.wrapperLifecycle.closed()) {
        throw new Error("exact launch witness cleanup terminated a different launch");
      }
    } finally {
      await harness.startup.cleanup().catch(() => {});
      await decoy.startup.cleanup().catch(() => {});
      if (producerTuple) {
        try { process.kill(-producerTuple.pgrp, "SIGKILL"); } catch {}
      }
      try { process.kill(-harness.child.pid, "SIGKILL"); } catch {}
      try { process.kill(-decoy.child.pid, "SIGKILL"); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Hereditary witness regression: the prepublication session leader exits,
  // leaving only a same-session descendant. There is no identity file and no
  // prior controller observation, so PPID/cmdline-only discovery cannot work.
  {
    const root = mkdtempSync("/tmp/test223-pty-startup-hereditary-");
    chmodSync(root, 0o700);
    const identityPath = join(root, "producer.json");
    const readyPath = join(root, "descendant.pid");
    const descendantProgram = [
      "const fs=require('node:fs')",
      "process.on('SIGHUP',()=>{})",
      "process.on('SIGTERM',()=>{})",
      `fs.writeFileSync(${JSON.stringify(readyPath)},String(process.pid))`,
      "setInterval(()=>{},1000)",
    ].join(";");
    const beforeIdentity = [
      `${shellQuote(process.execPath)} -e ${shellQuote(descendantProgram)} </dev/null >/dev/null 2>&1 &`,
      `while [ ! -s ${shellQuote(readyPath)} ]; do sleep 0.01; done`,
      "exit 0",
    ].join("\n");
    const harness = spawnPtyHarness({
      identityPath,
      beforeIdentity,
      afterIdentity: `exec ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>{},1000)")}`,
    });
    let descendantTuple;
    try {
      await waitUntil(() => existsSync(readyPath), 1_000, "hereditary descendant did not start");
      const descendantPid = Number(readFileSync(readyPath, "utf8"));
      descendantTuple = readLinuxProcessTuple(descendantPid);
      await Promise.race([
        harness.lifecycle.closedPromise,
        sleep(1_000).then(() => { throw new Error("hereditary wrapper did not close"); }),
      ]);
      if (existsSync(identityPath)
        || harness.startup.producerLifecycle()
        || descendantTuple.pid === descendantTuple.session) {
        throw new Error("hereditary fixture did not isolate a leaderless prepublication descendant");
      }
      const stillLive = readLinuxProcessTuple(descendantTuple.pid);
      if (stillLive.starttime !== descendantTuple.starttime) {
        throw new Error("hereditary descendant changed before cleanup");
      }
      await harness.startup.cleanup();
      if (!harness.startup.launchCohort().treeGone()
        || sessionMembers(descendantTuple.session, descendantTuple.uid).length !== 0) {
        throw new Error("hereditary launch cohort cleanup left a leaderless descendant");
      }
    } finally {
      await harness.startup.cleanup().catch(() => {});
      if (descendantTuple) {
        try { process.kill(descendantTuple.pid, "SIGKILL"); } catch {}
      }
      try { process.kill(-harness.child.pid, "SIGKILL"); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }

  await runScenario({
    name: "prepublication",
    beforeIdentity: "sleep 5",
    afterIdentity: `exec ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>{},1000)")}`,
    bindPublished: false,
    expectUnpublished: true,
    retireWrapperBeforeCleanup: true,
  });
  await runScenario({
    name: "postpublication",
    afterIdentity: "sleep 5",
    bindPublished: true,
  });
  await runScenario({
    name: "execfailure",
    afterIdentity: "exec /definitely/missing-test223-executable",
    bindPublished: false,
  });

  const root = mkdtempSync("/tmp/test223-pty-startup-wrapper-first-");
  chmodSync(root, 0o700);
  const identityPath = join(root, "producer.json");
  const wrapper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const startup = bindTuiProducerStartup({
    child: wrapper,
    identityPath,
    launchGeneration: randomBytes(32).toString("hex"),
    expectedExecutable: process.execPath,
    label: "SELFTEST_WRAPPER_FIRST",
  });
  const producer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const tuple = readLinuxProcessTuple(producer.pid);
    writeIdentity(identityPath, {
      pid: tuple.pid,
      pgid: tuple.pgrp,
      sid: tuple.session,
      starttime: tuple.starttime,
    });
    await terminateProcessTree(startup.wrapperLifecycle, "SELFTEST_WRAPPER_FIRST_WRAPPER");
    if (!startup.wrapperLifecycle.treeGone()) {
      throw new Error("wrapper-first fixture did not retire wrapper first");
    }
    await startup.cleanup();
    if (!startup.producerLifecycle()?.treeGone()) {
      throw new Error("wrapper-first cleanup returned with producer session alive");
    }
  } finally {
    await startup.cleanup().catch(() => {});
    try { process.kill(-producer.pid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }

  const unboundRoot = mkdtempSync("/tmp/test223-pty-startup-unbound-");
  chmodSync(unboundRoot, 0o700);
  const unboundIdentityPath = join(unboundRoot, "producer.json");
  const unboundWrapper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const unboundStartup = bindTuiProducerStartup({
    child: unboundWrapper,
    identityPath: unboundIdentityPath,
    launchGeneration: randomBytes(32).toString("hex"),
    expectedExecutable: process.execPath,
    label: "SELFTEST_UNBOUND_WRAPPER",
    wrapperLifecycleFactory(child, label, options) {
      const realLifecycle = monitorChildProcess(child, label, options);
      return {
        ...realLifecycle,
        identityBound: () => false,
        boundTuple: () => undefined,
      };
    },
  });
  const unboundProducer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const tuple = readLinuxProcessTuple(unboundProducer.pid);
    writeIdentity(unboundIdentityPath, {
      pid: tuple.pid,
      pgid: tuple.pgrp,
      sid: tuple.session,
      starttime: tuple.starttime,
    });
    await unboundStartup.cleanup();
    if (!unboundStartup.wrapperLifecycle.treeGone()
      || !unboundStartup.producerLifecycle()?.treeGone()) {
      throw new Error("unbound wrapper cleanup returned with a process session alive");
    }
  } finally {
    await unboundStartup.cleanup().catch(() => {});
    try { process.kill(-unboundProducer.pid, "SIGKILL"); } catch {}
    rmSync(unboundRoot, { recursive: true, force: true });
  }
}

frameAwareAcpInitializeContractIsStable();
await closeBeforeDrainIsSingleSettlement();
await neverCallbackFailsBoundedly();
await terminalModeRequiresExplicitFence();
await terminalFenceRequiresEveryCondition();
await terminalCompletionFencePreventsEarlyReturn();
await forwardedRequestWithoutResponseStaysOutstanding();
await requestResponsePairClearsOutstanding();
await typedIdsAndDirectionsCannotCrossClear();
await localBusyClearsOnlyAfterResponseWrite();
jsonRpcClassificationIsExact();
await matchingResponseClosesOnlyAfterEgressCommit();
await allBlockedRequestsReceiveBusyWithoutLeaderWrite();
await responsesForwardInRejectAndDraining();
await busyWriterCommitAndFailureAreFailClosed();
drainAndArmGuardsFailClosed();
await coordinatedDrainInvalidationIsProductionBound();
await halfOpenAllowsDelayedReverseResponse();
await earlyOppositeFinIsRejected();
await partialFrameFollowedByFinIsRejected();
await wrongSideResetIsRejectedByHalfOpenState();
await realUnixHalfOpenHelperIsRequired();
await outboundHalfOpenHelperIsIndependentlyRequired();
await serverCloseLifecycleIsSingleSettlement();
await delayedPartialCompletionSucceeds();
await partialFrameFailsAtBarrier();
await cleanBarrierCompletesBoundedly();
shutdownErrorSuppressionIsDirectionBound();
await processStateNeedsCloseEvent();
await detachedProcessGroupTerminatesBoundedly();
await exitedGroupLeaderDoesNotHideLiveDescendant();
stoppedStateIsRequiredBeforeSessionSignalFence();
launchGenerationToIdentityHandoffIsLinearized();
launchGenerationEnvironmentMatchIsExact();
identityPublicationFailureIsFailClosed();
identityCleanupCommitPreservesRecoveryEvidenceOnFailure();
await abortRetriesCleanupAfterGracefulFailure();
await independentWrapperAndProducerGroupsAreBothTerminated();
await startupCleanupCoversIdentityPublicationBoundary();

process.stdout.write(`${JSON.stringify({
  ok: true,
  closeBeforeDrain: "rejected-once-no-retry",
  neverCallback: "bounded-timeout-destroyed",
  terminalCompletionFence: "producer-gone-ingress-eof-outstanding-zero",
  terminalFenceConditions: "all-required",
  rpcOutstanding: "missing-red-pair-green-typed-lanes-local-busy-exact",
  admission: "five-requests-busy-response-forwarded-commit-bound-drain-guarded",
  halfOpen: "server-and-outbound-half-open-independently-bound",
  serverClose: "abort-preempts-graceful-single-physical-close",
  delayedPartialCompletion: "completed-before-deadline",
  partialFrameBarrier: "PARTIAL_FRAME_AT_BARRIER",
  cleanBarrier: "bounded",
  wrongSideShutdownError: "fatal-not-suppressed",
  processClose: "close-event-and-group-gone",
  exitedGroupLeader: "live-descendant-detected-and-terminated",
  stopFence: "exact-tuples-confirmed-stopped-before-session-signal",
  tuiProducer: "independent-wrapper-producer-groups-both-terminated",
  tuiStartupCleanup: "hereditary-generation-linearized-file-handoff-decoy-safe-no-survivors",
})}\n`);
