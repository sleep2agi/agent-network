import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const binary = process.env.GROK_BINARY ? resolve(process.env.GROK_BINARY) : "";
const rawOutput = process.env.RAW_OUTPUT ? resolve(process.env.RAW_OUTPUT) : "";
const proofCwd = process.env.PROOF_CWD ? resolve(process.env.PROOF_CWD) : "";
const expectedVersion = "grok 0.2.93 (f00f96316d)";
const sampleCount = 100;
const maxFrameBytes = 1024 * 1024;

let stage = "configuration";
let recorder;
let rawRecordCount = 0;
let leader;
let runtimeDir;
let gateway;
let client;
const observedMethods = new Set();
let safeDiagnostics = {};

function childEnv() {
  const keys = [
    "PATH", "HOME", "GROK_HOME", "GROK_AUTH_PATH", "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID", "GROK_AGENT_ID_PATH", "GROK_FOLDER_TRUST",
    "GROK_SANDBOX", "LANG", "LC_ALL", "TZ",
  ];
  const env = {};
  for (const key of keys) if (typeof process.env[key] === "string") env[key] = process.env[key];
  return {
    ...env,
    GROK_FOLDER_TRUST: "1",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
  };
}

function requireInputs() {
  if (!existsSync("/.dockerenv")) throw new Error("Docker is required");
  if (!binary || !rawOutput || !proofCwd || !process.env.RAW_DIR) {
    throw new Error("missing required input");
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(timeoutMs),
  ]);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 1_000);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function assertSocket(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("unsafe socket");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("socket owner mismatch");
  }
}

async function waitForSocket(path, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      assertSocket(path);
      return;
    } catch {
      if (child.exitCode !== null) throw new Error("leader exited");
      await delay(25);
    }
  }
  throw new Error("socket timeout");
}

async function verifyVersion() {
  const processVersion = spawn(binary, ["--version"], {
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  processVersion.stdout.setEncoding("utf8");
  processVersion.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-512); });
  processVersion.stderr.resume();
  await waitForExit(processVersion, 10_000);
  if (processVersion.exitCode === null) await terminate(processVersion);
  if (processVersion.exitCode !== 0 || !output.includes(expectedVersion)) {
    throw new Error("version mismatch");
  }
}

function record({ role, connection, direction, boundary, bytes, sample }) {
  recorder.record({
    role,
    transport: "leader-native-ipc",
    connection,
    stream: "unix-socket",
    direction,
    boundary,
    sample,
    bytes,
  });
  rawRecordCount += 1;
}

class NativeDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.frames = [];
  }

  push(bytes) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > maxFrameBytes) throw new Error("oversized native frame");
      if (this.buffer.length < length + 4) return;
      const frame = Buffer.from(this.buffer.subarray(0, length + 4));
      const outer = JSON.parse(frame.subarray(4).toString("utf8"));
      let inner;
      if (outer.type === "acp" && typeof outer.payload === "string") {
        inner = JSON.parse(outer.payload);
        if (typeof inner.method === "string") observedMethods.add(inner.method);
      }
      this.frames.push({ frame, outer, inner });
      this.buffer = this.buffer.subarray(length + 4);
    }
  }
}

