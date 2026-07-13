import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const EXPECTED_BINARY_SHA256 = "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135";
const TMPFS_MAGIC = 0x01021994;
const MAX_FRAME_BYTES = 1024 * 1024;
const BOUNDED_TRIALS = 100;
const MIN_SEGMENT_BYTES = 2;
const MAX_SEGMENT_BYTES = 4096;
const MAX_SEGMENTS_PER_TRIAL = 128;
const MAX_MICRO_DELAY_MS = 2;
const IO_TIMEOUT_MS = 5_000;
const HALF_CLOSE_CONTAINMENT_TIMEOUT_MS = 750;
const scriptPath = fileURLToPath(import.meta.url);

class ProbeFailure extends Error {
  constructor(code, stage) {
    super(code);
    this.code = code;
    this.stage = stage;
  }
}

function fail(code, stage) {
  throw new ProbeFailure(code, stage);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function withTimeout(promise, timeoutMs, code, stage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure(code, stage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, timeoutMs, code, stage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(5);
  }
  fail(code, stage);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function deleteRawContents(rawDir) {
  if (!existsSync(rawDir)) return;
  for (const entry of readdirSync(rawDir)) {
    rmSync(join(rawDir, entry), { recursive: true, force: true });
  }
}

function verifyRawBoundary(rawDir) {
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  chmodSync(rawDir, 0o700);
  if (lstatSync(rawDir).isSymbolicLink()) fail("RAW_DIR_SYMLINK", "preflight");
  if (Number(statfsSync(rawDir).type) !== TMPFS_MAGIC) fail("RAW_DIR_NOT_TMPFS", "preflight");
  deleteRawContents(rawDir);
}

function assertSocket(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isSocket()) fail("UNSAFE_SOCKET", "socket-check");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    fail("SOCKET_OWNER_MISMATCH", "socket-check");
  }
}

