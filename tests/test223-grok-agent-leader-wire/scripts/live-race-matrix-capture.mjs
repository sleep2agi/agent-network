import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const CAPTURE = "live-race-matrix";
const REQUIRED_SAMPLES = 100;
const READY_MARKER = "CAPTURE_BODY_CANARY_RACE_MATRIX_READY";
const progress = {
  matrixA: [],
  matrixB: [],
  activeCase: undefined,
  activeAttempt: undefined,
};

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const monoNs = () => process.hrtime.bigint();
const nsToUs = (value) => Number(value / 1_000n);

async function waitFor(predicate, timeoutMs, code, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new ProbeError(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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

function percentile(values, fraction) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function distribution(values) {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : undefined,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : undefined,
  };
}

function compactAttemptHash(attempts) {
  return createHash("sha256").update(JSON.stringify(attempts)).digest("hex");
}

class ObserverAcp extends EventEmitter {
  constructor({ role, binary, leaderSocket, cwd, env, recorder, connection }) {
    super();
    this.role = role;
    this.binary = binary;
    this.leaderSocket = leaderSocket;
    this.cwd = cwd;
    this.env = env;
    this.recorder = recorder;
    this.connection = connection;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.events = [];
    this.stderr = Buffer.alloc(0);
    this.closed = false;
  }

  async connect() {
    this.child = spawn(this.binary, [
      "agent", "--leader", "--leader-socket", this.leaderSocket, "stdio",
    ], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-32_768);
    });
    this.child.once("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new ProbeError("ACP_PROCESS_EXITED"));
      }
      this.pending.clear();
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
      throw new ProbeError("CACHED_TOKEN_AUTH_NOT_ADVERTISED");
    }
    await this.call("authenticate", {
      methodId: "cached_token",
      meta: { headless: true },
    }, 30_000);
  }

  writeFrame(frame) {
    if (!this.child?.stdin.writable) throw new ProbeError("ACP_STDIN_NOT_WRITABLE");
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    this.recorder.record({
      role: this.role,
      transport: "acp-stdio",
      connection: this.connection,
      stream: "stdin",
      direction: "client_to_grok",
      boundary: "write",
      bytes,
    });
    this.child.stdin.write(bytes);
  }

  request(method, params, timeoutMs = 90_000) {
    const id = this.nextId++;
    const writtenAtNs = monoNs();
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new ProbeError("ACP_REQUEST_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
    });
    // A matrix attempt may be waiting for observer-side ordering before it
    // awaits the submitter response. Attach a handler immediately so a remote
    // timeout cannot become an unhandled rejection; the original promise is
    // still awaited and propagated by the attempt.
    promise.catch(() => {});
    return { promise, writtenAtNs };
  }

  async call(method, params, timeoutMs) {
    return this.request(method, params, timeoutMs).promise;
  }

  onStdout(chunk) {
    const bytes = Buffer.from(chunk);
    this.recorder.record({
      role: this.role,
      transport: "acp-stdio",
      connection: this.connection,
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
        this.emit("fatal", new ProbeError("ACP_STDOUT_NON_JSON"));
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message?.method && message?.id !== undefined) {
      this.emit("fatal", new ProbeError("UNEXPECTED_ACP_SERVER_REQUEST"));
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new ProbeError("ACP_JSONRPC_ERROR"));
      else pending.resolve(message.result);
      return;
    }
    if (!message?.method) return;
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const update = params.update && typeof params.update === "object" ? params.update : {};
    const text = typeof update?.content?.text === "string" ? update.content.text : "";
    const entry = {
      seq: this.events.length + 1,
      atMs: Date.now(),
      atNs: monoNs(),
      method: message.method,
      update: typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined,
      stopReason: typeof params.stopReason === "string" ? params.stopReason : undefined,
      text,
      replay: params?._meta?.isReplay === true,
    };
    this.events.push(entry);
    this.emit("event", entry);
  }

  eventIndex() {
    return this.events.length;
  }

  since(index) {
    return this.events.slice(index);
  }

  userEvent(marker, index) {
    return this.since(index).find((event) =>
      !event.replay && event.update === "user_message_chunk" && event.text.includes(marker));
  }

  completions(index) {
    return this.since(index).filter((event) =>
      !event.replay && event.method === "_x.ai/session/prompt_complete");
  }

  turnCompletions(index) {
    return this.since(index).filter((event) =>
      !event.replay
      && event.method === "_x.ai/session_notification"
      && event.update === "turn_completed");
  }

  turnStarted(index) {
    return this.since(index).filter((event) =>
      !event.replay
      && (event.update === "turn_started" || event.method === "turn_started"));
  }

  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(750),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