function createGateway(path, upstreamPath, generation) {
  const sockets = new Set();
  const capturedClientFrames = [];
  let sequence = 0;
  const server = createServer((front) => {
    const connection = `gateway-${generation}-${++sequence}`;
    const upstream = createConnection(upstreamPath);
    const clientDecoder = new NativeDecoder();
    sockets.add(front);
    sockets.add(upstream);
    const pipe = (source, target, directionRead, directionWrite, decoder) => {
      source.on("data", (chunk) => {
        record({ role: "gateway", connection, direction: directionRead, boundary: "read", bytes: chunk });
        if (decoder) {
          const before = decoder.frames.length;
          decoder.push(chunk);
          for (const item of decoder.frames.slice(before)) capturedClientFrames.push(item);
        }
        record({ role: "gateway", connection, direction: directionWrite, boundary: "write", bytes: chunk });
        if (!target.write(chunk)) {
          source.pause();
          target.once("drain", () => source.resume());
        }
      });
      source.on("end", () => {
        record({ role: "gateway", connection, direction: directionRead, boundary: "eof", bytes: Buffer.alloc(0) });
        target.end();
      });
    };
    pipe(front, upstream, "client_to_gateway", "gateway_to_leader", clientDecoder);
    pipe(upstream, front, "leader_to_gateway", "gateway_to_client");
    for (const socket of [front, upstream]) {
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    }
  });
  return {
    path,
    capturedClientFrames,
    async start() {
      rmSync(path, { force: true });
      await new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(path, () => {
          server.off("error", rejectStart);
          chmodSync(path, 0o600);
          resolveStart();
        });
      });
      assertSocket(path);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      rmSync(path, { force: true });
    },
  };
}

class AcpClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  async connect() {
    this.child = spawn(binary, ["agent", "--leader", "--leader-socket", this.socketPath, "stdio"], {
      cwd: proofCwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.once("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("ACP exited"));
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.onLine(line));
    const initialized = await this.request("initialize", {
      protocolVersion: "1",
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "test223-transport-recovery", version: "1" },
    });
    if (!initialized?.authMethods?.some((method) => method?.id === "cached_token")) {
      throw new Error("cached auth absent");
    }
    await this.request("authenticate", { methodId: "cached_token", meta: { headless: true } });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new Error("ACP timeout"));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); rejectRequest(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { throw new Error("invalid ACP JSON"); }
    if (message?.method && message?.id !== undefined) {
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "recovery probe rejects client request" },
      })}\n`);
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error("ACP error"));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method) {
      observedMethods.add(message.method);
      this.notifications.push(message);
    }
  }

  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await waitForExit(this.child, 1_000);
    await terminate(this.child);
  }
}

function xorshift(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

function chunkPlan(buffer, sample) {
  if (sample === 0) return { chunks: [...buffer].map((_, index) => buffer.subarray(index, index + 1)), delayMs: 1 };
  if (sample === 1) return { chunks: [buffer.subarray(0, 1), buffer.subarray(1, 3), buffer.subarray(3)], delayMs: 2 };
  if (sample === 2) return { chunks: [buffer], delayMs: 0 };
  const random = xorshift(0x22300000 ^ sample);
  const chunks = [];
  for (let offset = 0; offset < buffer.length;) {
    const remaining = buffer.length - offset;
    const size = Math.min(remaining, 1 + (random() % 97));
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return { chunks, delayMs: sample % 17 === 0 ? 1 : 0 };
}

function assertDecoder(chunks, expectedFrames) {
  const decoder = new NativeDecoder();
  for (const chunk of chunks) decoder.push(chunk);
  if (decoder.buffer.length !== 0 || decoder.frames.length !== expectedFrames.length) return false;
  return decoder.frames.every((item, index) => item.frame.equals(expectedFrames[index]));
}

async function runLeaderTrial(leaderSocket, stream, frames, sample) {
  const plan = chunkPlan(stream, sample);
  if (!assertDecoder(plan.chunks, frames)) return { proxyPass: false, leaderPass: false };
  const response = new NativeDecoder();
  const connection = `fragment-${sample}`;
  const socket = createConnection(leaderSocket);
  let registered = false;
  let initializeResponse = false;
  let ended = false;
  socket.on("data", (chunk) => {
    record({ role: "fragment-client", connection, direction: "leader_to_client", boundary: "read", bytes: chunk, sample });
    response.push(chunk);
    registered ||= response.frames.some((item) => item.outer?.type === "registered");
    initializeResponse ||= response.frames.some((item) => item.inner?.id === 1 && (item.inner.result || item.inner.error));
  });
  socket.on("end", () => {
    ended = true;
    record({ role: "fragment-client", connection, direction: "leader_to_client", boundary: "eof", bytes: Buffer.alloc(0), sample });
  });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  for (const chunk of plan.chunks) {
    record({ role: "fragment-client", connection, direction: "client_to_leader", boundary: "write", bytes: chunk, sample });
    socket.write(chunk);
    if (plan.delayMs) await delay(plan.delayMs);
  }
  const deadline = Date.now() + 5_000;
  while ((!registered || !initializeResponse) && Date.now() < deadline) await delay(5);
  socket.end();
  const endDeadline = Date.now() + 1_000;
  while (!ended && Date.now() < endDeadline) await delay(5);
  socket.destroy();
  return {
    proxyPass: true,
    leaderPass: registered && initializeResponse,
    registered,
    initializeResponse,
  };
}

async function runMidFrameDisconnect(leaderSocket, firstFrame, secondFrame) {
  const socket = createConnection(leaderSocket);
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  record({ role: "disconnect-client", connection: "mid-frame", direction: "client_to_leader", boundary: "write", bytes: firstFrame });
  await new Promise((resolveWrite, rejectWrite) => {
    socket.write(firstFrame, (error) => error ? rejectWrite(error) : resolveWrite());
  });
  const partial = secondFrame.subarray(0, 7);
  record({ role: "disconnect-client", connection: "mid-frame", direction: "client_to_leader", boundary: "write", bytes: partial });
  await new Promise((resolveWrite, rejectWrite) => {
    socket.write(partial, (error) => error ? rejectWrite(error) : resolveWrite());
  });
  socket.destroy();
  await delay(100);
}

async function runHalfClose(leaderSocket, stream) {
  const response = new NativeDecoder();
  const socket = createConnection({ path: leaderSocket, allowHalfOpen: true });
  let registered = false;
  let initializeResponse = false;
  let leaderEnded = false;
  socket.on("data", (chunk) => {
    record({
      role: "half-close-client",
      connection: "half-close",
      direction: "leader_to_client",
      boundary: "read",
      bytes: chunk,
    });
    response.push(chunk);
    registered ||= response.frames.some((item) => item.outer?.type === "registered");
    initializeResponse ||= response.frames.some(
      (item) => item.inner?.id === 1 && (item.inner.result || item.inner.error),
    );
  });
  socket.on("end", () => {
    leaderEnded = true;
    record({
      role: "half-close-client",
      connection: "half-close",
      direction: "leader_to_client",
      boundary: "eof",
      bytes: Buffer.alloc(0),
    });
  });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  record({
    role: "half-close-client",
    connection: "half-close",
    direction: "client_to_leader",
    boundary: "write",
    bytes: stream,
  });
  socket.write(stream);
  record({
    role: "half-close-client",
    connection: "half-close",
    direction: "client_to_leader",
    boundary: "eof",
    bytes: Buffer.alloc(0),
  });
  socket.end();
  const deadline = Date.now() + 5_000;
  while ((!registered || !initializeResponse || !leaderEnded) && Date.now() < deadline) {
    await delay(5);
  }
  socket.destroy();
  return {
    passed: registered && initializeResponse && leaderEnded,
    registered,
    initializeResponse,
    leaderEnded,
  };
}

function sessionEventIds(messages, sessionId) {
  const ids = [];
  let replayCount = 0;
  let completionCount = 0;
  for (const message of messages) {
    if (message?.params?.sessionId !== sessionId) continue;
    const meta = message.params?._meta || message.params?.update?._meta || {};
    if (typeof meta.eventId === "string") ids.push(meta.eventId);
    if (meta.replay === true || message.params?.replay === true) replayCount += 1;
    if (message.method === "_x.ai/session/prompt_complete") completionCount += 1;
  }
  return { ids, replayCount, completionCount };
}

async function main() {
  requireInputs();
  mkdirSync(proofCwd, { recursive: true, mode: 0o700 });
  runtimeDir = mkdtempSync(join(tmpdir(), "test223-recovery-"));
  chmodSync(runtimeDir, 0o700);
  stage = "version";
  await verifyVersion();
  recorder = new ByteRecorder(rawOutput, "leader-transport-recovery", {
    grokVersion: expectedVersion,
    scenario: "randomized-stream-and-recovery",
  });

  stage = "leader-start";
  const leaderSocket = join(runtimeDir, "leader.sock");
  leader = spawn(binary, [
    "agent", "leader", "--no-exit-on-disconnect", "--relay-on-demand",
    "--no-auto-update", "--leader-socket", leaderSocket,
  ], { detached: true, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  leader.stdout.resume();
  leader.stderr.resume();
  await waitForSocket(leaderSocket, leader);

  stage = "gateway-generation-1";
  const gatewayPath = join(runtimeDir, "gateway.sock");
  gateway = createGateway(gatewayPath, leaderSocket, 1);
  await gateway.start();
  client = new AcpClient(gatewayPath);
  await client.connect();
  const bootstrap = gateway.capturedClientFrames;
  const registerFrame = bootstrap.find((item) => item.outer?.type === "register")?.frame;
  const initializeFrame = bootstrap.find((item) => item.inner?.method === "initialize")?.frame;
  if (!registerFrame || !initializeFrame) throw new Error("real bootstrap frames absent");
  const stream = Buffer.concat([registerFrame, initializeFrame]);
  const expectedFrames = [registerFrame, initializeFrame];

  const created = await client.request("session/new", { cwd: proofCwd, mcpServers: [] });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string") throw new Error("session id absent");
  client.notifications = [];
  await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply exactly RECOVERY_STAGE_ONE." }],
  }, 180_000);
  const generationOne = sessionEventIds(client.notifications, sessionId);
  if (generationOne.ids.length === 0 || generationOne.completionCount !== 1) {
    throw new Error("generation one event identity ambiguous");
  }
  await client.close();
  client = undefined;
  await gateway.close();
  gateway = undefined;

  stage = "randomized-fragmentation";
  let proxyPasses = 0;
  let leaderPasses = 0;
  const leaderFailureSamples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const result = await runLeaderTrial(leaderSocket, stream, expectedFrames, sample);
    if (result.proxyPass) proxyPasses += 1;
    if (result.leaderPass) leaderPasses += 1;
    if (!result.leaderPass) {
      leaderFailureSamples.push({
        sample,
        registered: result.registered === true,
        initializeResponse: result.initializeResponse === true,
      });
    }
    safeDiagnostics = { sample, proxyPasses, leaderPasses, leaderFailureSamples };
  }
  if (proxyPasses !== sampleCount || leaderPasses !== sampleCount) {
    throw new Error("fragmentation matrix failed");
  }

  stage = "disconnect-matrix";
  const halfClose = await runHalfClose(leaderSocket, stream);
  const halfClosePassed = halfClose.passed;
  safeDiagnostics = {
    ...safeDiagnostics,
    halfClose: {
      passed: halfClose.passed,
      registered: halfClose.registered,
      initializeResponse: halfClose.initializeResponse,
      leaderEnded: halfClose.leaderEnded,
    },
  };
  if (!halfClosePassed) throw new Error("half-close failed");
  await runMidFrameDisconnect(leaderSocket, registerFrame, initializeFrame);
  const health = await runLeaderTrial(leaderSocket, stream, expectedFrames, sampleCount + 1);
  if (!health.proxyPass || !health.leaderPass || leader.exitCode !== null) {
    throw new Error("leader failed after mid-frame disconnect");
  }

  stage = "gateway-generation-2";
  safeDiagnostics = { ...safeDiagnostics, recoveryStep: "gateway-start" };
  gateway = createGateway(gatewayPath, leaderSocket, 2);
  await gateway.start();
  safeDiagnostics = { ...safeDiagnostics, recoveryStep: "client-connect" };
  client = new AcpClient(gatewayPath);
  await client.connect();
  client.notifications = [];
  safeDiagnostics = { ...safeDiagnostics, recoveryStep: "session-load" };
  await client.request("session/load", { sessionId, cwd: proofCwd, mcpServers: [] });
  const afterLoadCount = client.notifications.length;
  safeDiagnostics = { ...safeDiagnostics, recoveryStep: "session-prompt", afterLoadCount };
  await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply exactly RECOVERY_STAGE_TWO." }],
  }, 180_000);
  const generationTwo = sessionEventIds(client.notifications, sessionId);
  const firstIds = new Set(generationOne.ids);
  const secondUnique = new Set(generationTwo.ids);
  const unmarkedIntersection = generationTwo.ids.filter((id) => firstIds.has(id));
  safeDiagnostics = {
    ...safeDiagnostics,
    recoveryStep: "replay-evaluate",
    generationTwoEventIds: generationTwo.ids.length,
    generationTwoUniqueEventIds: secondUnique.size,
    generationTwoCompletions: generationTwo.completionCount,
    replayCount: generationTwo.replayCount,
    intersectionCount: unmarkedIntersection.length,
  };
  if (
    generationTwo.ids.length === 0
    || secondUnique.size !== generationTwo.ids.length
    || generationTwo.completionCount !== 1
    || (unmarkedIntersection.length > 0 && generationTwo.replayCount === 0)
  ) {
    throw new Error("duplicate replay observation ambiguous");
  }

  const controlMethods = [...observedMethods].filter((method) => /cancel|interrupt|steer|too.?late/i.test(method));
  if (controlMethods.length > 0) {
    throw new Error("control method observed without frozen contract");
  }

  stage = "cleanup";
  await client.close();
  client = undefined;
  await gateway.close();
  gateway = undefined;
  await terminate(leader);
  leader = undefined;
  recorder.close();
  recorder = undefined;
  const rawSha256 = createHash("sha256").update(readFileSync(rawOutput)).digest("hex");
  rmSync(rawOutput, { force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = undefined;

  const summary = {
    schema: "test223-live-transport-recovery-summary/v1",
    ok: true,
    protocolFreeze: false,
    grokVersionPinned: true,
    transport: "tcp-style-stream-semantics-over-unix",
    randomizedSamples: sampleCount,
    proxyDecoderPasses: proxyPasses,
    leaderDecoderPasses: leaderPasses,
    oneByteDelayedSamplePassed: true,
    coalescedSamplePassed: true,
    cleanEofObserved: true,
    halfClosePassed,
    midFrameDisconnectContained: true,
    leaderSurvivedDisconnect: true,
    gatewayRestarted: true,
    sameSessionResumed: true,
    duplicateEventIdsObserved: unmarkedIntersection.length,
    replayFlaggedEventsObserved: generationTwo.replayCount,
    postLoadNotificationsObserved: afterLoadCount,
    promptCompletionsAfterReconnect: generationTwo.completionCount,
    cancelInterruptTooLate: "absent-from-actual-wire",
    rawRecordCount,
    rawCaptureSha256: rawSha256,
    rawCaptureDestroyed: !existsSync(rawOutput),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try {
  await main();
} catch {
  process.stdout.write(`${JSON.stringify({
    schema: "test223-live-transport-recovery-summary/v1",
    ok: false,
    protocolFreeze: false,
    stage,
    diagnostics: safeDiagnostics,
  })}\n`);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
  if (gateway) {
    try { await gateway.close(); } catch { /* cleanup only */ }
  }
  if (leader) await terminate(leader);
  if (recorder) recorder.close();
  if (rawOutput) rmSync(rawOutput, { force: true });
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
}