async function waitForSocket(path, child, stage) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      assertSocket(path);
      return;
    } catch {
      if (child?.exitCode !== null) fail("CHILD_EXITED_BEFORE_SOCKET", stage);
      await sleep(25);
    }
  }
  fail("SOCKET_READY_TIMEOUT", stage);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), sleep(1_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function childEnvironment(home, authPath) {
  const environment = {
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
    environment.GROK_OIDC_ISSUER = scope.slice(0, split);
    environment.GROK_OIDC_CLIENT_ID = scope.slice(split + 2);
  }
  const forbidden = Object.keys(environment).filter((key) =>
    key.startsWith("COMMHUB_") || key === "NTOK" || key === "DATABASE_URL"
    || key.startsWith("AWS_") || /(?:_TOKEN|_SECRET)$/.test(key));
  if (forbidden.length > 0) fail("CHILD_ENV_ALLOWLIST_VIOLATION", "preflight");
  return environment;
}

class NativeDecoder {
  constructor(label, onFrame) {
    this.label = label;
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.counters = {
      readCallbacks: 0,
      inputBytes: 0,
      completeFrames: 0,
      maximumAdvertisedFrameBytes: 0,
    };
  }

  push(chunk) {
    const bytes = Buffer.from(chunk);
    this.counters.readCallbacks += 1;
    this.counters.inputBytes += bytes.length;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      this.counters.maximumAdvertisedFrameBytes = Math.max(
        this.counters.maximumAdvertisedFrameBytes,
        length,
      );
      if (length > MAX_FRAME_BYTES) fail("NATIVE_FRAME_EXCEEDS_1MIB", this.label);
      if (this.buffer.length < 4 + length) break;
      const frame = Buffer.from(this.buffer.subarray(0, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
      let outer;
      try {
        outer = JSON.parse(frame.subarray(4).toString("utf8"));
      } catch {
        fail("NATIVE_FRAME_INVALID_JSON", this.label);
      }
      let inner;
      if (outer?.type === "acp") {
        try {
          inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
        } catch {
          fail("NATIVE_ACP_PAYLOAD_INVALID_JSON", this.label);
        }
      }
      this.counters.completeFrames += 1;
      this.onFrame?.({ frame, outer, inner });
    }
  }

  get tailBytes() {
    return this.buffer.length;
  }
}

class AccountedWriter {
  constructor({ socket, role, connection, direction, recorder }) {
    this.socket = socket;
    this.role = role;
    this.connection = connection;
    this.direction = direction;
    this.recorder = recorder;
    this.tail = Promise.resolve();
    this.counters = {
      requestedWrites: 0,
      completedCallbacks: 0,
      requestedBytes: 0,
      completedBytes: 0,
      backpressureEvents: 0,
      drainEvents: 0,
    };
  }

  write(bytesInput, metadata = {}) {
    const bytes = Buffer.from(bytesInput);
    this.tail = this.tail.then(() => this.writeOne(bytes, metadata));
    return this.tail;
  }

  async writeOne(bytes, metadata) {
    this.counters.requestedWrites += 1;
    this.counters.requestedBytes += bytes.length;
    this.recorder.record({
      role: this.role,
      transport: "leader-native-ipc",
      connection: this.connection,
      stream: "unix-socket",
      direction: this.direction,
      boundary: "write",
      ...metadata,
      bytes,
    });
    let callbackResolve;
    let callbackReject;
    const callback = new Promise((resolveCallback, rejectCallback) => {
      callbackResolve = resolveCallback;
      callbackReject = rejectCallback;
    });
    const accepted = this.socket.write(bytes, (error) => {
      if (error) callbackReject(new ProbeFailure("SOCKET_WRITE_CALLBACK_ERROR", this.connection));
      else {
        this.counters.completedCallbacks += 1;
        this.counters.completedBytes += bytes.length;
        callbackResolve();
      }
    });
    if (!accepted) {
      this.counters.backpressureEvents += 1;
      const drain = new Promise((resolveDrain, rejectDrain) => {
        const onError = () => rejectDrain(new ProbeFailure("SOCKET_DRAIN_ERROR", this.connection));
        this.socket.once("error", onError);
        this.socket.once("drain", () => {
          this.socket.off("error", onError);
          this.counters.drainEvents += 1;
          resolveDrain();
        });
      });
      await Promise.all([callback, drain]);
    } else {
      await callback;
    }
  }

  async flush() {
    await this.tail;
    const counters = this.counters;
    if (counters.requestedWrites !== counters.completedCallbacks
      || counters.requestedBytes !== counters.completedBytes
      || counters.backpressureEvents !== counters.drainEvents) {
      fail("WRITE_ACCOUNTING_MISMATCH", this.connection);
    }
  }
}

function recordRead(recorder, { role, connection, direction, bytes, phase, trial }) {
  recorder.record({
    role,
    transport: "leader-native-ipc",
    connection,
    stream: "unix-socket",
    direction,
    boundary: "read",
    phase,
    trial,
    bytes: Buffer.from(bytes),
  });
}

async function captureBootstrapFrames({ binary, environment, cwd, leaderSocket, runtimeDir, recorder }) {
  const proxyPath = join(runtimeDir, "seed.sock");
  rmSync(proxyPath, { force: true });
  const captured = [];
  const sockets = new Set();
  let accepted = 0;
  const server = createServer((front) => {
    accepted += 1;
    const connection = `seed-${accepted}`;
    const upstream = createConnection(leaderSocket);
    sockets.add(front);
    sockets.add(upstream);
    const toLeader = new AccountedWriter({
      socket: upstream,
      role: "seed-frame-gateway",
      connection,
      direction: "gateway_to_leader",
      recorder,
    });
    const decoder = new NativeDecoder("seed-ingress", ({ frame, outer, inner }) => {
      captured.push({ frame, outer, inner });
      void toLeader.write(frame, { phase: "seed" });
    });
    front.on("data", (chunk) => {
      recordRead(recorder, {
        role: "seed-acp-client",
        connection,
        direction: "client_to_gateway",
        phase: "seed",
        bytes: chunk,
      });
      decoder.push(chunk);
    });
    upstream.on("data", (chunk) => {
      recordRead(recorder, {
        role: "shared-leader",
        connection,
        direction: "leader_to_seed_gateway",
        phase: "seed",
        bytes: chunk,
      });
      front.write(chunk);
    });
    front.on("close", () => upstream.destroy());
    upstream.on("close", () => front.destroy());
    front.on("error", () => front.destroy());
    upstream.on("error", () => upstream.destroy());
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(proxyPath, () => {
      server.off("error", rejectListen);
      chmodSync(proxyPath, 0o600);
      resolveListen();
    });
  });
  assertSocket(proxyPath);
  const child = spawn(binary, ["agent", "--leader", "--leader-socket", proxyPath, "stdio"], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  let stdout = "";
  let initializeResponse = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message?.id === 1 && (message.result !== undefined || message.error !== undefined)) {
          initializeResponse = true;
        }
      } catch {
        fail("SEED_STDOUT_NON_JSON", "seed");
      }
    }
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "test223-bounded-seed", version: "1" },
    },
  })}\n`);
  await waitFor(() => initializeResponse, 10_000, "SEED_INITIALIZE_TIMEOUT", "seed");
  await terminate(child);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(proxyPath, { force: true });
  const register = captured.find((item) => item.outer?.type === "register")?.frame;
  const initialize = captured.find((item) => item.inner?.method === "initialize")?.frame;
  if (!register || !initialize) fail("REAL_BOOTSTRAP_FRAMES_MISSING", "seed");
  return { register, initialize };
}

function responseState(decoder) {
  const state = { registered: false, initializeResponse: false };
  const original = decoder.onFrame;
  decoder.onFrame = (parsed) => {
    original?.(parsed);
    if (parsed.outer?.type === "registered") state.registered = true;
    if (parsed.inner?.id === 1 && (parsed.inner.result !== undefined || parsed.inner.error !== undefined)) {
      state.initializeResponse = true;
    }
  };
  return state;
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

function boundedChunks(buffer, seed, minimum = MIN_SEGMENT_BYTES, maximum = MAX_SEGMENT_BYTES) {
  const random = xorshift(seed);
  const chunks = [];
  for (let offset = 0; offset < buffer.length;) {
    const remaining = buffer.length - offset;
    if (remaining <= maximum) {
      if (remaining === 1 && chunks.length > 0) {
        const previous = chunks.pop();
        chunks.push(buffer.subarray(previous.byteOffset - buffer.byteOffset, buffer.length));
      } else {
        chunks.push(buffer.subarray(offset));
      }
      break;
    }
    let size = minimum + (random() % (maximum - minimum + 1));
    if (remaining - size === 1) size += 1;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function splitFramePrefixAndPayload(frame) {
  const chunks = [frame.subarray(0, 2), frame.subarray(2, 4)];
  chunks.push(...boundedChunks(frame.subarray(4), 0x223f0001, 2, 256));
  return chunks.filter((chunk) => chunk.length > 0);
}

function makeBoundedPlan(stream, frames, trial) {
  let segments;
  let label;
  const kind = trial % 8;
  if (kind === 0) {
    label = "coalesced-two-frames";
    segments = [stream];
  } else if (kind === 1) {
    label = "frame-boundaries";
    segments = frames.map((frame) => Buffer.from(frame));
  } else if (kind === 2) {
    label = "split-prefix-payload";
    segments = frames.flatMap(splitFramePrefixAndPayload);
  } else if (kind === 3) {
    label = "fixed-7-byte";
    segments = [];
    for (let offset = 0; offset < stream.length; offset += 7) {
      const end = Math.min(stream.length, offset + 7);
      if (end - offset === 1 && segments.length > 0) {
        const previous = segments.pop();
        segments.push(stream.subarray(previous.byteOffset - stream.byteOffset, end));
      } else {
        segments.push(stream.subarray(offset, end));
      }
    }
  } else {
    label = `deterministic-bounded-${kind}`;
    segments = boundedChunks(stream, 0x22300000 ^ trial);
  }
  const delayMs = trial % 29 === 0 ? 2 : trial % 11 === 0 ? 1 : 0;
  if (segments.length > MAX_SEGMENTS_PER_TRIAL) fail("PLAN_SEGMENT_COUNT_EXCEEDS_BOUND", "plan");
  for (const segment of segments) {
    if (segment.length < MIN_SEGMENT_BYTES || segment.length > MAX_SEGMENT_BYTES) {
      fail("PLAN_SEGMENT_SIZE_OUT_OF_BOUND", "plan");
    }
  }
  if (delayMs > MAX_MICRO_DELAY_MS) fail("PLAN_DELAY_OUT_OF_BOUND", "plan");
  if (!Buffer.concat(segments).equals(stream)) fail("PLAN_REASSEMBLY_MISMATCH", "plan");
  return { label, segments, delayMs };
}

class CompleteFrameGateway {
  constructor({ path, leaderPath, recorder }) {
    this.path = path;
    this.leaderPath = leaderPath;
    this.recorder = recorder;
    this.sequence = 0;
    this.results = new Map();
    this.waiters = new Map();
    this.sockets = new Set();
    this.fatal = undefined;
    this.connectionModes = [];
  }

  enqueueMode(mode) {
    this.connectionModes.push(mode);
  }

  async start() {
    rmSync(this.path, { force: true });
    this.server = createServer({ allowHalfOpen: true }, (front) => this.accept(front));
    await new Promise((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(this.path, () => {
        this.server.off("error", rejectListen);
        chmodSync(this.path, 0o600);
        resolveListen();
      });
    });
    assertSocket(this.path);
  }

  accept(front) {
    const id = ++this.sequence;
    const connection = `bounded-gateway-${id}`;
    const mode = this.connectionModes.shift();
    if (!mode) {
      front.destroy();
      this.fatal = new ProbeFailure("GATEWAY_CONNECTION_MODE_MISSING", connection);
      return;
    }
    const upstream = createConnection(this.leaderPath);
    this.sockets.add(front);
    this.sockets.add(upstream);
    const metrics = {
      id,
      connection,
      mode,
      frontReadCallbacks: 0,
      leaderReadCallbacks: 0,
      completeFramesAdmitted: 0,
      completeFramesFromLeader: 0,
      ingressTailBytes: 0,
      egressTailBytes: 0,
      truncatedMidFrameContained: false,
      halfCloseTimeoutContained: false,
      halfCloseContainmentTimeoutMs: null,
      leaderEndedNaturally: false,
      closeKind: null,
    };
    const toLeader = new AccountedWriter({
      socket: upstream,
      role: "complete-frame-gateway",
      connection,
      direction: "gateway_to_leader",
      recorder: this.recorder,
    });
    const toClient = new AccountedWriter({
      socket: front,
      role: "complete-frame-gateway",
      connection,
      direction: "gateway_to_client",
      recorder: this.recorder,
    });
    let ingressChain = Promise.resolve();
    let egressChain = Promise.resolve();
    let finalized = false;
    let frontEnded = false;
    let upstreamEnded = false;
    let halfCloseTimer;
    let transactionClosing = false;
    const ingress = new NativeDecoder(`${connection}:ingress`, ({ frame }) => {
      metrics.completeFramesAdmitted += 1;
      ingressChain = ingressChain.then(() => toLeader.write(frame, { phase: "bounded" }));
    });
    const egress = new NativeDecoder(`${connection}:egress`, ({ frame, inner }) => {
      if (transactionClosing) return;
      metrics.completeFramesFromLeader += 1;
      egressChain = egressChain.then(() => toClient.write(frame, { phase: "bounded" }));
      if (mode === "bounded-transaction" && inner?.id === 1
        && (inner.result !== undefined || inner.error !== undefined)) {
        transactionClosing = true;
        void egressChain.then(async () => {
          await toClient.flush();
          upstream.destroy();
          front.end(() => { void finalize("initialize-transaction-complete"); });
        }).catch((error) => {
          this.fatal = error;
          void finalize("initialize-transaction-error");
        });
      }
    });

    const finalize = async (closeKind) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(halfCloseTimer);
      try {
        await Promise.all([ingressChain, egressChain]);
        await Promise.all([toLeader.flush(), toClient.flush()]);
        metrics.ingressTailBytes = ingress.tailBytes;
        metrics.egressTailBytes = egress.tailBytes;
        metrics.closeKind = closeKind;
        metrics.toLeader = structuredClone(toLeader.counters);
        metrics.toClient = structuredClone(toClient.counters);
        this.results.set(id, metrics);
        this.waiters.get(id)?.resolve(metrics);
      } catch (error) {
        this.fatal = error instanceof ProbeFailure
          ? error
          : new ProbeFailure("GATEWAY_FINALIZE_FAILED", connection);
        this.waiters.get(id)?.reject(this.fatal);
      } finally {
        this.waiters.delete(id);
        front.destroy();
        upstream.destroy();
      }
    };

    front.on("data", (chunk) => {
      metrics.frontReadCallbacks += 1;
      recordRead(this.recorder, {
        role: "bounded-client",
        connection,
        direction: "client_to_gateway",
        phase: "bounded",
        trial: id - 1,
        bytes: chunk,
      });
      try {
        ingress.push(chunk);
      } catch (error) {
        this.fatal = error;
        void finalize("ingress-error");
      }
    });
    upstream.on("data", (chunk) => {
      metrics.leaderReadCallbacks += 1;
      recordRead(this.recorder, {
        role: "shared-leader",
        connection,
        direction: "leader_to_gateway",
        phase: "bounded",
        trial: id - 1,
        bytes: chunk,
      });
      try {
        egress.push(chunk);
      } catch (error) {
        this.fatal = error;
        void finalize("egress-error");
      }
    });
    front.on("end", () => {
      if (finalized) return;
      frontEnded = true;
      void (async () => {
        await ingressChain;
        await toLeader.flush();
        metrics.ingressTailBytes = ingress.tailBytes;
        if (ingress.tailBytes > 0) {
          metrics.truncatedMidFrameContained = true;
          upstream.destroy();
          front.end(() => { void finalize("truncated-half-close-contained"); });
        } else {
          upstream.end();
          halfCloseTimer = setTimeout(() => {
            if (finalized || upstreamEnded) return;
            metrics.halfCloseTimeoutContained = true;
            metrics.halfCloseContainmentTimeoutMs = HALF_CLOSE_CONTAINMENT_TIMEOUT_MS;
            upstream.destroy();
            front.end();
            void finalize("clean-input-half-close-timeout-contained");
          }, HALF_CLOSE_CONTAINMENT_TIMEOUT_MS);
        }
      })().catch((error) => {
        this.fatal = error;
        void finalize("front-end-error");
      });
    });
    upstream.on("end", () => {
      upstreamEnded = true;
      metrics.leaderEndedNaturally = true;
      clearTimeout(halfCloseTimer);
      void (async () => {
        await egressChain;
        await toClient.flush();
        metrics.egressTailBytes = egress.tailBytes;
        front.end(() => { void finalize("clean-half-close"); });
      })().catch((error) => {
        this.fatal = error;
        void finalize("leader-end-error");
      });
    });
    front.on("close", () => {
      this.sockets.delete(front);
      if (!frontEnded) {
        upstream.destroy();
        void finalize("client-disconnect-after-response");
      } else if (upstreamEnded) {
        void finalize("clean-half-close");
      } else if (metrics.halfCloseTimeoutContained) {
        void finalize("clean-input-half-close-timeout-contained");
      }
    });
    upstream.on("close", () => {
      this.sockets.delete(upstream);
      if (!frontEnded) return;
      if (metrics.truncatedMidFrameContained) void finalize("truncated-half-close-contained");
    });
    front.on("error", () => front.destroy());
    upstream.on("error", () => upstream.destroy());
  }

  waitForResult(id, timeoutMs = IO_TIMEOUT_MS) {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.results.has(id)) return Promise.resolve(this.results.get(id));
    return withTimeout(new Promise((resolveResult, rejectResult) => {
      this.waiters.set(id, { resolve: resolveResult, reject: rejectResult });
    }), timeoutMs, "GATEWAY_RESULT_TIMEOUT", `connection-${id}`);
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolveClose) => this.server.close(resolveClose));
    rmSync(this.path, { force: true });
  }
}

async function connectSocket(path, allowHalfOpen = false) {
  const socket = createConnection({ path, allowHalfOpen });
  await withTimeout(new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  }), IO_TIMEOUT_MS, "CLIENT_CONNECT_TIMEOUT", "client-connect");
  return socket;
}

async function runPathologicalDirect({ leaderSocket, stream, recorder }) {
  const socket = await connectSocket(leaderSocket);
  const connection = "pathological-direct-one-byte-1ms";
  const decoder = new NativeDecoder("pathological-direct-response");
  const state = responseState(decoder);
  let readCallbacks = 0;
  socket.on("data", (chunk) => {
    readCallbacks += 1;
    recordRead(recorder, {
      role: "pathological-direct-client",
      connection,
      direction: "leader_to_client",
      phase: "pathological-direct-negative-control",
      bytes: chunk,
    });
    decoder.push(chunk);
  });
  const writer = new AccountedWriter({
    socket,
    role: "pathological-direct-client",
    connection,
    direction: "client_to_leader",
    recorder,
  });
  let writeErrorObserved = false;
  let writeErrorCode = null;
  for (const byte of stream) {
    try {
      await writer.write(Buffer.of(byte), { phase: "pathological-direct-negative-control" });
      await sleep(1);
    } catch (error) {
      writeErrorObserved = true;
      writeErrorCode = error instanceof ProbeFailure ? error.code : "UNEXPECTED_WRITE_ERROR";
      break;
    }
  }
  if (!writeErrorObserved) {
    try {
      await writer.flush();
    } catch (error) {
      writeErrorObserved = true;
      writeErrorCode = error instanceof ProbeFailure ? error.code : "UNEXPECTED_FLUSH_ERROR";
    }
  }
  const deadline = Date.now() + IO_TIMEOUT_MS;
  while ((!state.registered || !state.initializeResponse) && Date.now() < deadline) await sleep(5);
  socket.destroy();
  return {
    excludedFromGreenCount: true,
    requestedSegmentBytes: 1,
    delayBetweenSegmentsMs: 1,
    registered: state.registered,
    initializeResponse: state.initializeResponse,
    expectedRedObserved: writeErrorObserved || !state.initializeResponse,
    unexpectedlyCompleted: state.registered && state.initializeResponse,
    writeErrorObserved,
    writeErrorCode,
    responseTailBytes: decoder.tailBytes,
    responseReadCallbacks: readCallbacks,
    writeAccounting: writer.counters,
  };
}

async function runBoundedTrial({ gateway, gatewayPath, stream, frames, trial, recorder }) {
  const connectionId = gateway.sequence + 1;
  gateway.enqueueMode("bounded-transaction");
  const socket = await connectSocket(gatewayPath);
  const connection = `bounded-client-${trial}`;
  const response = new NativeDecoder(`${connection}:response`);
  const state = responseState(response);
  let responseReadCallbacks = 0;
  let transactionEnded = false;
  socket.on("data", (chunk) => {
    responseReadCallbacks += 1;
    recordRead(recorder, {
      role: "bounded-client",
      connection,
      direction: "gateway_to_client",
      phase: "bounded",
      trial,
      bytes: chunk,
    });
    response.push(chunk);
  });
  socket.on("end", () => { transactionEnded = true; });
  const writer = new AccountedWriter({
    socket,
    role: "bounded-client",
    connection,
    direction: "client_to_gateway",
    recorder,
  });
  const plan = makeBoundedPlan(stream, frames, trial);
  for (let index = 0; index < plan.segments.length; index += 1) {
    await writer.write(plan.segments[index], {
      phase: "bounded",
      trial,
      requestedSegment: index,
      plan: plan.label,
    });
    if (plan.delayMs && index < plan.segments.length - 1) await sleep(plan.delayMs);
  }
  await writer.flush();
  const deadline = Date.now() + IO_TIMEOUT_MS;
  while ((!state.registered || !state.initializeResponse) && Date.now() < deadline) await sleep(5);
  const passedBeforeDisconnect = state.registered && state.initializeResponse;
  if (passedBeforeDisconnect) {
    await waitFor(() => transactionEnded,
      IO_TIMEOUT_MS, "TRANSACTION_END_TIMEOUT", `bounded-trial-${trial}`);
  }
  const gatewayMetrics = await gateway.waitForResult(connectionId);
  socket.destroy();
  const passed = passedBeforeDisconnect
    && response.tailBytes === 0
    && gatewayMetrics.ingressTailBytes === 0
    && gatewayMetrics.egressTailBytes === 0
    && gatewayMetrics.completeFramesAdmitted === frames.length
    && gatewayMetrics.toLeader.requestedWrites === frames.length
    && gatewayMetrics.toLeader.requestedWrites === gatewayMetrics.toLeader.completedCallbacks
    && gatewayMetrics.toLeader.requestedBytes === gatewayMetrics.toLeader.completedBytes
    && gatewayMetrics.toLeader.backpressureEvents === gatewayMetrics.toLeader.drainEvents
    && gatewayMetrics.toClient.requestedWrites === gatewayMetrics.toClient.completedCallbacks
    && gatewayMetrics.toClient.requestedBytes === gatewayMetrics.toClient.completedBytes
    && gatewayMetrics.toClient.backpressureEvents === gatewayMetrics.toClient.drainEvents;
  return {
    passed,
    trial,
    plan: plan.label,
    delayMs: plan.delayMs,
    requestedSegments: plan.segments.length,
    requestedBytes: stream.length,
    clientWriteCallbacks: writer.counters.completedCallbacks,
    clientDrains: writer.counters.drainEvents,
    gatewayReadCallbacks: gatewayMetrics.frontReadCallbacks,
    leaderReadCallbacks: gatewayMetrics.leaderReadCallbacks,
    admittedFrames: gatewayMetrics.completeFramesAdmitted,
    upstreamWriteCallbacks: gatewayMetrics.toLeader.completedCallbacks,
    upstreamDrains: gatewayMetrics.toLeader.drainEvents,
    downstreamWriteCallbacks: gatewayMetrics.toClient.completedCallbacks,
    downstreamDrains: gatewayMetrics.toClient.drainEvents,
    responseReadCallbacks,
    tails: {
      client: response.tailBytes,
      gatewayIngress: gatewayMetrics.ingressTailBytes,
      gatewayEgress: gatewayMetrics.egressTailBytes,
    },
    registered: state.registered,
    initializeResponse: state.initializeResponse,
  };
}

async function runHalfClose({ gateway, gatewayPath, stream, recorder }) {
  const connectionId = gateway.sequence + 1;
  gateway.enqueueMode("half-close");
  const socket = await connectSocket(gatewayPath, true);
  const response = new NativeDecoder("half-close-response");
  const state = responseState(response);
  let clientObservedGatewayEnd = false;
  let clientObservedGatewayClose = false;
  socket.on("data", (chunk) => {
    recordRead(recorder, {
      role: "half-close-client",
      connection: "half-close",
      direction: "gateway_to_client",
      phase: "post-green-containment",
      bytes: chunk,
    });
    response.push(chunk);
  });
  socket.on("end", () => { clientObservedGatewayEnd = true; });
  socket.on("close", () => { clientObservedGatewayClose = true; });
  const writer = new AccountedWriter({
    socket,
    role: "half-close-client",
    connection: "half-close",
    direction: "client_to_gateway",
    recorder,
  });
  await writer.write(stream, { phase: "post-green-containment" });
  await writer.flush();
  socket.end();
  await waitFor(() => state.registered && state.initializeResponse
      && (clientObservedGatewayEnd || clientObservedGatewayClose),
    IO_TIMEOUT_MS, "HALF_CLOSE_RESPONSE_TIMEOUT", "post-green-containment");
  const metrics = await gateway.waitForResult(connectionId);
  socket.destroy();
  const passed = state.registered && state.initializeResponse
    && (clientObservedGatewayEnd || clientObservedGatewayClose)
    && response.tailBytes === 0 && metrics.ingressTailBytes === 0 && metrics.egressTailBytes === 0
    && metrics.toLeader.requestedWrites === metrics.toLeader.completedCallbacks
    && metrics.toClient.requestedWrites === metrics.toClient.completedCallbacks
    && (metrics.leaderEndedNaturally || metrics.halfCloseTimeoutContained);
  return {
    passed,
    registered: state.registered,
    initializeResponse: state.initializeResponse,
    clientObservedGatewayEnd,
    clientObservedGatewayClose,
    leaderEndedNaturally: metrics.leaderEndedNaturally,
    halfCloseTimeoutContained: metrics.halfCloseTimeoutContained,
    halfCloseContainmentTimeoutMs: metrics.halfCloseContainmentTimeoutMs,
    closeKind: metrics.closeKind,
    tails: {
      client: response.tailBytes,
      gatewayIngress: metrics.ingressTailBytes,
      gatewayEgress: metrics.egressTailBytes,
    },
  };
}

async function runMidFrameContainment({ gateway, gatewayPath, frames, recorder }) {
  const connectionId = gateway.sequence + 1;
  gateway.enqueueMode("mid-frame");
  const socket = await connectSocket(gatewayPath, true);
  const response = new NativeDecoder("mid-frame-response");
  const state = responseState(response);
  socket.on("data", (chunk) => {
    recordRead(recorder, {
      role: "mid-frame-client",
      connection: "mid-frame",
      direction: "gateway_to_client",
      phase: "post-green-containment",
      bytes: chunk,
    });
    response.push(chunk);
  });
  const writer = new AccountedWriter({
    socket,
    role: "mid-frame-client",
    connection: "mid-frame",
    direction: "client_to_gateway",
    recorder,
  });
  await writer.write(frames[0], { phase: "post-green-containment" });
  await writer.write(frames[1].subarray(0, 7), { phase: "post-green-containment" });
  await writer.flush();
  socket.end();
  const metrics = await gateway.waitForResult(connectionId);
  socket.destroy();
  return {
    passed: metrics.truncatedMidFrameContained
      && metrics.ingressTailBytes === 7
      && metrics.completeFramesAdmitted === 1
      && metrics.toLeader.requestedWrites === 1
      && !state.initializeResponse,
    registeredMayRaceBeforeContainment: state.registered,
    initializeResponseBlocked: !state.initializeResponse,
    ingressTailBytes: metrics.ingressTailBytes,
    completeFramesForwarded: metrics.toLeader.requestedWrites,
    closeKind: metrics.closeKind,
  };
}

function aggregateTrials(results) {
  const planCounts = {};
  const totals = {
    requestedSegments: 0,
    clientWriteCallbacks: 0,
    clientDrains: 0,
    gatewayReadCallbacks: 0,
    leaderReadCallbacks: 0,
    admittedFrames: 0,
    upstreamWriteCallbacks: 0,
    upstreamDrains: 0,
    downstreamWriteCallbacks: 0,
    downstreamDrains: 0,
    responseReadCallbacks: 0,
  };
  for (const result of results) {
    planCounts[result.plan] = (planCounts[result.plan] || 0) + 1;
    for (const key of Object.keys(totals)) totals[key] += result[key];
  }
  return { planCounts, totals };
}

async function runMain() {
  const rawDir = resolve(process.env.RAW_DIR || "/capture-raw");
  process.env.RAW_DIR = rawDir;
  const binary = resolve(process.env.GROK_BINARY || "/host-grok/grok");
  const authPath = resolve(process.env.GROK_AUTH_PATH || "/host-grok/auth.json");
  const agentIdPath = resolve(process.env.GROK_AGENT_ID_PATH || "/host-grok/agent_id");
  let stage = "preflight";
  let recorder;
  let leader;
  let gateway;
  const safeDiagnostics = {
    boundedCompleted: 0,
    boundedPasses: 0,
    failureSamples: [],
    containmentStarted: false,
  };
  try {
    if (!existsSync("/.dockerenv")) fail("DOCKER_REQUIRED", stage);
    if (!existsSync(binary) || !existsSync(authPath)) fail("MISSING_PINNED_INPUT", stage);
    verifyRawBoundary(rawDir);
    if (sha256File(binary) !== EXPECTED_BINARY_SHA256) fail("BINARY_HASH_MISMATCH", stage);
    const home = join(rawDir, "home");
    const cwd = join(rawDir, "cwd");
    const runtimeDir = join(rawDir, "runtime");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(runtimeDir, { mode: 0o700 });
    if (existsSync(agentIdPath)) writeFileSync(join(home, "agent_id"), readFileSync(agentIdPath), { mode: 0o600 });
    const environment = childEnvironment(home, authPath);

    const version = await withTimeout(new Promise((resolveVersion, rejectVersion) => {
      const child = spawn(binary, ["--version"], {
        env: { PATH: environment.PATH },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.once("error", rejectVersion);
      child.once("exit", (code) => code === 0
        ? resolveVersion(stdout.trim())
        : rejectVersion(new ProbeFailure("VERSION_EXIT_NONZERO", stage)));
    }), 5_000, "VERSION_TIMEOUT", stage);
    if (!version.includes(EXPECTED_VERSION)) fail("VERSION_MISMATCH", stage);

    recorder = new ByteRecorder(join(rawDir, "bounded-frame-transport.raw.ndjson"),
      "live-bounded-frame-transport", { generation: 1 });
    stage = "leader-start";
    const leaderSocket = join(runtimeDir, "leader.sock");
    leader = spawn(binary, [
      "agent", "leader", "--no-exit-on-disconnect", "--relay-on-demand",
      "--no-auto-update", "--leader-socket", leaderSocket,
    ], {
      cwd,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    leader.stdout.resume();
    leader.stderr.resume();
    await waitForSocket(leaderSocket, leader, stage);

    stage = "real-bootstrap-seed";
    const bootstrap = await captureBootstrapFrames({
      binary,
      environment,
      cwd,
      leaderSocket,
      runtimeDir,
      recorder,
    });
    const frames = [bootstrap.register, bootstrap.initialize];
    const stream = Buffer.concat(frames);

    stage = "pathological-direct-negative-control";
    const pathologicalDirect = await runPathologicalDirect({ leaderSocket, stream, recorder });

    stage = "bounded-complete-frame-gateway";
    const gatewayPath = join(runtimeDir, "bounded-gateway.sock");
    gateway = new CompleteFrameGateway({ path: gatewayPath, leaderPath: leaderSocket, recorder });
    await gateway.start();
    const trialResults = [];
    for (let trial = 0; trial < BOUNDED_TRIALS; trial += 1) {
      const result = await runBoundedTrial({ gateway, gatewayPath, stream, frames, trial, recorder });
      trialResults.push(result);
      safeDiagnostics.boundedCompleted += 1;
      if (result.passed) safeDiagnostics.boundedPasses += 1;
      else safeDiagnostics.failureSamples.push({
        trial,
        plan: result.plan,
        registered: result.registered,
        initializeResponse: result.initializeResponse,
        tails: result.tails,
      });
    }
    if (safeDiagnostics.boundedCompleted !== BOUNDED_TRIALS
      || safeDiagnostics.boundedPasses !== BOUNDED_TRIALS
      || safeDiagnostics.failureSamples.length !== 0) {
      fail("BOUNDED_GATEWAY_BELOW_100_OF_100", stage);
    }
    const aggregate = aggregateTrials(trialResults);
    const requestedClientCallbacks = aggregate.totals.requestedSegments;
    if (aggregate.totals.clientWriteCallbacks !== requestedClientCallbacks
      || aggregate.totals.admittedFrames !== BOUNDED_TRIALS * frames.length
      || aggregate.totals.upstreamWriteCallbacks !== aggregate.totals.admittedFrames
      || trialResults.some((result) => Object.values(result.tails).some((value) => value !== 0))) {
      fail("BOUNDED_AGGREGATE_ACCOUNTING_MISMATCH", stage);
    }

    stage = "post-green-containment";
    safeDiagnostics.containmentStarted = true;
    const halfClose = await runHalfClose({ gateway, gatewayPath, stream, recorder });
    if (!halfClose.passed) fail("HALF_CLOSE_CONTAINMENT_FAILED", stage);
    const midFrame = await runMidFrameContainment({ gateway, gatewayPath, frames, recorder });
    if (!midFrame.passed) fail("MID_FRAME_CONTAINMENT_FAILED", stage);
    const healthTrial = await runBoundedTrial({
      gateway,
      gatewayPath,
      stream,
      frames,
      trial: BOUNDED_TRIALS,
      recorder,
    });
    if (!healthTrial.passed || leader.exitCode !== null) fail("LEADER_UNHEALTHY_AFTER_CONTAINMENT", stage);

    await gateway.close();
    gateway = undefined;
    await terminate(leader);
    leader = undefined;
    recorder.close();
    recorder = undefined;
    const rawPath = join(rawDir, "bounded-frame-transport.raw.ndjson");
    const rawCaptureSha256 = sha256File(rawPath);
    const rawRecordCount = readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean).length;
    deleteRawContents(rawDir);

    const summary = {
      schema: "test223-live-bounded-frame-transport-summary/v1",
      ok: true,
      protocolFreeze: false,
      baseline: {
        version: EXPECTED_VERSION,
        binarySha256: EXPECTED_BINARY_SHA256,
        realRegisterAndInitializeFramesCaptured: true,
        modelPromptsIssued: 0,
      },
      bounds: {
        trialCount: BOUNDED_TRIALS,
        minimumRequestedSegmentBytes: MIN_SEGMENT_BYTES,
        maximumRequestedSegmentBytes: MAX_SEGMENT_BYTES,
        maximumRequestedSegmentsPerTrial: MAX_SEGMENTS_PER_TRIAL,
        maximumInterSegmentDelayMs: MAX_MICRO_DELAY_MS,
        maximumNativeFrameBytes: MAX_FRAME_BYTES,
        gatewayAdmissionUnit: "one-complete-native-frame",
        leaderFacingWriteUnit: "one-complete-native-frame-per-write-call",
      },
      pathologicalDirectNegativeControl: pathologicalDirect,
      boundedGateway: {
        requestedTrials: BOUNDED_TRIALS,
        completedTrials: safeDiagnostics.boundedCompleted,
        passedTrials: safeDiagnostics.boundedPasses,
        failedTrials: safeDiagnostics.failureSamples.length,
        failureSamples: safeDiagnostics.failureSamples,
        planCounts: aggregate.planCounts,
        accounting: aggregate.totals,
        requestedClientWritesEqualCallbacks: aggregate.totals.requestedSegments
          === aggregate.totals.clientWriteCallbacks,
        admittedFramesEqualUpstreamCallbacks: aggregate.totals.admittedFrames
          === aggregate.totals.upstreamWriteCallbacks,
        zeroTailTrials: trialResults.filter((result) =>
          Object.values(result.tails).every((value) => value === 0)).length,
      },
      containment: {
        ranOnlyAfterBounded100Of100: true,
        halfClose,
        midFrame,
        leaderHealthAfterContainment: {
          passed: healthTrial.passed,
          registered: healthTrial.registered,
          initializeResponse: healthTrial.initializeResponse,
          leaderProcessAlive: true,
          tails: healthTrial.tails,
        },
      },
      rawCapture: {
        storage: "explicit-tmpfs-only",
        sha256: rawCaptureSha256,
        recordCount: rawRecordCount,
        persisted: false,
        destroyedBeforeStdout: true,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const sanitized = error instanceof ProbeFailure
      ? { errorCode: error.code, errorStage: error.stage }
      : {
        errorCode: "UNEXPECTED_FAILURE",
        errorStage: stage,
        errorType: typeof error?.name === "string" ? error.name : "UnknownError",
      };
    process.stdout.write(`${JSON.stringify({
      schema: "test223-live-bounded-frame-transport-summary/v1",
      ok: false,
      protocolFreeze: false,
      stage,
      ...sanitized,
      diagnostics: safeDiagnostics,
    })}\n`);
    process.exitCode = 1;
  } finally {
    if (gateway) {
      try { await gateway.close(); } catch {}
    }
    await terminate(leader);
    try { recorder?.close(); } catch {}
    try { deleteRawContents(rawDir); } catch {}
  }
}

void runMain();