class NativeStructuralTracker {
  constructor() {
    this.buffers = new Map();
    this.events = [];
    this.outerTypes = new Map();
  }

  push(direction, chunk) {
    let bytes = Buffer.concat([this.buffers.get(direction) || Buffer.alloc(0), Buffer.from(chunk)]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32BE(0);
      if (length > 1024 * 1024) throw new ProbeError("NATIVE_FRAME_TOO_LARGE");
      if (bytes.length < 4 + length) break;
      const payload = bytes.subarray(4, 4 + length);
      bytes = bytes.subarray(4 + length);
      let outer;
      try {
        outer = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new ProbeError("NATIVE_OUTER_NON_JSON");
      }
      const outerType = typeof outer?.type === "string" ? outer.type : "<missing>";
      this.outerTypes.set(outerType, (this.outerTypes.get(outerType) || 0) + 1);
      let inner;
      if (outer?.type === "acp") {
        try {
          inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
        } catch {
          throw new ProbeError("NATIVE_INNER_ACP_NON_JSON");
        }
      }
      const update = inner?.params?.update;
      this.events.push({
        seq: this.events.length + 1,
        atNs: monoNs(),
        direction,
        outerType,
        method: typeof inner?.method === "string" ? inner.method : undefined,
        update: typeof update?.sessionUpdate === "string" ? update.sessionUpdate : undefined,
        stopReason: typeof inner?.params?.stopReason === "string" ? inner.params.stopReason : undefined,
      });
    }
    this.buffers.set(direction, bytes);
  }

  eventIndex() {
    return this.events.length;
  }

  turnStarted(index) {
    return this.events.slice(index).filter((event) =>
      event.outerType === "turn_started"
      || event.method === "turn_started"
      || event.update === "turn_started");
  }

  promptComplete(index) {
    return this.events.slice(index).filter((event) =>
      event.method === "_x.ai/session/prompt_complete");
  }

  outerTypeCounts() {
    return Object.fromEntries([...this.outerTypes].sort(([left], [right]) => left.localeCompare(right)));
  }
}

