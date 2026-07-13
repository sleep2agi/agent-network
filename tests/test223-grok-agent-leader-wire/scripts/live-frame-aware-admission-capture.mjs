import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const CAPTURE = "live-frame-aware-admission";
const MAX_FRAME_BYTES = 1024 * 1024;
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
  constructor(socket, label, recorder, recordMeta, maximumSegmentBytes = 4096) {
    this.socket = socket;
    this.label = label;
    this.recorder = recorder;
    this.recordMeta = recordMeta;
    this.maximumSegmentBytes = maximumSegmentBytes;
    this.tail = Promise.resolve();
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
    const bytes = Buffer.from(frame);
    this.tail = this.tail.then(async () => {
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
    });
    return this.tail;
  }

  async writeSegment(segment) {
    this.counters.writeSegments += 1;
    this.recorder.record({ ...this.recordMeta, boundary: "write", bytes: segment });
    let callbackResolve;
    let callbackReject;
    const callbackDone = new Promise((resolveCallback, rejectCallback) => {
      callbackResolve = resolveCallback;
      callbackReject = rejectCallback;
    });
    const accepted = this.socket.write(segment, (error) => {
      if (error) callbackReject(new CaptureError("NATIVE_SOCKET_WRITE_FAILED"));
      else callbackResolve();
    });
    if (!accepted) {
      this.counters.backpressureEvents += 1;
      await Promise.all([
        callbackDone,
        new Promise((resolveDrain, rejectDrain) => {
          const onError = () => rejectDrain(new CaptureError("NATIVE_SOCKET_DRAIN_FAILED"));
          this.socket.once("error", onError);
          this.socket.once("drain", () => {
            this.socket.removeListener("error", onError);
            this.counters.drainEvents += 1;
            resolveDrain();
          });
        }),
      ]);
    } else {
      await callbackDone;
    }
    this.counters.completedBytes += segment.length;
  }

  async flush() {
    await this.tail;
    if (this.counters.completedBytes !== this.counters.requestedBytes) {
      throw new CaptureError("NATIVE_PARTIAL_WRITE_ACCOUNTING_MISMATCH");
    }
  }
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
    this.rejectEnabled = false;
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
  const sockets = [];
  const writers = [];
  const decoders = [];
  const chainSnapshots = [];
  const metrics = {
    gatewayIngressReadEvents: 0,
    gatewayIngressBytes: 0,
    gatewayIngressCompleteFrames: 0,
    framesForwardedToRealLeader: 0,
    bytesForwardedToRealLeader: 0,
    framesForwardedBackToGateway: 0,
    bytesForwardedBackToGateway: 0,
  };
  const server = createServer((gatewaySocket) => {
    accepted += 1;
    if (accepted !== 1) {
      gatewaySocket.destroy();
      onFatal(new CaptureError(`${name.toUpperCase()}_TAP_MULTIPLE_CLIENTS`));
      return;
    }
    const realLeaderSocket = createConnection(leaderPath);
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
    );
    writers.push(toRealLeader, toGateway);
    let gatewayChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    let forceSplitToRealLeader = true;
    chainSnapshots.push(() => Promise.all([gatewayChain, leaderChain]));
    const gatewayDecoder = new IncrementalNativeDecoder(`${name}-tap-gateway`, (parsed) => {
      metrics.gatewayIngressCompleteFrames += 1;
      gatewayChain = gatewayChain.then(async () => {
        const split = forceSplitToRealLeader;
        forceSplitToRealLeader = false;
        await toRealLeader.writeFrame(parsed.frame, { forceSplitPrefix: split });
        metrics.framesForwardedToRealLeader += 1;
        metrics.bytesForwardedToRealLeader += parsed.frame.length;
      }).catch(onFatal);
    });
    const leaderDecoder = new IncrementalNativeDecoder(`${name}-tap-real-leader`, (parsed) => {
      leaderChain = leaderChain.then(async () => {
        await toGateway.writeFrame(parsed.frame);
        metrics.framesForwardedBackToGateway += 1;
        metrics.bytesForwardedBackToGateway += parsed.frame.length;
      }).catch(onFatal);
    });
    decoders.push(gatewayDecoder, leaderDecoder);
    gatewaySocket.on("data", (chunk) => {
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
        onFatal(error instanceof CaptureError ? error : new CaptureError("TAP_GATEWAY_DECODER_FAILED"));
        gatewaySocket.destroy();
        realLeaderSocket.destroy();
      }
    });
    realLeaderSocket.on("data", (chunk) => {
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
        onFatal(error instanceof CaptureError ? error : new CaptureError("TAP_LEADER_DECODER_FAILED"));
        gatewaySocket.destroy();
        realLeaderSocket.destroy();
      }
    });
    gatewaySocket.on("end", () => realLeaderSocket.end());
    realLeaderSocket.on("end", () => gatewaySocket.end());
    gatewaySocket.on("error", () => realLeaderSocket.destroy());
    realLeaderSocket.on("error", () => gatewaySocket.destroy());
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(tapPath, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  chmodSync(tapPath, 0o600);
  return {
    accepted: () => accepted,
    metrics: () => ({ ...metrics }),
    decoderCounters: () => decoders.map((decoder) => ({
      label: decoder.label,
      ...decoder.counters,
    })),
    writerCounters: () => writers.map((writer) => ({
      label: writer.label,
      ...writer.counters,
    })),
    flush: async () => {
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
    },
    close: async () => {
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
    },
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
  let accepted = 0;
  let forceSplitToLeader = true;
  const metrics = {
    completeFramesFromClient: 0,
    completeFramesFromLeader: 0,
    framesForwardedToLeader: 0,
    bytesForwardedToLeader: 0,
    framesForwardedToClient: 0,
    bytesForwardedToClient: 0,
    locallyRejectedFrames: 0,
    localResponseFrames: 0,
  };

  const server = createServer((clientSocket) => {
    accepted += 1;
    if (accepted !== 1) {
      clientSocket.destroy();
      onFatal(new CaptureError(`${name.toUpperCase()}_MULTIPLE_CLIENTS`));
      return;
    }
    const leaderSocket = createConnection(leaderPath);
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
    );
    writers.push(toLeader, toClient);
    let clientChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    chainSnapshots.push(() => Promise.all([clientChain, leaderChain]));

    const clientDecoder = new IncrementalNativeDecoder(`${name}-client`, (parsed) => {
      metrics.completeFramesFromClient += 1;
      clientChain = clientChain.then(async () => {
        const inner = parsed.inner;
        const hasRejectedText = containsMarker(inner, REJECTED_MARKER);
        if (name === "tui" && admission.rejectEnabled) {
          const mutating = isTuiMutatingMethod(inner?.method);
          if (mutating) {
            admission.mutatingFramesSeenInWindow += 1;
            admission.mutatingFramesBlockedInWindow += 1;
            metrics.locallyRejectedFrames += 1;
            if (!admission.rejected) {
              if (inner?.method !== "session/prompt"
                || inner?.id === undefined
                || !hasRejectedText) {
                throw new CaptureError("FIRST_WINDOW_MUTATION_WAS_NOT_EXPECTED_TUI_PROMPT");
              }
              admission.rejected = true;
              admission.rejectedAt = Date.now();
            } else {
              admission.postBusyMutatingFramesBlocked += 1;
              if (hasRejectedText) admission.subsequentRejectedTextFrames += 1;
              if (/session\/prompt|steer|inject|replay/i.test(String(inner?.method || ""))) {
                admission.subsequentSteerOrReplayFrames += 1;
              }
            }
            if (inner?.id !== undefined) {
              const responseInner = {
                jsonrpc: "2.0",
                id: inner.id,
                error: {
                  code: -32001,
                  message: "Busy",
                  data: {
                    reason: "gateway_admission_busy",
                    retryable: false,
                  },
                },
              };
              const responseOuter = outerWithInner(parsed.outer, responseInner);
              if (!admission.busyResponseSent) {
                admission.originalIdPreserved = responseInner.id === inner.id;
              }
              await toClient.writeFrame(encodeNativeFrame(responseOuter));
              admission.busyResponseSent = true;
              metrics.localResponseFrames += 1;
            }
            return;
          }
          // Freeze every TUI-originated frame during the measured rejection
          // window. This makes the independent tap's zero-delta assertion a
          // physical property, not a branch counter. Non-mutating keepalives
          // are intentionally not replayed after the short window.
          admission.nonMutatingFramesSuppressedInWindow += 1;
          return;
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
        await toLeader.writeFrame(parsed.frame, { forceSplitPrefix: split });
        metrics.framesForwardedToLeader += 1;
        metrics.bytesForwardedToLeader += parsed.frame.length;
      }).catch(onFatal);
    });

    const leaderDecoder = new IncrementalNativeDecoder(`${name}-leader`, (parsed) => {
      metrics.completeFramesFromLeader += 1;
      leaderChain = leaderChain.then(async () => {
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
        metrics.framesForwardedToClient += 1;
        metrics.bytesForwardedToClient += parsed.frame.length;
      }).catch(onFatal);
    });
    decoders.push(clientDecoder, leaderDecoder);

    clientSocket.on("data", (chunk) => {
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
        onFatal(error instanceof CaptureError ? error : new CaptureError("CLIENT_DECODER_FAILED"));
        clientSocket.destroy();
        leaderSocket.destroy();
      }
    });
    leaderSocket.on("data", (chunk) => {
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
        onFatal(error instanceof CaptureError ? error : new CaptureError("LEADER_DECODER_FAILED"));
        clientSocket.destroy();
        leaderSocket.destroy();
      }
    });
    clientSocket.on("end", () => leaderSocket.end());
    leaderSocket.on("end", () => clientSocket.end());
    clientSocket.on("error", () => leaderSocket.destroy());
    leaderSocket.on("error", () => clientSocket.destroy());
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(listenerPath, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  chmodSync(listenerPath, 0o600);
  return {
    accepted: () => accepted,
    metrics: () => ({ ...metrics }),
    decoderCounters: () => decoders.map((decoder) => ({
      label: decoder.label,
      ...decoder.counters,
    })),
    writerCounters: () => writers.map((writer) => ({
      label: writer.label,
      ...writer.counters,
    })),
    flush: async () => {
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
    },
    close: async () => {
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await Promise.all(chainSnapshots.map((snapshot) => snapshot()));
      await Promise.all(writers.map((writer) => writer.flush()));
    },
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
  }

  async connect() {
    this.child = spawn(this.binary, [
      "agent", "--leader", "--leader-socket", this.socketPath, "stdio",
    ], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.childCloseObserved = false;
    this.childClosed = new Promise((resolveClose) => {
      this.child.once("close", () => {
        this.childCloseObserved = true;
        resolveClose();
      });
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-32_768);
    });
    const initialized = await this.call("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 30_000);
    if (!Array.isArray(initialized?.authMethods)
      || !initialized.authMethods.some((method) => method?.id === "cached_token")) {
      throw new CaptureError("CACHED_TOKEN_AUTH_NOT_ADVERTISED");
    }
    await this.call("authenticate", {
      methodId: "cached_token",
      meta: { headless: true },
    }, 30_000);
  }

  request(method, params, timeoutMs = 90_000) {
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
      this.child.stdin.write(bytes);
    });
    promise.catch(() => {});
    return promise;
  }

  writeResponse(frame) {
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
    this.child.stdin.write(bytes);
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
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
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

  async close() {
    if (!this.child || this.childCloseObserved) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    await Promise.race([
      this.childClosed,
      sleep(750),
    ]);
    if (!this.childCloseObserved && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await Promise.race([this.childClosed, sleep(2_000)]);
    }
    if (!this.childCloseObserved && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([this.childClosed, sleep(2_000)]);
    }
    if (!this.childCloseObserved) {
      await Promise.race([this.childClosed, sleep(2_000)]);
    }
    if (!this.childCloseObserved) {
      throw new CaptureError("ACP_CHILD_DID_NOT_EXIT");
    }
  }
}

async function startTui({ binary, socketPath, cwd, sessionId, env }) {
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
  const command = `stty rows 40 cols 140; exec ${argv.map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd,
    env: { ...env, TERM: "xterm-256color", COLUMNS: "140", LINES: "40" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childCloseObserved = false;
  const childClosed = new Promise((resolveClose) => {
    child.once("close", () => {
      childCloseObserved = true;
      resolveClose();
    });
  });
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
  await waitFor(
    () => output.length >= 120 || child.exitCode !== null || child.signalCode !== null,
    15_000,
    "TUI_INITIAL_FRAME_TIMEOUT",
  );
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new CaptureError("TUI_EXITED_DURING_STARTUP");
  }
  await sleep(3_500);
  return {
    child,
    submit(prompt) {
      const bytes = Buffer.from(`${prompt}\r`);
      ptyWrites += 1;
      ptyWriteBytes += bytes.length;
      child.stdin.write(bytes);
    },
    containsVisible(value) {
      return terminal.text().includes(value) || visibleText(output).includes(value);
    },
    alive() {
      return child.exitCode === null && child.signalCode === null;
    },
    counters() {
      return { ptyWrites, ptyWriteBytes };
    },
    outputSha256() {
      return createHash("sha256").update(output).digest("hex");
    },
    async close() {
      if (childCloseObserved) return;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([childClosed, sleep(2_000)]);
      if (!childCloseObserved && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([childClosed, sleep(2_000)]);
      }
      if (!childCloseObserved) {
        await Promise.race([childClosed, sleep(2_000)]);
      }
      if (!childCloseObserved) {
        throw new CaptureError("TUI_CHILD_DID_NOT_EXIT");
      }
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
      if (leader.exitCode !== null || leader.signalCode !== null) {
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
    await acp.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    });
    tui = await startTui({
      binary,
      socketPath: tuiGatewayPath,
      cwd,
      sessionId,
      env,
    });
    await waitFor(() => tuiGateway.accepted() === 1, 10_000, "TUI_GATEWAY_NOT_CONNECTED");
    await waitFor(() => tuiTap.accepted() === 1, 10_000, "TUI_LEADER_TAP_NOT_CONNECTED");
    if (fatal) throw fatal;

    await Promise.all([tuiGateway.flush(), tuiTap.flush()]);
    const rejectionTapBefore = tuiTap.metrics();
    admission.rejectEnabled = true;
    const rejectedStartedAt = Date.now();
    tui.submit(`Reply exactly ${REJECTED_MARKER}.`);
    await waitFor(
      () => admission.busyResponseSent || fatal,
      10_000,
      "TUI_BUSY_RESPONSE_TIMEOUT",
    );
    if (fatal) throw fatal;
    await tuiGateway.flush();
    if (!admission.rejected || !admission.originalIdPreserved || !admission.busyResponseSent) {
      throw new CaptureError("TUI_STRUCTURED_BUSY_REJECTION_NOT_PROVEN");
    }
    progress.rejectionProven = true;
    if (admission.rejectedPromptUpstreamFrames !== 0
      || admission.rejectedPromptUpstreamBytes !== 0) {
      throw new CaptureError("REJECTED_TUI_PROMPT_REACHED_LEADER");
    }
    await sleep(2_000);
    await Promise.all([tuiGateway.flush(), tuiTap.flush()]);
    const rejectionTapAfter = tuiTap.metrics();
    const rejectionTapDelta = {
      frames: rejectionTapAfter.gatewayIngressCompleteFrames
        - rejectionTapBefore.gatewayIngressCompleteFrames,
      bytes: rejectionTapAfter.gatewayIngressBytes - rejectionTapBefore.gatewayIngressBytes,
    };
    if (rejectionTapDelta.frames !== 0 || rejectionTapDelta.bytes !== 0) {
      throw new CaptureError("LEADER_TAP_REJECTION_WINDOW_DELTA_NONZERO");
    }
    admission.rejectEnabled = false;
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
    tui.submit(RECOVERY_PROMPT);
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
    await Promise.all([
      tuiGateway.flush(), acpGateway.flush(), tuiTap.flush(), acpTap.flush(),
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
    await Promise.all([tui.close(), acp.close()]);
    tui = undefined;
    acp = undefined;

    const closedTuiGateway = tuiGateway;
    const closedAcpGateway = acpGateway;
    const closedTuiTap = tuiTap;
    const closedAcpTap = acpTap;
    let previousTransportSnapshot;
    let stableTransportRounds = 0;
    for (let attempt = 0; attempt < 20 && stableTransportRounds < 2; attempt += 1) {
      await Promise.all([closedTuiGateway.flush(), closedAcpGateway.flush()]);
      await Promise.all([closedTuiTap.flush(), closedAcpTap.flush()]);
      await Promise.all([closedTuiGateway.flush(), closedAcpGateway.flush()]);
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
    await Promise.all([closedTuiGateway.flush(), closedAcpGateway.flush()]);
    await Promise.all([closedTuiGateway.close(), closedAcpGateway.close()]);
    tuiGateway = undefined;
    acpGateway = undefined;

    await Promise.all([closedTuiTap.flush(), closedAcpTap.flush()]);
    await Promise.all([closedTuiTap.close(), closedAcpTap.close()]);
    tuiTap = undefined;
    acpTap = undefined;

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
      tuiOutputSha256,
      rawCapture: {
        storage: "RAW_OUTPUT below RAW_DIR tmpfs only",
        records: rawBytes.toString("utf8").split("\n").filter(Boolean).length,
        sha256: createHash("sha256").update(rawBytes).digest("hex"),
      },
    };
  } finally {
    await Promise.allSettled([tui?.close(), acp?.close()]);
    await Promise.allSettled([tuiGateway?.close(), acpGateway?.close()]);
    await Promise.allSettled([tuiTap?.close(), acpTap?.close()]);
    if (leader.exitCode === null && leader.signalCode === null) {
      try {
        process.kill(-leader.pid, "SIGTERM");
      } catch {
        leader.kill("SIGTERM");
      }
    }
    recorder?.close();
  }
}

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