async function startTransparentProxy({ proxyPath, leaderPath, recorder, tracker }) {
  rmSync(proxyPath, { force: true });
  const sockets = [];
  let accepted = 0;
  let forwardedReads = 0;
  let forwardedWrites = 0;
  let fatal;
  const server = createServer((tuiSocket) => {
    accepted += 1;
    if (accepted !== 1) {
      tuiSocket.destroy();
      fatal = new ProbeError("MULTIPLE_TUI_PROXY_CLIENTS");
      return;
    }
    const leaderSocket = createConnection(leaderPath);
    sockets.push(tuiSocket, leaderSocket);
    const forward = ({ source, target, direction, sourceStream, targetStream, sourceRole }) => {
      source.on("data", (chunk) => {
        try {
          forwardedReads += 1;
          recorder.record({
            role: sourceRole,
            transport: "leader-native-ipc",
            connection: "real-tui-native-1",
            stream: sourceStream,
            direction,
            boundary: "read",
            bytes: chunk,
          });
          tracker.push(direction, chunk);
          target.write(chunk, () => {
            forwardedWrites += 1;
            recorder.record({
              role: "transparent-capture-proxy",
              transport: "leader-native-ipc",
              connection: "real-tui-native-1",
              stream: targetStream,
              direction: direction === "tui_to_leader" ? "proxy_to_leader" : "proxy_to_tui",
              boundary: "write",
              bytes: chunk,
            });
          });
        } catch (error) {
          fatal = error instanceof ProbeError ? error : new ProbeError("NATIVE_PROXY_RECORD_FAILURE");
          source.destroy();
          target.destroy();
        }
      });
    };
    forward({
      source: tuiSocket,
      target: leaderSocket,
      direction: "tui_to_leader",
      sourceStream: "tui-facing",
      targetStream: "leader-facing",
      sourceRole: "real-grok-tui",
    });
    forward({
      source: leaderSocket,
      target: tuiSocket,
      direction: "leader_to_tui",
      sourceStream: "leader-facing",
      targetStream: "tui-facing",
      sourceRole: "shared-leader",
    });
    tuiSocket.on("end", () => leaderSocket.end());
    leaderSocket.on("end", () => tuiSocket.end());
    tuiSocket.on("error", () => leaderSocket.destroy());
    leaderSocket.on("error", () => tuiSocket.destroy());
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(proxyPath, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  chmodSync(proxyPath, 0o600);
  return {
    accepted: () => accepted,
    fatal: () => fatal,
    counters: () => ({ forwardedReads, forwardedWrites }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function startTui({ binary, proxyPath, cwd, sessionId, env }) {
  const argv = [
    binary,
    "--leader", "--leader-socket", proxyPath,
    "--cwd", cwd,
    "--resume", sessionId,
    "--permission-mode", "default",
    "--no-subagents",
    "--disallowed-tools", "search_tool,use_tool",
    "--no-alt-screen",
  ];
  const command = `stty rows 40 cols 140; exec ${argv.map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd,
    env: { ...env, TERM: "xterm-256color", COLUMNS: "140", LINES: "40" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let outputBytes = Buffer.alloc(0);
  let ptyWrites = 0;
  let ptyWriteBytes = 0;
  const append = (chunk) => {
    outputBytes = Buffer.concat([outputBytes, Buffer.from(chunk)]).subarray(-2_000_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  await waitFor(
    () => outputBytes.length >= 120 || child.exitCode !== null || child.signalCode !== null,
    15_000,
    "TUI_INITIAL_FRAME_TIMEOUT",
  );
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new ProbeError("TUI_EXITED_BEFORE_MATRIX");
  }
  await sleep(3_500);
  return {
    child,
    submit(prompt) {
      const bytes = Buffer.from(`${prompt}\r`);
      const writtenAtNs = monoNs();
      ptyWrites += 1;
      ptyWriteBytes += bytes.length;
      child.stdin.write(bytes);
      return writtenAtNs;
    },
    counters: () => ({ ptyWrites, ptyWriteBytes }),
    outputSha256: () => createHash("sha256").update(outputBytes).digest("hex"),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        sleep(750),
      ]);
    },
  };
}

function startLabel(event, networkMarker, humanMarker) {
  if (event.text.includes(networkMarker)) return "network";
  if (event.text.includes(humanMarker)) return "human";
  return "unknown";
}

async function awaitAttemptEvents(observer, baseIndex, networkMarker, humanMarker, timeoutMs = 90_000) {
  await waitFor(() => observer.userEvent(networkMarker, baseIndex), timeoutMs, "NETWORK_USER_START_TIMEOUT");
  await waitFor(() => observer.userEvent(humanMarker, baseIndex), timeoutMs, "HUMAN_USER_START_TIMEOUT");
  await waitFor(() => observer.completions(baseIndex).length >= 2, timeoutMs, "TWO_PROMPT_COMPLETIONS_TIMEOUT");
  await waitFor(() => observer.turnCompletions(baseIndex).length >= 2, timeoutMs, "TWO_TURN_COMPLETIONS_TIMEOUT");
  const userEvents = observer.since(baseIndex)
    .filter((event) => event.update === "user_message_chunk"
      && (event.text.includes(networkMarker) || event.text.includes(humanMarker)))
    .map((event) => ({ event, label: startLabel(event, networkMarker, humanMarker) }));
  const uniqueStarts = [];
  for (const candidate of userEvents) {
    if (!uniqueStarts.some((entry) => entry.label === candidate.label)) uniqueStarts.push(candidate);
  }
  return {
    starts: uniqueStarts,
    completions: observer.completions(baseIndex).slice(0, 2),
    turnCompletions: observer.turnCompletions(baseIndex).slice(0, 2),
  };
}

function classifyAttempt({ attempt, mode, scheduledOrder, baseNs, ptyAtNs, acpAtNs, events, observer, observerIndex, tracker, nativeIndex }) {
  const starts = events.starts;
  const completions = events.completions;
  const turnCompletions = events.turnCompletions;
  const firstStart = starts[0];
  const secondStart = starts[1];
  const firstComplete = completions[0];
  const secondComplete = completions[1];
  const firstTurnComplete = turnCompletions[0];
  const secondTurnComplete = turnCompletions[1];
  const structurallyComplete = starts.length === 2 && completions.length === 2
    && turnCompletions.length === 2
    && firstStart?.label !== "unknown" && secondStart?.label !== "unknown";
  const secondStartedBeforeFirstPromptComplete = structurallyComplete
    ? secondStart.event.atNs < firstComplete.atNs
    : undefined;
  const secondStartedBeforeFirstTurnComplete = structurallyComplete
    ? secondStart.event.atNs < firstTurnComplete.atNs
    : undefined;
  const stopReasons = completions.map((event) => event.stopReason || "<missing>");
  const cancelled = stopReasons.some((reason) => reason !== "end_turn");
  const observerTurnStarted = observer.turnStarted(observerIndex).length;
  const nativeTurnStarted = tracker.turnStarted(nativeIndex).length;
  const nativePromptComplete = tracker.promptComplete(nativeIndex).length;
  return {
    attempt,
    mode,
    scheduledOrder,
    valid: structurallyComplete,
    writesUs: {
      ptyFromBase: nsToUs(ptyAtNs - baseNs),
      acpFromBase: nsToUs(acpAtNs - baseNs),
      acpMinusPty: nsToUs(acpAtNs - ptyAtNs),
    },
    observedStartOrder: starts.map((entry) => entry.label),
    firstStartUs: firstStart ? nsToUs(firstStart.event.atNs - baseNs) : undefined,
    secondStartUs: secondStart ? nsToUs(secondStart.event.atNs - baseNs) : undefined,
    firstCompleteUs: firstComplete ? nsToUs(firstComplete.atNs - baseNs) : undefined,
    secondCompleteUs: secondComplete ? nsToUs(secondComplete.atNs - baseNs) : undefined,
    firstTurnCompleteUs: firstTurnComplete ? nsToUs(firstTurnComplete.atNs - baseNs) : undefined,
    secondTurnCompleteUs: secondTurnComplete ? nsToUs(secondTurnComplete.atNs - baseNs) : undefined,
    stopReasons,
    secondStartedBeforeFirstPromptComplete,
    secondStartedBeforeFirstTurnComplete,
    implicitSteerOrCancelObserved: secondStartedBeforeFirstTurnComplete === true || cancelled,
    signals: {
      observerTurnStarted,
      nativeTurnStarted,
      nativePromptComplete,
      observerPromptComplete: completions.length,
    },
  };
}

async function runSameWindowAttempt({ attempt, sessionId, submitter, observer, tui, tracker }) {
  const networkMarker = `CAPTURE_BODY_CANARY_RACE_A_NETWORK_${String(attempt).padStart(3, "0")}`;
  const humanMarker = `CAPTURE_BODY_CANARY_RACE_A_HUMAN_${String(attempt).padStart(3, "0")}`;
  const observerIndex = observer.eventIndex();
  const nativeIndex = tracker.eventIndex();
  const baseNs = monoNs();
  const scheduledOrder = attempt % 2 === 0 ? "human_then_acp" : "acp_then_human";
  let ptyAtNs;
  let request;
  if (scheduledOrder === "human_then_acp") {
    ptyAtNs = tui.submit(`Reply exactly ${humanMarker}.`);
    request = submitter.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${networkMarker}.` }],
    });
  } else {
    request = submitter.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${networkMarker}.` }],
    });
    ptyAtNs = tui.submit(`Reply exactly ${humanMarker}.`);
  }
  const events = await awaitAttemptEvents(observer, observerIndex, networkMarker, humanMarker);
  await request.promise;
  await sleep(25);
  return classifyAttempt({
    attempt,
    mode: "same_admission_window",
    scheduledOrder,
    baseNs,
    ptyAtNs,
    acpAtNs: request.writtenAtNs,
    events,
    observer,
    observerIndex,
    tracker,
    nativeIndex,
  });
}

async function runHumanActiveAttempt({ attempt, sessionId, submitter, observer, tui, tracker }) {
  const networkMarker = `CAPTURE_BODY_CANARY_RACE_B_NETWORK_${String(attempt).padStart(3, "0")}`;
  const humanMarker = `CAPTURE_BODY_CANARY_RACE_B_HUMAN_${String(attempt).padStart(3, "0")}`;
  const observerIndex = observer.eventIndex();
  const nativeIndex = tracker.eventIndex();
  const baseNs = monoNs();
  const ptyAtNs = tui.submit(`Reply exactly ${humanMarker}.`);
  await waitFor(() => observer.userEvent(humanMarker, observerIndex), 90_000, "ACTIVE_HUMAN_USER_START_TIMEOUT", 1);
  if (observer.completions(observerIndex).length !== 0) {
    throw new ProbeError("HUMAN_TURN_COMPLETED_BEFORE_NETWORK_ADMISSION");
  }
  const request = submitter.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: `Reply exactly ${networkMarker}.` }],
  });
  const events = await awaitAttemptEvents(observer, observerIndex, networkMarker, humanMarker);
  await request.promise;
  await sleep(25);
  const classified = classifyAttempt({
    attempt,
    mode: "network_arrives_during_human_turn",
    scheduledOrder: "human_start_observed_then_acp",
    baseNs,
    ptyAtNs,
    acpAtNs: request.writtenAtNs,
    events,
    observer,
    observerIndex,
    tracker,
    nativeIndex,
  });
  classified.networkWriteWhileHumanActive = classified.firstCompleteUs !== undefined
    && classified.firstTurnCompleteUs !== undefined
    && classified.writesUs.acpFromBase < classified.firstTurnCompleteUs;
  classified.valid = classified.valid
    && classified.observedStartOrder[0] === "human"
    && classified.networkWriteWhileHumanActive;
  return classified;
}

function matrixSummary(attempts) {
  const valid = attempts.filter((attempt) => attempt.valid);
  const implicit = attempts.filter((attempt) => attempt.implicitSteerOrCancelObserved);
  const startOrders = {};
  for (const attempt of attempts) {
    const key = attempt.observedStartOrder.join("_then_") || "<missing>";
    startOrders[key] = (startOrders[key] || 0) + 1;
  }
  return {
    attempted: attempts.length,
    valid: valid.length,
    ambiguous: attempts.length - valid.length,
    implicitSteerOrCancel: implicit.length,
    observedStartOrders: startOrders,
    acpMinusPtyUs: distribution(attempts.map((attempt) => attempt.writesUs.acpMinusPty)),
    firstCompletionUs: distribution(attempts.map((attempt) => attempt.firstCompleteUs).filter(Number.isFinite)),
    observerTurnStartedSignals: attempts.reduce((sum, attempt) => sum + attempt.signals.observerTurnStarted, 0),
    nativeTurnStartedSignals: attempts.reduce((sum, attempt) => sum + attempt.signals.nativeTurnStarted, 0),
    nativePromptCompleteSignals: attempts.reduce((sum, attempt) => sum + attempt.signals.nativePromptComplete, 0),
    attemptsSha256: compactAttemptHash(attempts),
    attempts,
  };
}

async function main() {
  const binary = process.env.GROK_BINARY;
  const authPath = process.env.GROK_AUTH_PATH;
  const rawOutput = process.env.RAW_OUTPUT || process.argv[2];
  const repetitions = Number(process.env.MATRIX_REPETITIONS || REQUIRED_SAMPLES);
  if (!binary) throw new ProbeError("GROK_BINARY_REQUIRED");
  if (!authPath) throw new ProbeError("GROK_AUTH_PATH_REQUIRED");
  if (!rawOutput) throw new ProbeError("RAW_OUTPUT_REQUIRED");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > REQUIRED_SAMPLES) {
    throw new ProbeError("MATRIX_REPETITIONS_INVALID");
  }

  const root = resolve(process.env.SCENARIO_ROOT || "/tmp/test223-live-race-matrix");
  if (!root.startsWith("/tmp/")) throw new ProbeError("SCENARIO_ROOT_MUST_BE_TMP");
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
    throw new ProbeError("PINNED_GROK_VERSION_MISMATCH");
  }

  const leaderPath = join(runtime, "leader.sock");
  const proxyPath = join(runtime, "tui-proxy.sock");
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
  let proxy;
  let tui;
  let submitter;
  let observer;
  let fatal;
  const sameWindow = progress.matrixA;
  const humanActive = progress.matrixB;
  try {
    await waitFor(() => {
      if (leader.exitCode !== null || leader.signalCode !== null) {
        throw new ProbeError("LEADER_EXITED_DURING_STARTUP");
      }
      if (!existsSync(leaderPath)) return false;
      const entry = lstatSync(leaderPath);
      return entry.isSocket() && !entry.isSymbolicLink();
    }, 15_000, "LEADER_SOCKET_TIMEOUT");
    if (statSync(leaderPath).uid !== process.getuid()) {
      throw new ProbeError("LEADER_SOCKET_OWNER_MISMATCH");
    }

    recorder = new ByteRecorder(rawOutput, CAPTURE, {
      generation: 1,
      grokBuild: "0.2.93-f00f96316d",
    });
    const tracker = new NativeStructuralTracker();
    proxy = await startTransparentProxy({ proxyPath, leaderPath, recorder, tracker });
    submitter = new ObserverAcp({
      role: "network-submitter-acp",
      binary,
      leaderSocket: leaderPath,
      cwd,
      env,
      recorder,
      connection: "network-submitter-acp-1",
    });
    observer = new ObserverAcp({
      role: "passive-observer-acp",
      binary,
      leaderSocket: leaderPath,
      cwd,
      env,
      recorder,
      connection: "passive-observer-acp-1",
    });
    const onFatal = (error) => { fatal = error; };
    submitter.on("fatal", onFatal);
    observer.on("fatal", onFatal);
    await submitter.connect();
    await observer.connect();
    const created = await submitter.call("session/new", { cwd, mcpServers: [] }, 30_000);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new ProbeError("SESSION_NEW_NO_ID");
    await submitter.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    });
    await observer.call("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);
    tui = await startTui({ binary, proxyPath, cwd, sessionId, env });
    await waitFor(() => proxy.accepted() === 1, 10_000, "TUI_NATIVE_PROXY_NOT_CONNECTED");

    for (let attempt = 1; attempt <= repetitions; attempt += 1) {
      progress.activeCase = "A";
      progress.activeAttempt = attempt;
      if (fatal) throw fatal;
      if (proxy.fatal()) throw proxy.fatal();
      sameWindow.push(await runSameWindowAttempt({
        attempt, sessionId, submitter, observer, tui, tracker,
      }));
      await sleep(500);
    }
    for (let attempt = 1; attempt <= repetitions; attempt += 1) {
      progress.activeCase = "B";
      progress.activeAttempt = attempt;
      if (fatal) throw fatal;
      if (proxy.fatal()) throw proxy.fatal();
      humanActive.push(await runHumanActiveAttempt({
        attempt, sessionId, submitter, observer, tui, tracker,
      }));
      await sleep(500);
    }
    progress.activeCase = undefined;
    progress.activeAttempt = undefined;

    const matrixA = matrixSummary(sameWindow);
    const matrixB = matrixSummary(humanActive);
    const pty = tui.counters();
    const expectedPtyWrites = repetitions * 2;
    const complete = repetitions === REQUIRED_SAMPLES
      && matrixA.valid === REQUIRED_SAMPLES
      && matrixB.valid === REQUIRED_SAMPLES
      && pty.ptyWrites === expectedPtyWrites;
    const rawBytes = readFileSync(rawOutput);
    return {
      ok: complete,
      errorCode: complete ? undefined : "MATRIX_FEWER_THAN_100_VALID_SAMPLES",
      scenario: CAPTURE,
      scope: "bare shared Leader with transparent byte-capture proxy; no gateway policy exercised",
      protocolFreeze: false,
      grokVersion: EXPECTED_VERSION,
      requiredValidSamplesPerCase: REQUIRED_SAMPLES,
      configuredRepetitions: repetitions,
      captureProxy: {
        admissionDecisions: 0,
        promptBuffering: 0,
        forwarding: "immediate transparent duplex",
        ...proxy.counters(),
      },
      gatewayAdmissionBehavior: "not exercised; deliberately separate from bare-Leader result",
      ptyInput: {
        mechanism: "real TUI PTY stdin",
        tmuxOrSendKeysUsed: false,
        writes: pty.ptyWrites,
        expectedWrites: expectedPtyWrites,
        bytes: pty.ptyWriteBytes,
      },
      nativeOuterTypeCounts: tracker.outerTypeCounts(),
      matrixA,
      matrixB,
      tuiOutputSha256: tui.outputSha256(),
      rawCapture: {
        storage: "RAW_OUTPUT below RAW_DIR tmpfs only",
        records: rawBytes.toString("utf8").split("\n").filter(Boolean).length,
        sha256: createHash("sha256").update(rawBytes).digest("hex"),
      },
    };
  } finally {
    await Promise.allSettled([tui?.close(), submitter?.close(), observer?.close()]);
    await proxy?.close().catch(() => {});
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
  if (!summary.ok) exitCode = 1;
} catch (error) {
  exitCode = 1;
  summary = {
    ok: false,
    scenario: CAPTURE,
    protocolFreeze: false,
    errorCode: error instanceof ProbeError ? error.code : "UNEXPECTED_MATRIX_FAILURE",
    completedSamples: {
      matrixA: progress.matrixA.length,
      matrixB: progress.matrixB.length,
      activeCase: progress.activeCase,
      activeAttempt: progress.activeAttempt,
      matrixAAttemptsSha256: compactAttemptHash(progress.matrixA),
      matrixBAttemptsSha256: compactAttemptHash(progress.matrixB),
    },
    safety: {
      rawPayloadPrinted: false,
      tmuxOrSendKeysUsed: false,
      gatewayPolicyClaimed: false,
    },
  };
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = exitCode;
