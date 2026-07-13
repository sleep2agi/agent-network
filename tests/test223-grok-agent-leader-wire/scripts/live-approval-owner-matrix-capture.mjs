import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteRecorder } from "../lib/byte-recorder.mjs";
import { jsonRpcIdKey } from "../lib/rpc-order.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const CAPTURE = "live-approval-owner-matrix";
const READY_MARKER = "TEST223_APPROVAL_OWNER_READY";
const PRIMARY_CANARY = "TEST223_APPROVAL_OWNER_PRIMARY_CANARY";
const DISCONNECT_CANARY = "TEST223_APPROVAL_OWNER_DISCONNECT_CANARY";
const PRIMARY_BODY = "TEST223_APPROVAL_OWNER_PRIMARY_BODY";
const DISCONNECT_BODY = "TEST223_APPROVAL_OWNER_DISCONNECT_BODY";
const failureDiagnostics = {};

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function checkedRpcIdKey(id) {
  try {
    return jsonRpcIdKey(id);
  } catch {
    throw new ProbeError("UNSUPPORTED_JSON_RPC_ID");
  }
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitFor(predicate, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new ProbeError(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function bounded(previous, chunk, maximum = 32_768) {
  return Buffer.concat([previous, Buffer.from(chunk)]).subarray(-maximum);
}

function assertTmpfs(path, code) {
  const result = spawnSync("findmnt", ["-n", "-o", "FSTYPE", "--target", path], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0 || String(result.stdout).trim() !== "tmpfs") {
    throw new ProbeError(code);
  }
}

function assertContained(root, candidate, code) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new ProbeError(code);
  }
}

function childEnvironment(home, authPath) {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GROK_HOME: home,
    GROK_AUTH_PATH: authPath,
    GROK_FOLDER_TRUST: "1",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
  };
}

function permissionTuple(request) {
  const params = request?.message?.params || request?.inner?.params;
  const reject = Array.isArray(params?.options)
    ? params.options.find((option) => option?.kind === "reject_once")
    : undefined;
  if (typeof params?.sessionId !== "string"
    || typeof params?.toolCall?.toolCallId !== "string"
    || params?.toolCall?.kind !== "edit"
    || typeof reject?.optionId !== "string") {
    throw new ProbeError("PERMISSION_TUPLE_AMBIGUOUS");
  }
  return {
    sessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    toolKind: params.toolCall.kind,
    rejectOptionId: reject.optionId,
  };
}

function sameTuple(left, right) {
  return left.sessionId === right.sessionId
    && left.toolCallId === right.toolCallId
    && left.toolKind === right.toolKind
    && left.rejectOptionId === right.rejectOptionId;
}

class AcpClient {
  constructor({ role, binary, socketPath, cwd, env, recorder, connection }) {
    this.role = role;
    this.binary = binary;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.env = env;
    this.recorder = recorder;
    this.connection = connection;
    this.nextId = 1;
    this.pendingCalls = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.permissionRequests = [];
    this.permissionResponsesSent = 0;
    this.notifications = [];
    this.stderr = Buffer.alloc(0);
    this.closed = false;
  }

  async connect() {
    this.child = spawn(this.binary, [
      "agent", "--leader", "--leader-socket", this.socketPath, "stdio",
    ], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closeObserved = false;
    this.childClosed = new Promise((resolveClose) => {
      this.child.once("close", () => {
        this.closeObserved = true;
        resolveClose();
      });
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = bounded(this.stderr, chunk);
    });
    this.child.once("exit", () => {
      this.closed = true;
      for (const pending of this.pendingCalls.values()) {
        pending.reject(new ProbeError("ACP_PROCESS_EXITED"));
      }
      this.pendingCalls.clear();
    });
    const initialized = await this.call("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "test223-approval-owner-matrix", version: "1" },
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

  request(method, params, timeoutMs = 180_000) {
    const id = this.nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(checkedRpcIdKey(id));
        rejectRequest(new ProbeError(`ACP_${method.replaceAll("/", "_").toUpperCase()}_TIMEOUT`));
      }, timeoutMs);
      this.pendingCalls.set(checkedRpcIdKey(id), {
        resolve: (result) => {
          clearTimeout(timer);
          resolveRequest(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
    });
    promise.catch(() => {});
    return promise;
  }

  call(method, params, timeoutMs) {
    return this.request(method, params, timeoutMs);
  }

  sendPermissionResponse(request, optionId) {
    if (request?.message?.method !== "session/request_permission"
      || request.message.id === undefined
      || typeof optionId !== "string") {
      throw new ProbeError("INVALID_PERMISSION_RESPONSE_INPUT");
    }
    this.permissionResponsesSent += 1;
    this.writeFrame({
      jsonrpc: "2.0",
      id: request.message.id,
      result: { outcome: { outcome: "selected", optionId } },
    });
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
        throw new ProbeError("ACP_STDOUT_NON_JSON");
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    const at = Date.now();
    if (message?.method && message?.id !== undefined) {
      if (message.method !== "session/request_permission") {
        throw new ProbeError("UNEXPECTED_ACP_SERVER_REQUEST");
      }
      this.permissionRequests.push({ at, message });
      return;
    }
    if (message?.id !== undefined) {
      const responseId = checkedRpcIdKey(message.id);
      const pending = this.pendingCalls.get(responseId);
      if (!pending) return;
      this.pendingCalls.delete(responseId);
      if (message.error) pending.reject(new ProbeError("ACP_JSONRPC_ERROR"));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method) this.notifications.push({ at, message });
  }

  compactEvents(since) {
    return this.notifications
      .filter(({ at }) => at >= since)
      .map(({ message }) => {
        const update = message?.params?.update?.sessionUpdate;
        if (message.method === "_x.ai/session/prompt_complete") return "prompt_complete";
        if (["pending_interaction", "interaction_resolved", "turn_completed"].includes(update)) {
          return update;
        }
        return undefined;
      })
      .filter(Boolean);
  }

  terminalEvent(since) {
    return this.notifications.find(({ at, message }) => at >= since
      && message?.method === "_x.ai/session/prompt_complete");
  }

  async close() {
    const child = this.child;
    if (!child || this.closeObserved) return;
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await Promise.race([
      this.childClosed,
      sleep(750),
    ]);
    if (!this.closeObserved && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([this.childClosed, sleep(2_000)]);
    }
    if (!this.closeObserved && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([this.childClosed, sleep(2_000)]);
    }
    if (!this.closeObserved) await Promise.race([this.childClosed, sleep(2_000)]);
    if (!this.closeObserved) throw new ProbeError("ACP_CHILD_DID_NOT_CLOSE");
  }
}

class NativeFrameTracker {
  constructor() {
    this.buffers = new Map();
    this.frames = [];
  }

  push(direction, chunk) {
    let buffer = Buffer.concat([this.buffers.get(direction) || Buffer.alloc(0), Buffer.from(chunk)]);
    const parsedFrames = [];
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > 1024 * 1024) throw new ProbeError("NATIVE_FRAME_TOO_LARGE");
      if (buffer.length < 4 + length) break;
      const frame = buffer.subarray(0, 4 + length);
      const payload = frame.subarray(4);
      buffer = buffer.subarray(4 + length);
      let outer;
      try {
        outer = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new ProbeError("NATIVE_OUTER_NON_JSON");
      }
      let inner;
      if (outer?.type === "acp") {
        try {
          inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
        } catch {
          throw new ProbeError("NATIVE_INNER_ACP_NON_JSON");
        }
      }
      const parsed = {
        at: Date.now(),
        ordinal: this.frames.length + 1,
        direction,
        outer,
        inner,
        frame: Buffer.from(frame),
      };
      this.frames.push(parsed);
      parsedFrames.push(parsed);
    }
    this.buffers.set(direction, buffer);
    return parsedFrames;
  }

  cursor() {
    return this.frames.length;
  }

  inWindow(frame, since) {
    return since && typeof since === "object"
      ? frame.ordinal > since.afterOrdinal
      : frame.at >= since;
  }

  permissionRequests(direction, since = 0) {
    return this.frames.filter((frame) => this.inWindow(frame, since)
      && frame.direction === direction
      && frame.inner?.method === "session/request_permission"
      && frame.inner?.id !== undefined);
  }

  permissionResponses(direction, since = 0, requestDirection = "leader_to_tui") {
    return this.frames.filter((frame, index) => {
      if (!this.inWindow(frame, since)
        || frame.direction !== direction
        || frame.inner?.id === undefined
        || frame.inner?.method !== undefined
        || (frame.inner?.result === undefined && frame.inner?.error === undefined)) {
        return false;
      }
      let nearestRequest;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = this.frames[cursor];
        if (!this.inWindow(candidate, since)) break;
        if (candidate.direction === requestDirection
          && typeof candidate.inner?.method === "string"
          && candidate.inner?.id !== undefined
          && checkedRpcIdKey(candidate.inner.id) === checkedRpcIdKey(frame.inner.id)) {
          nearestRequest = candidate;
          break;
        }
      }
      return nearestRequest?.inner.method === "session/request_permission";
    });
  }

  bufferedByteCount() {
    return [...this.buffers.values()].reduce((total, buffer) => total + buffer.length, 0);
  }
}

async function startLeaderFacingTap({
  tapPath,
  leaderPath,
  recorder,
  evidenceTracker,
  tapRole = "tui-leader-facing-tap",
  connection = "tui-leader-tap-1",
}) {
  const sockets = new Set();
  const chains = [];
  const gatewayDecoder = new NativeFrameTracker();
  const leaderDecoder = new NativeFrameTracker();
  let accepted = 0;
  let fatalError;
  let activityEpoch = 0;
  let pendingWrites = 0;
  const metrics = {
    gatewayIngressFrames: 0,
    framesWrittenToLeader: 0,
    framesWrittenToGateway: 0,
  };
  const fail = (error) => {
    fatalError ||= error instanceof ProbeError
      ? error
      : new ProbeError("LEADER_FACING_TAP_FAILED");
    for (const socket of sockets) socket.destroy();
  };
  const writeFrame = (target, frame, metadata, evidenceDirection) =>
    new Promise((resolveWrite, rejectWrite) => {
      pendingWrites += 1;
      recorder.record({ ...metadata, boundary: "write", bytes: frame });
      target.write(frame, (error) => {
        pendingWrites -= 1;
        activityEpoch += 1;
        if (error) {
          rejectWrite(new ProbeError("LEADER_FACING_TAP_WRITE_FAILED"));
          return;
        }
        evidenceTracker.push(evidenceDirection, frame);
        resolveWrite();
      });
    });
  const server = createServer((gateway) => {
    accepted += 1;
    if (accepted !== 1) {
      gateway.destroy();
      fail(new ProbeError("LEADER_FACING_TAP_MULTIPLE_CLIENTS"));
      return;
    }
    const leader = createConnection(leaderPath);
    sockets.add(gateway);
    sockets.add(leader);
    let gatewayChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    chains.push(() => Promise.all([gatewayChain, leaderChain]));
    gateway.on("data", (chunk) => {
      activityEpoch += 1;
      recorder.record({
        role: tapRole,
        transport: "leader-native-ipc",
        connection,
        stream: "gateway-facing",
        direction: "gateway_to_tap",
        boundary: "read",
        bytes: chunk,
      });
      let frames;
      try {
        frames = gatewayDecoder.push("gateway_to_tap", chunk);
      } catch (error) {
        fail(error);
        return;
      }
      metrics.gatewayIngressFrames += frames.length;
      for (const parsed of frames) {
        gatewayChain = gatewayChain.then(async () => {
          await writeFrame(leader, parsed.frame, {
            role: tapRole,
            transport: "leader-native-ipc",
            connection,
            stream: "real-leader-facing",
            direction: "tap_to_real_leader",
          }, "tap_to_real_leader");
          metrics.framesWrittenToLeader += 1;
        }).catch(fail);
      }
    });
    leader.on("data", (chunk) => {
      activityEpoch += 1;
      recorder.record({
        role: "real-shared-leader",
        transport: "leader-native-ipc",
        connection,
        stream: "real-leader-facing",
        direction: "real_leader_to_tap",
        boundary: "read",
        bytes: chunk,
      });
      let frames;
      try {
        frames = leaderDecoder.push("real_leader_to_tap", chunk);
      } catch (error) {
        fail(error);
        return;
      }
      for (const parsed of frames) {
        leaderChain = leaderChain.then(async () => {
          await writeFrame(gateway, parsed.frame, {
            role: tapRole,
            transport: "leader-native-ipc",
            connection,
            stream: "gateway-facing",
            direction: "tap_to_gateway",
          }, "real_leader_to_gateway");
          metrics.framesWrittenToGateway += 1;
        }).catch(fail);
      }
    });
    gateway.on("end", () => gatewayChain.finally(() => leader.end()));
    leader.on("end", () => leaderChain.finally(() => gateway.end()));
    for (const socket of [gateway, leader]) {
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", (error) => fail(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(tapPath, () => {
      server.off("error", rejectListen);
      chmodSync(tapPath, 0o600);
      resolveListen();
    });
  });
  const flush = async ({ timeoutMs = 5_000, quietMs = 50 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const epoch = activityEpoch;
      await Promise.all(chains.map((snapshot) => snapshot()));
      if (fatalError) throw fatalError;
      await sleep(quietMs);
      await Promise.all(chains.map((snapshot) => snapshot()));
      if (fatalError) throw fatalError;
      const noPartialFrame = gatewayDecoder.bufferedByteCount() === 0
        && leaderDecoder.bufferedByteCount() === 0;
      const noBufferedWrites = [...sockets].every((socket) => socket.writableLength === 0);
      if (epoch === activityEpoch && pendingWrites === 0 && noBufferedWrites && noPartialFrame) {
        return;
      }
    }
    if (gatewayDecoder.bufferedByteCount() > 0 || leaderDecoder.bufferedByteCount() > 0) {
      throw new ProbeError("LEADER_FACING_TAP_PARTIAL_FRAME_AT_BARRIER");
    }
    throw new ProbeError("LEADER_FACING_TAP_QUIESCENCE_TIMEOUT");
  };
  return {
    accepted: () => accepted,
    metrics: () => ({ ...metrics }),
    flush,
    close: async () => {
      await flush();
      for (const socket of sockets) socket.destroy();
      await waitFor(() => sockets.size === 0, 2_000, "LEADER_FACING_TAP_CLOSE_TIMEOUT");
      await new Promise((resolveClose) => server.close(resolveClose));
      await flush();
    },
  };
}

async function startNativeProxy({ proxyPath, leaderPath, recorder, tracker }) {
  const sockets = new Set();
  let accepted = 0;
  let suppressedPermissionResponses = 0;
  const chains = [];
  const server = createServer((client) => {
    accepted += 1;
    if (accepted !== 1) {
      client.destroy();
      return;
    }
    const connection = "real-tui-native-1";
    const upstream = createConnection(leaderPath);
    sockets.add(client);
    sockets.add(upstream);
    let clientChain = Promise.resolve();
    let leaderChain = Promise.resolve();
    chains.push(() => Promise.all([clientChain, leaderChain]));
    const writeFrame = (target, frame, metadata) => new Promise((resolveWrite, rejectWrite) => {
      recorder.record({ ...metadata, boundary: "write", bytes: frame });
      target.write(frame, (error) => {
        if (error) rejectWrite(new ProbeError("NATIVE_SOCKET_WRITE_FAILED"));
        else resolveWrite();
      });
    });
    client.on("data", (chunk) => {
      recorder.record({
        role: "real-grok-tui",
        transport: "leader-native-ipc",
        connection,
        stream: "tui-facing",
        direction: "tui_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      let frames;
      try {
        frames = tracker.push("tui_to_leader", chunk);
      } catch {
        client.destroy();
        upstream.destroy();
        return;
      }
      for (const parsed of frames) {
        clientChain = clientChain.then(async () => {
          const outcome = parsed.inner?.result?.outcome;
          const permissionRequestIds = new Set(tracker.permissionRequests("leader_to_tui")
            .map((request) => checkedRpcIdKey(request.inner.id)));
          const matchesPendingPermission = parsed.inner?.method === undefined
            && parsed.inner?.id !== undefined
            && permissionRequestIds.has(checkedRpcIdKey(parsed.inner.id));
          const hasPermissionOutcomeShape = parsed.inner?.method === undefined
            && parsed.inner?.id !== undefined
            && outcome && typeof outcome === "object"
            && ["selected", "cancelled"].includes(outcome.outcome);
          if (matchesPendingPermission || hasPermissionOutcomeShape) {
            suppressedPermissionResponses += 1;
            return;
          }
          await writeFrame(upstream, parsed.frame, {
            role: "native-policy-gateway",
            transport: "leader-native-ipc",
            connection,
            stream: "leader-facing",
            direction: "gateway_to_leader",
          });
        });
      }
    });
    upstream.on("data", (chunk) => {
      recorder.record({
        role: "native-policy-gateway",
        transport: "leader-native-ipc",
        connection,
        stream: "leader-facing",
        direction: "leader_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      let frames;
      try {
        frames = tracker.push("leader_to_tui", chunk);
      } catch {
        client.destroy();
        upstream.destroy();
        return;
      }
      for (const parsed of frames) {
        leaderChain = leaderChain.then(() => writeFrame(client, parsed.frame, {
          role: "native-policy-gateway",
          transport: "leader-native-ipc",
          connection,
          stream: "tui-facing",
          direction: "gateway_to_tui",
        }));
      }
    });
    client.on("end", () => clientChain.finally(() => upstream.end()));
    upstream.on("end", () => leaderChain.finally(() => client.end()));
    for (const socket of [client, upstream]) {
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(proxyPath, () => {
      server.off("error", rejectListen);
      chmodSync(proxyPath, 0o600);
      resolveListen();
    });
  });
  return {
    accepted: () => accepted,
    suppressedPermissionResponses: () => suppressedPermissionResponses,
    close: async () => {
      await Promise.all(chains.map((snapshot) => snapshot()));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await Promise.all(chains.map((snapshot) => snapshot()));
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
  let closeObserved = false;
  const childClosed = new Promise((resolveClose) => {
    child.once("close", () => {
      closeObserved = true;
      resolveClose();
    });
  });
  let terminalBytes = 0;
  child.stdout.on("data", (chunk) => { terminalBytes += chunk.length; });
  child.stderr.on("data", (chunk) => { terminalBytes += chunk.length; });
  await waitFor(
    () => terminalBytes >= 120 || child.exitCode !== null || child.signalCode !== null,
    15_000,
    "TUI_INITIAL_FRAME_TIMEOUT",
  );
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new ProbeError("TUI_EXITED_BEFORE_CAPTURE");
  }
  await sleep(3_500);
  return {
    child,
    inputBytesWritten: 0,
    async close() {
      if (closeObserved) return;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([childClosed, sleep(2_000)]);
      if (!closeObserved && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([childClosed, sleep(2_000)]);
      }
      if (!closeObserved) await Promise.race([childClosed, sleep(2_000)]);
      if (!closeObserved) throw new ProbeError("TUI_CHILD_DID_NOT_CLOSE");
    },
  };
}

class PermissionPolicyGate {
  constructor(ownerRole, generation) {
    this.ownerRole = ownerRole;
    this.generation = generation;
    this.pending = undefined;
    this.ownerConnected = true;
    this.wireResponses = 0;
    this.counts = {
      unauthorized: 0,
      stale: 0,
      duplicate: 0,
      ownerLost: 0,
      accepted: 0,
    };
  }

  bind(ownerRequest, corroboratingRequests) {
    if (this.pending) throw new ProbeError("OVERLAPPING_PERMISSION_PENDING");
    const tuple = permissionTuple(ownerRequest);
    for (const request of corroboratingRequests) {
      if (!sameTuple(tuple, permissionTuple(request))) {
        throw new ProbeError("PERMISSION_FANOUT_TUPLE_MISMATCH");
      }
    }
    this.pending = {
      ownerRequest,
      tuple,
      consumed: false,
    };
  }

  disconnectOwner() {
    this.ownerConnected = false;
  }

  offer({ sourceRole, request, generation }) {
    let tuple;
    try {
      tuple = request ? permissionTuple(request) : undefined;
    } catch {
      tuple = undefined;
    }
    if (!this.pending || generation !== this.generation
      || !tuple || !sameTuple(this.pending.tuple, tuple)) {
      this.counts.stale += 1;
      return "suppress_stale";
    }
    if (sourceRole !== this.ownerRole) {
      this.counts.unauthorized += 1;
      return "suppress_unauthorized";
    }
    if (!this.ownerConnected) {
      this.counts.ownerLost += 1;
      return "suppress_owner_lost";
    }
    if (this.pending.consumed) {
      this.counts.duplicate += 1;
      return "suppress_duplicate";
    }
    this.pending.consumed = true;
    this.counts.accepted += 1;
    this.wireResponses += 1;
    return "forward";
  }
}

function promptForCanary(name, body) {
  return [{
    type: "text",
    text: `Use only the file-writing tool to create ${name} containing exactly ${body}. Do not use a shell. After the tool decision, explain the outcome briefly.`,
  }];
}

function assertOrdered(events) {
  const pending = events.indexOf("pending_interaction");
  const resolved = events.indexOf("interaction_resolved");
  const complete = events.lastIndexOf("prompt_complete");
  if (pending < 0 || resolved <= pending || complete <= resolved) {
    throw new ProbeError("PRIMARY_EVENT_ORDER_MISMATCH");
  }
}

function policyRefKey(ref) {
  if (!ref || typeof ref.connection !== "string"
    || !Number.isInteger(ref.permissionOrdinal) || ref.permissionOrdinal < 1) {
    throw new ProbeError("POLICY_REQUEST_REF_INVALID");
  }
  return `${ref.connection}#${ref.permissionOrdinal}`;
}

class PolicyAdmissionRouter {
  constructor(taps) {
    this.taps = taps;
    this.bindings = new Map();
  }

  bind(scenario, { generation, gate, owner, passive }) {
    if (this.bindings.has(scenario)) throw new ProbeError("POLICY_SCENARIO_ALREADY_BOUND");
    const refs = new Map([
      [policyRefKey(owner.ref), owner],
      [policyRefKey(passive.ref), passive],
    ]);
    this.bindings.set(scenario, { generation, gate, owner, passive, refs });
  }

  bindingMessage(scenario) {
    const binding = this.bindings.get(scenario);
    if (!binding) throw new ProbeError("POLICY_SCENARIO_NOT_BOUND");
    return {
      type: "bind",
      scenario,
      generation: binding.generation,
      ownerRef: binding.owner.ref,
      passiveRef: binding.passive.ref,
    };
  }

  disconnectOwner(scenario) {
    const binding = this.bindings.get(scenario);
    if (!binding) throw new ProbeError("POLICY_SCENARIO_NOT_BOUND");
    binding.gate.disconnectOwner();
  }

  responseCount() {
    return this.taps.reduce((total, { tracker }) => total + tracker.permissionResponses(
      "tap_to_real_leader",
      0,
      "real_leader_to_gateway",
    ).length, 0);
  }

  async flushTaps() {
    await Promise.all(this.taps.map(({ tap }) => tap.flush()));
  }

  async handle(sourceRole, candidate) {
    const binding = this.bindings.get(candidate.scenario);
    if (!binding) throw new ProbeError("POLICY_CANDIDATE_SCENARIO_UNBOUND");
    if (candidate.action !== "reject_once") throw new ProbeError("POLICY_ACTION_NOT_REJECT_ONCE");
    const ref = binding.refs.get(policyRefKey(candidate.requestRef));
    if (!ref || ref.sourceRole !== sourceRole) {
      throw new ProbeError("POLICY_REQUEST_REF_SOURCE_MISMATCH");
    }
    await this.flushTaps();
    const before = this.responseCount();
    const decision = binding.gate.offer({
      sourceRole,
      request: ref.request,
      generation: candidate.generation,
    });
    if (decision === "forward") {
      if (ref.client.role !== binding.gate.ownerRole) {
        throw new ProbeError("POLICY_FORWARD_TARGET_NOT_OWNER");
      }
      ref.client.sendPermissionResponse(ref.request, permissionTuple(ref.request).rejectOptionId);
      await waitFor(
        () => this.responseCount() === before + 1,
        10_000,
        "POLICY_ACCEPTED_RESPONSE_NOT_OBSERVED_AT_LEADER_TAP",
      );
    }
    await this.flushTaps();
    const after = this.responseCount();
    const leaderResponseDelta = after - before;
    if ((decision === "forward" && leaderResponseDelta !== 1)
      || (decision !== "forward" && leaderResponseDelta !== 0)) {
      throw new ProbeError("POLICY_DECISION_LEADER_TAP_DELTA_MISMATCH");
    }
    return { decision, leaderResponseDelta };
  }
}

async function startPolicyAdmissionListener({
  socketPath,
  sourceRole,
  connection,
  recorder,
  router,
  deferCandidateUntilEof = false,
  allowedScenarios = ["primary", "owner_disconnect"],
}) {
  let accepted = 0;
  let fatalError;
  const sockets = new Set();
  const chains = [];
  const rememberFatal = (error) => {
    fatalError ||= error instanceof ProbeError
      ? error
      : new ProbeError("POLICY_LISTENER_INTERNAL_ERROR");
  };
  const writeMessage = (socket, message) => new Promise((resolveWrite, rejectWrite) => {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    recorder.record({
      role: "policy-admission-gateway",
      transport: "test-policy-ipc",
      connection,
      stream: "socket",
      direction: "gateway_to_candidate",
      boundary: "write",
      bytes,
    });
    socket.write(bytes, (error) => {
      if (error) rejectWrite(new ProbeError("POLICY_DECISION_WRITE_FAILED"));
      else resolveWrite();
    });
  });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    accepted += 1;
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let scenario;
    let pendingCandidate;
    let responseComplete = false;
    let chain = Promise.resolve();
    chains.push(() => chain);
    const completeCandidate = async (candidate) => {
      const result = await router.handle(sourceRole, candidate);
      await writeMessage(socket, {
        type: "decision",
        scenario: candidate.scenario,
        generation: candidate.generation,
        requestRef: candidate.requestRef,
        decision: result.decision,
      });
      await writeMessage(socket, {
        type: "window_close",
        scenario: candidate.scenario,
        generation: candidate.generation,
        requestRef: candidate.requestRef,
        leaderResponseDelta: result.leaderResponseDelta,
      });
      responseComplete = true;
      socket.end();
    };
    const handleMessage = async (message) => {
      if (message?.type === "open") {
        if (scenario || !allowedScenarios.includes(message.scenario)) {
          throw new ProbeError("POLICY_OPEN_INVALID");
        }
        scenario = message.scenario;
        await writeMessage(socket, router.bindingMessage(scenario));
        return;
      }
      if (message?.type !== "candidate" || !scenario || message.scenario !== scenario
        || !Number.isInteger(message.generation) || message.generation < 0
        || message.action !== "reject_once") {
        throw new ProbeError("POLICY_CANDIDATE_INVALID");
      }
      policyRefKey(message.requestRef);
      if (pendingCandidate) throw new ProbeError("POLICY_MULTIPLE_CANDIDATES_PER_CONNECTION");
      if (deferCandidateUntilEof) pendingCandidate = message;
      else await completeCandidate(message);
    };
    socket.on("data", (chunk) => {
      recorder.record({
        role: "policy-candidate-driver",
        transport: "test-policy-ipc",
        connection,
        stream: "socket",
        direction: "candidate_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let newline;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        chain = chain.then(() => handleMessage(JSON.parse(line))).catch((error) => {
          rememberFatal(error);
          socket.destroy();
        });
      }
    });
    socket.on("end", () => {
      recorder.record({
        role: "policy-candidate-driver",
        transport: "test-policy-ipc",
        connection,
        stream: "socket",
        direction: "candidate_to_gateway",
        boundary: "eof",
        bytes: Buffer.alloc(0),
      });
      chain = chain.then(async () => {
        if (pendingCandidate) {
          router.disconnectOwner(pendingCandidate.scenario);
          const candidate = pendingCandidate;
          pendingCandidate = undefined;
          await completeCandidate(candidate);
        }
      }).catch((error) => {
        rememberFatal(error);
        socket.destroy();
      });
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      if (!responseComplete) {
        rememberFatal(error instanceof ProbeError
          ? error
          : new ProbeError("POLICY_LISTENER_SOCKET_ERROR"));
      }
      socket.destroy();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      chmodSync(socketPath, 0o600);
      resolveListen();
    });
  });
  const flush = async () => {
    await Promise.all(chains.map((snapshot) => snapshot()));
    if (fatalError) throw fatalError;
  };
  return {
    accepted: () => accepted,
    flush,
    close: async () => {
      await flush();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await flush();
    },
  };
}

async function runPolicyCandidate({ socketPath, scenario, generation, requestRef, halfClose = false }) {
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  const messages = [];
  let buffer = Buffer.alloc(0);
  let closed = false;
  let socketError;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      messages.push(JSON.parse(line));
    }
  });
  socket.on("error", (error) => { socketError = error; });
  socket.on("close", () => { closed = true; });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  socket.write(`${JSON.stringify({ type: "open", scenario })}\n`);
  await waitFor(
    () => messages.find((message) => message.type === "bind"),
    5_000,
    "POLICY_BIND_NOT_RECEIVED",
  );
  socket.write(`${JSON.stringify({
    type: "candidate",
    scenario,
    generation,
    requestRef,
    action: "reject_once",
  })}\n`, () => {
    if (halfClose) socket.end();
  });
  await waitFor(
    () => socketError || messages.find((message) => message.type === "window_close"),
    15_000,
    "POLICY_WINDOW_CLOSE_NOT_RECEIVED",
  );
  if (socketError && !messages.some((message) => message.type === "window_close")) {
    throw new ProbeError("POLICY_CLIENT_SOCKET_ERROR");
  }
  if (!halfClose) socket.end();
  await waitFor(() => closed, 5_000, "POLICY_CLIENT_DID_NOT_CLOSE");
  const decision = messages.find((message) => message.type === "decision");
  const windowClose = messages.find((message) => message.type === "window_close");
  if (!decision || !windowClose) throw new ProbeError("POLICY_DECISION_INCOMPLETE");
  return { bind: messages.find((message) => message.type === "bind"), decision, windowClose };
}

async function main() {
  const binary = process.env.GROK_BINARY ? resolve(process.env.GROK_BINARY) : "";
  const authPath = process.env.GROK_AUTH_PATH ? resolve(process.env.GROK_AUTH_PATH) : "";
  const rawDir = process.env.RAW_DIR ? resolve(process.env.RAW_DIR) : "";
  if (!binary) throw new ProbeError("GROK_BINARY_REQUIRED");
  if (!authPath) throw new ProbeError("GROK_AUTH_PATH_REQUIRED");
  if (!rawDir || !existsSync(rawDir)) throw new ProbeError("RAW_DIR_REQUIRED");
  const captureIdleMs = process.env.TEST223_CAPTURE_IDLE_MS === undefined
    ? 0
    : Number(process.env.TEST223_CAPTURE_IDLE_MS);
  if (!Number.isSafeInteger(captureIdleMs) || captureIdleMs < 0 || captureIdleMs > 60_000) {
    throw new ProbeError("CAPTURE_IDLE_MS_INVALID");
  }
  assertTmpfs(rawDir, "RAW_DIR_NOT_TMPFS");
  if ((statSync(rawDir).mode & 0o777) !== 0o700) throw new ProbeError("RAW_DIR_MODE_NOT_0700");

  const scenarioRoot = mkdtempSync(join(rawDir, "test223-approval-owner-"));
  chmodSync(scenarioRoot, 0o700);
  assertContained(rawDir, scenarioRoot, "SCENARIO_ROOT_ESCAPES_TMPFS");
  const home = join(scenarioRoot, "home");
  const cwd = join(scenarioRoot, "cwd");
  const runtime = join(scenarioRoot, "runtime");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const rawOutput = process.env.RAW_OUTPUT
    ? resolve(process.env.RAW_OUTPUT)
    : join(scenarioRoot, "wire.raw.ndjson");
  assertContained(rawDir, rawOutput, "RAW_OUTPUT_ESCAPES_TMPFS");

  const env = childEnvironment(home, authPath);
  const agentId = join(dirname(authPath), "agent_id");
  if (existsSync(agentId)) symlinkSync(agentId, join(home, "agent_id"));
  const version = spawnSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (version.status !== 0 || String(version.stdout || "").trim() !== EXPECTED_VERSION) {
    throw new ProbeError("PINNED_GROK_VERSION_MISMATCH");
  }
  const pinnedBinarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const scriptSha256 = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  const childEnvKeyNames = [...new Set([
    ...Object.keys(env),
    "TERM", "COLUMNS", "LINES",
  ])].sort();

  const leaderPath = join(runtime, "leader.sock");
  const tapPath = join(runtime, "tui-tap.sock");
  const ownerTapPath = join(runtime, "owner-acp-tap.sock");
  const passiveTapPath = join(runtime, "passive-acp-tap.sock");
  const disconnectOwnerTapPath = join(runtime, "disconnect-owner-acp-tap.sock");
  const proxyPath = join(runtime, "tui.sock");
  const policyOwnerPath = join(runtime, "policy-owner.sock");
  const policyPassivePath = join(runtime, "policy-passive.sock");
  const policyDisconnectOwnerPath = join(runtime, "policy-disconnect-owner.sock");
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
  leader.stderr.resume();

  let recorder;
  let tap;
  let ownerTap;
  let passiveTap;
  let disconnectOwnerTap;
  let proxy;
  let policyOwnerListener;
  let policyPassiveListener;
  let policyDisconnectOwnerListener;
  let tui;
  let owner;
  let passive;
  let disconnectOwner;
  let summary;
  try {
    await waitFor(() => {
      if (leader.exitCode !== null || leader.signalCode !== null) {
        throw new ProbeError("LEADER_EXITED_DURING_STARTUP");
      }
      if (!existsSync(leaderPath)) return false;
      const socket = lstatSync(leaderPath);
      return socket.isSocket() && !socket.isSymbolicLink();
    }, 15_000, "LEADER_SOCKET_TIMEOUT");
    if (statSync(leaderPath).uid !== process.getuid()) {
      throw new ProbeError("LEADER_SOCKET_OWNER_MISMATCH");
    }

    recorder = new ByteRecorder(rawOutput, CAPTURE, {
      grokBuild: "0.2.93-f00f96316d",
      protocolFreeze: false,
    });
    const tracker = new NativeFrameTracker();
    const leaderFacingEvidence = new NativeFrameTracker();
    const ownerLeaderEvidence = new NativeFrameTracker();
    const passiveLeaderEvidence = new NativeFrameTracker();
    const disconnectOwnerLeaderEvidence = new NativeFrameTracker();
    tap = await startLeaderFacingTap({
      tapPath,
      leaderPath,
      recorder,
      evidenceTracker: leaderFacingEvidence,
    });
    ownerTap = await startLeaderFacingTap({
      tapPath: ownerTapPath,
      leaderPath,
      recorder,
      evidenceTracker: ownerLeaderEvidence,
      tapRole: "acp-leader-facing-tap",
      connection: "owner-acp-leader-tap-1",
    });
    passiveTap = await startLeaderFacingTap({
      tapPath: passiveTapPath,
      leaderPath,
      recorder,
      evidenceTracker: passiveLeaderEvidence,
      tapRole: "acp-leader-facing-tap",
      connection: "passive-acp-leader-tap-1",
    });
    disconnectOwnerTap = await startLeaderFacingTap({
      tapPath: disconnectOwnerTapPath,
      leaderPath,
      recorder,
      evidenceTracker: disconnectOwnerLeaderEvidence,
      tapRole: "acp-leader-facing-tap",
      connection: "disconnect-owner-acp-leader-tap-1",
    });
    proxy = await startNativeProxy({ proxyPath, leaderPath: tapPath, recorder, tracker });

    const admissionRouter = new PolicyAdmissionRouter([
      { tap, tracker: leaderFacingEvidence },
      { tap: ownerTap, tracker: ownerLeaderEvidence },
      { tap: passiveTap, tracker: passiveLeaderEvidence },
      { tap: disconnectOwnerTap, tracker: disconnectOwnerLeaderEvidence },
    ]);
    policyOwnerListener = await startPolicyAdmissionListener({
      socketPath: policyOwnerPath,
      sourceRole: "policy-owner-acp",
      connection: "policy-owner-control-1",
      recorder,
      router: admissionRouter,
      allowedScenarios: ["primary"],
    });
    policyPassiveListener = await startPolicyAdmissionListener({
      socketPath: policyPassivePath,
      sourceRole: "passive-acp",
      connection: "passive-control-1",
      recorder,
      router: admissionRouter,
      allowedScenarios: ["primary", "owner_disconnect"],
    });
    policyDisconnectOwnerListener = await startPolicyAdmissionListener({
      socketPath: policyDisconnectOwnerPath,
      sourceRole: "disconnect-owner-acp",
      connection: "disconnect-owner-control-1",
      recorder,
      router: admissionRouter,
      deferCandidateUntilEof: true,
      allowedScenarios: ["owner_disconnect"],
    });

    owner = new AcpClient({
      role: "policy-owner-acp",
      binary,
      socketPath: ownerTapPath,
      cwd,
      env,
      recorder,
      connection: "policy-owner-acp-1",
    });
    passive = new AcpClient({
      role: "passive-acp",
      binary,
      socketPath: passiveTapPath,
      cwd,
      env,
      recorder,
      connection: "passive-acp-1",
    });
    await owner.connect();
    await passive.connect();
    await waitFor(() => ownerTap.accepted() === 1, 10_000, "OWNER_ACP_TAP_NOT_CONNECTED");
    await waitFor(() => passiveTap.accepted() === 1, 10_000, "PASSIVE_ACP_TAP_NOT_CONNECTED");

    failureDiagnostics.stage = "session-new";
    const created = await owner.call("session/new", { cwd, mcpServers: [] }, 30_000);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new ProbeError("SESSION_NEW_NO_ID");
    }
    failureDiagnostics.stage = "ready-prompt";
    await owner.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    }, 180_000);
    await passive.call("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);

    tui = await startTui({ binary, proxyPath, cwd, sessionId, env });
    await waitFor(() => proxy.accepted() === 1, 10_000, "TUI_NATIVE_PROXY_NOT_CONNECTED");
    await waitFor(() => tap.accepted() === 1, 10_000, "LEADER_FACING_TAP_NOT_CONNECTED");

    owner.permissionRequests = [];
    passive.permissionRequests = [];
    owner.notifications = [];
    passive.notifications = [];
    failureDiagnostics.stage = "primary-prompt-submit";
    const primaryTuiCursor = { afterOrdinal: tracker.cursor() };
    const primaryLeaderCursor = { afterOrdinal: leaderFacingEvidence.cursor() };
    const primaryStarted = Date.now();
    const primaryPrompt = owner.request("session/prompt", {
      sessionId,
      prompt: promptForCanary(PRIMARY_CANARY, PRIMARY_BODY),
    }, 180_000);

    failureDiagnostics.stage = "primary-permission-fanout";
    const ownerRequest = await waitFor(
      () => owner.permissionRequests[0],
      60_000,
      "OWNER_PERMISSION_NOT_OBSERVED",
    );
    const passiveRequest = await waitFor(
      () => passive.permissionRequests[0],
      10_000,
      "PASSIVE_PERMISSION_NOT_OBSERVED",
    );
    const nativeRequest = await waitFor(
      () => tracker.permissionRequests("leader_to_tui", primaryTuiCursor)[0],
      10_000,
      "TUI_PERMISSION_NOT_OBSERVED",
    );
    await tap.flush();
    const primaryTapBefore = {
      framesToLeader: leaderFacingEvidence.frames.filter((frame) =>
        frame.ordinal > primaryLeaderCursor.afterOrdinal
          && frame.direction === "tap_to_real_leader").length,
      matchingPermissionResponsesToLeader: leaderFacingEvidence.permissionResponses(
        "tap_to_real_leader",
        primaryLeaderCursor,
        "real_leader_to_gateway",
      ).length,
    };
    if (primaryTapBefore.matchingPermissionResponsesToLeader !== 0) {
      throw new ProbeError("PRIMARY_TAP_RESPONSE_PRESENT_BEFORE_POLICY_DECISION");
    }
    const primaryFanout = {
      policyOwner: owner.permissionRequests.length,
      passive: passive.permissionRequests.length,
      realTui: tracker.permissionRequests("leader_to_tui", primaryTuiCursor).length,
    };
    const gate = new PermissionPolicyGate(owner.role, 2);
    gate.bind(ownerRequest, [passiveRequest, nativeRequest]);
    const pendingBeforeAttacks = gate.pending?.consumed === false;
    const primaryOwnerRef = { connection: "policy-owner-acp-1", permissionOrdinal: 1 };
    const primaryPassiveRef = { connection: "passive-acp-1", permissionOrdinal: 1 };
    admissionRouter.bind("primary", {
      generation: 2,
      gate,
      owner: {
        ref: primaryOwnerRef,
        request: ownerRequest,
        client: owner,
        sourceRole: owner.role,
      },
      passive: {
        ref: primaryPassiveRef,
        request: passiveRequest,
        client: passive,
        sourceRole: passive.role,
      },
    });
    failureDiagnostics.stage = "primary-policy-unauthorized";
    const unauthorizedWindow = await runPolicyCandidate({
      socketPath: policyPassivePath,
      scenario: "primary",
      generation: 2,
      requestRef: primaryPassiveRef,
    });
    const unauthorizedResult = unauthorizedWindow.decision.decision;
    const pendingAfterUnauthorized = gate.pending?.consumed === false;
    failureDiagnostics.stage = "primary-policy-stale";
    const staleWindow = await runPolicyCandidate({
      socketPath: policyOwnerPath,
      scenario: "primary",
      generation: 1,
      requestRef: primaryOwnerRef,
    });
    const staleResult = staleWindow.decision.decision;
    const pendingAfterStale = gate.pending?.consumed === false;
    failureDiagnostics.stage = "primary-policy-owner";
    const ownerWindow = await runPolicyCandidate({
      socketPath: policyOwnerPath,
      scenario: "primary",
      generation: 2,
      requestRef: primaryOwnerRef,
    });
    const ownerResult = ownerWindow.decision.decision;
    failureDiagnostics.stage = "primary-policy-duplicate";
    const duplicateWindow = await runPolicyCandidate({
      socketPath: policyOwnerPath,
      scenario: "primary",
      generation: 2,
      requestRef: primaryOwnerRef,
    });
    const duplicateResult = duplicateWindow.decision.decision;

    failureDiagnostics.stage = "primary-result";
    const primaryResult = await primaryPrompt;
    failureDiagnostics.primaryStopReason = typeof primaryResult?.stopReason === "string"
      ? primaryResult.stopReason
      : "missing";
    failureDiagnostics.stage = "primary-terminal-event";
    await waitFor(
      () => owner.terminalEvent(primaryStarted),
      10_000,
      "PRIMARY_TERMINAL_EVENT_NOT_OBSERVED",
    );
    await sleep(500);
    failureDiagnostics.stage = "primary-event-order";
    const primaryEvents = owner.compactEvents(primaryStarted);
    assertOrdered(primaryEvents);
    if (primaryResult?.stopReason !== "cancelled") {
      throw new ProbeError("PRIMARY_STOP_REASON_NOT_CANCELLED");
    }
    if (existsSync(join(cwd, PRIMARY_CANARY))) {
      throw new ProbeError("PRIMARY_CANARY_CREATED");
    }
    if (owner.permissionResponsesSent !== 1 || passive.permissionResponsesSent !== 0
      || gate.wireResponses !== 1) {
      throw new ProbeError("CENTRAL_RESPONSE_COUNT_MISMATCH");
    }
    if (tui.inputBytesWritten !== 0) {
      throw new ProbeError("TUI_RESPONDED_OR_RECEIVED_INPUT");
    }
    if (unauthorizedResult !== "suppress_unauthorized"
      || staleResult !== "suppress_stale"
      || ownerResult !== "forward"
      || duplicateResult !== "suppress_duplicate"
      || !pendingBeforeAttacks || !pendingAfterUnauthorized || !pendingAfterStale) {
      throw new ProbeError("POLICY_GATE_MATRIX_MISMATCH");
    }
    failureDiagnostics.stage = "primary-tui-response-count";
    const primaryTuiResponseAttempts = tracker.permissionResponses(
      "tui_to_leader",
      primaryTuiCursor,
    ).length;
    const primaryTuiResponsesSuppressed = proxy.suppressedPermissionResponses();
    failureDiagnostics.stage = "primary-tap-quiesce";
    await tap.flush();
    failureDiagnostics.stage = "primary-tap-after-snapshot";
    const primaryTapAfter = {
      framesToLeader: leaderFacingEvidence.frames.filter((frame) =>
        frame.ordinal > primaryLeaderCursor.afterOrdinal
          && frame.direction === "tap_to_real_leader").length,
      matchingPermissionResponsesToLeader: leaderFacingEvidence.permissionResponses(
        "tap_to_real_leader",
        primaryLeaderCursor,
        "real_leader_to_gateway",
      ).length,
    };
    const primaryTapDelta = {
      framesToLeader: primaryTapAfter.framesToLeader - primaryTapBefore.framesToLeader,
      matchingPermissionResponsesToLeader:
        primaryTapAfter.matchingPermissionResponsesToLeader
        - primaryTapBefore.matchingPermissionResponsesToLeader,
    };
    if (primaryTapAfter.matchingPermissionResponsesToLeader !== 0
      || primaryTapDelta.matchingPermissionResponsesToLeader !== 0) {
      throw new ProbeError("PRIMARY_PERMISSION_RESPONSE_REACHED_LEADER_FACING_TAP");
    }

    failureDiagnostics.stage = "disconnect-owner-connect";
    disconnectOwner = new AcpClient({
      role: "disconnect-owner-acp",
      binary,
      socketPath: disconnectOwnerTapPath,
      cwd,
      env,
      recorder,
      connection: "disconnect-owner-acp-1",
    });
    await disconnectOwner.connect();
    await waitFor(
      () => disconnectOwnerTap.accepted() === 1,
      10_000,
      "DISCONNECT_OWNER_ACP_TAP_NOT_CONNECTED",
    );
    await disconnectOwner.call("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);
    disconnectOwner.permissionRequests = [];
    owner.permissionRequests = [];
    passive.permissionRequests = [];
    failureDiagnostics.stage = "disconnect-prompt-submit";
    const disconnectTuiCursor = { afterOrdinal: tracker.cursor() };
    const disconnectLeaderCursor = { afterOrdinal: leaderFacingEvidence.cursor() };
    const disconnectStarted = Date.now();
    const disconnectPrompt = disconnectOwner.request("session/prompt", {
      sessionId,
      prompt: promptForCanary(DISCONNECT_CANARY, DISCONNECT_BODY),
    }, 180_000);
    disconnectPrompt.catch(() => {});
    failureDiagnostics.stage = "disconnect-permission-fanout";
    const disconnectRequest = await waitFor(
      () => disconnectOwner.permissionRequests[0],
      60_000,
      "DISCONNECT_OWNER_PERMISSION_NOT_OBSERVED",
    );
    const disconnectPassiveRequest = await waitFor(
      () => passive.permissionRequests[0],
      10_000,
      "DISCONNECT_PASSIVE_PERMISSION_NOT_OBSERVED",
    );
    const disconnectNativeRequest = await waitFor(
      () => tracker.permissionRequests("leader_to_tui", disconnectTuiCursor)[0],
      10_000,
      "DISCONNECT_TUI_PERMISSION_NOT_OBSERVED",
    );
    await tap.flush();
    const disconnectTapBefore = {
      framesToLeader: leaderFacingEvidence.frames.filter((frame) =>
        frame.ordinal > disconnectLeaderCursor.afterOrdinal
          && frame.direction === "tap_to_real_leader").length,
      matchingPermissionResponsesToLeader: leaderFacingEvidence.permissionResponses(
        "tap_to_real_leader",
        disconnectLeaderCursor,
        "real_leader_to_gateway",
      ).length,
    };
    if (disconnectTapBefore.matchingPermissionResponsesToLeader !== 0) {
      throw new ProbeError("DISCONNECT_TAP_RESPONSE_PRESENT_BEFORE_OWNER_LOSS");
    }
    const disconnectFanout = {
      claimedOwner: disconnectOwner.permissionRequests.length,
      passive: passive.permissionRequests.length,
      priorPolicyOwner: owner.permissionRequests.length,
      realTui: tracker.permissionRequests("leader_to_tui", disconnectTuiCursor).length,
    };
    const disconnectGate = new PermissionPolicyGate(disconnectOwner.role, 3);
    disconnectGate.bind(disconnectRequest, [disconnectPassiveRequest, disconnectNativeRequest]);
    const disconnectOwnerRef = {
      connection: "disconnect-owner-acp-1",
      permissionOrdinal: 1,
    };
    const disconnectPassiveRef = { connection: "passive-acp-1", permissionOrdinal: 2 };
    admissionRouter.bind("owner_disconnect", {
      generation: 3,
      gate: disconnectGate,
      owner: {
        ref: disconnectOwnerRef,
        request: disconnectRequest,
        client: disconnectOwner,
        sourceRole: disconnectOwner.role,
      },
      passive: {
        ref: disconnectPassiveRef,
        request: disconnectPassiveRequest,
        client: passive,
        sourceRole: passive.role,
      },
    });
    failureDiagnostics.stage = "disconnect-policy-owner-loss";
    const disconnectedOwnerWindow = await runPolicyCandidate({
      socketPath: policyDisconnectOwnerPath,
      scenario: "owner_disconnect",
      generation: 3,
      requestRef: disconnectOwnerRef,
      halfClose: true,
    });
    const disconnectedOwnerResult = disconnectedOwnerWindow.decision.decision;
    failureDiagnostics.stage = "disconnect-policy-passive";
    let disconnectedPassiveWindow;
    try {
      disconnectedPassiveWindow = await runPolicyCandidate({
        socketPath: policyPassivePath,
        scenario: "owner_disconnect",
        generation: 3,
        requestRef: disconnectPassiveRef,
      });
    } catch (error) {
      // Surface the gateway-side cause when the client only observes a reset.
      await policyPassiveListener.flush();
      throw error;
    }
    failureDiagnostics.stage = "disconnect-policy-result";
    const disconnectedPassiveResult = disconnectedPassiveWindow.decision.decision;
    failureDiagnostics.stage = "disconnect-owner-close";
    await disconnectOwner.close();
    await sleep(1_500);
    if (existsSync(join(cwd, DISCONNECT_CANARY))) {
      throw new ProbeError("DISCONNECT_CANARY_CREATED");
    }
    if (disconnectOwner.permissionResponsesSent !== 0
      || passive.permissionResponsesSent !== 0
      || disconnectGate.wireResponses !== 0
      || disconnectedOwnerResult !== "suppress_owner_lost"
      || disconnectedPassiveResult !== "suppress_unauthorized") {
      throw new ProbeError("OWNER_DISCONNECT_NOT_FAIL_CLOSED");
    }
    if (tui.inputBytesWritten !== 0) {
      throw new ProbeError("DISCONNECT_TUI_RESPONDED_OR_RECEIVED_INPUT");
    }
    const disconnectTerminal = passive.terminalEvent(disconnectStarted);
    const disconnectOutcome = disconnectTerminal
      ? "terminal_after_owner_disconnect"
      : "pending_until_cleanup";

    failureDiagnostics.stage = "capture-idle";
    if (captureIdleMs > 0) await sleep(captureIdleMs);

    const tuiInputBytesWritten = tui.inputBytesWritten;
    const passiveResponsesSent = passive.permissionResponsesSent;
    let totalTuiResponsesSuppressed;
    failureDiagnostics.stage = "clients-close";
    await Promise.all([
      tui.close(),
      owner.close(),
      passive.close(),
      disconnectOwner.close(),
    ]);
    failureDiagnostics.stage = "policy-listeners-close";
    await Promise.all([
      policyOwnerListener.close(),
      policyPassiveListener.close(),
      policyDisconnectOwnerListener.close(),
    ]);
    policyOwnerListener = undefined;
    policyPassiveListener = undefined;
    policyDisconnectOwnerListener = undefined;
    failureDiagnostics.stage = "native-proxy-close";
    await proxy.close();
    totalTuiResponsesSuppressed = proxy.suppressedPermissionResponses();
    proxy = undefined;
    failureDiagnostics.stage = "leader-taps-close";
    await Promise.all([
      tap.close(),
      ownerTap.close(),
      passiveTap.close(),
      disconnectOwnerTap.close(),
    ]);
    // All four Leader-facing tap servers are now closed and their recorded
    // frame chains are quiescent. Derive final evidence only after this
    // barrier so a late frame cannot escape the summary snapshot.
    failureDiagnostics.stage = "final-evidence";
    const disconnectTuiResponseAttempts = tracker.permissionResponses(
      "tui_to_leader",
      disconnectTuiCursor,
    ).length;
    const disconnectTuiResponsesSuppressed = totalTuiResponsesSuppressed
      - primaryTuiResponsesSuppressed;
    const forwardedPermissionResponses = leaderFacingEvidence.permissionResponses(
      "tap_to_real_leader",
      0,
      "real_leader_to_gateway",
    ).length;
    const disconnectTapAfter = {
      framesToLeader: leaderFacingEvidence.frames.filter((frame) =>
        frame.ordinal > disconnectLeaderCursor.afterOrdinal
          && frame.direction === "tap_to_real_leader").length,
      matchingPermissionResponsesToLeader: leaderFacingEvidence.permissionResponses(
        "tap_to_real_leader",
        disconnectLeaderCursor,
        "real_leader_to_gateway",
      ).length,
    };
    const disconnectTapDelta = {
      framesToLeader: disconnectTapAfter.framesToLeader - disconnectTapBefore.framesToLeader,
      matchingPermissionResponsesToLeader:
        disconnectTapAfter.matchingPermissionResponsesToLeader
        - disconnectTapBefore.matchingPermissionResponsesToLeader,
    };
    if (disconnectTapAfter.matchingPermissionResponsesToLeader !== 0
      || disconnectTapDelta.matchingPermissionResponsesToLeader !== 0) {
      throw new ProbeError("OWNER_LOSS_PERMISSION_RESPONSE_REACHED_LEADER_FACING_TAP");
    }
    tui = undefined;
    owner = undefined;
    passive = undefined;
    disconnectOwner = undefined;
    const tapMetrics = {
      tui: tap.metrics(),
      owner: ownerTap.metrics(),
      passive: passiveTap.metrics(),
      disconnectOwner: disconnectOwnerTap.metrics(),
    };
    const tapAcceptedConnections = {
      tui: tap.accepted(),
      owner: ownerTap.accepted(),
      passive: passiveTap.accepted(),
      disconnectOwner: disconnectOwnerTap.accepted(),
    };
    if (Object.values(tapAcceptedConnections).some((count) => count !== 1)) {
      throw new ProbeError("INDEPENDENT_TAP_ADMISSION_COUNT_MISMATCH");
    }
    tap = undefined;
    ownerTap = undefined;
    passiveTap = undefined;
    disconnectOwnerTap = undefined;
    recorder.close();
    const rawRecordCount = recorder.sequence;
    const rawCaptureSha256 = createHash("sha256")
      .update(readFileSync(rawOutput))
      .digest("hex");
    recorder = undefined;

    summary = {
      schema: "test223-approval-owner-matrix-summary/v2",
      ok: true,
      protocolFreeze: false,
      captureIdleMs,
      grokVersion: "0.2.93-f00f96316d",
      pinnedBinarySha256,
      scriptSha256,
      childEnvKeyNames,
      fanout: { primary: primaryFanout, ownerDisconnect: disconnectFanout },
      primary: {
        exactTupleMatchedAcrossAllClients: true,
        rejectKind: "reject_once",
        centralResponsesSent: gate.wireResponses,
        passiveResponsesSent,
        realTuiResponseAttempts: primaryTuiResponseAttempts,
        realTuiResponsesSuppressed: primaryTuiResponsesSuppressed,
        realTuiResponsesForwarded: forwardedPermissionResponses,
        unauthorizedCandidate: unauthorizedResult,
        staleCandidate: staleResult,
        ownerCandidate: ownerResult,
        duplicateCandidate: duplicateResult,
        pendingSurvivedUnauthorized: pendingBeforeAttacks && pendingAfterUnauthorized,
        pendingSurvivedStale: pendingAfterStale,
        canaryAbsent: true,
        terminalOutcome: primaryResult.stopReason,
        eventOrder: primaryEvents,
      },
      ownerDisconnect: {
        exactTupleMatchedAcrossAllClients: true,
        ownerCandidateAfterDisconnect: disconnectedOwnerResult,
        passiveCandidateAfterDisconnect: disconnectedPassiveResult,
        centralResponsesSent: disconnectGate.wireResponses,
        realTuiResponseAttempts: disconnectTuiResponseAttempts,
        realTuiResponsesSuppressed: disconnectTuiResponsesSuppressed,
        realTuiResponsesForwarded: forwardedPermissionResponses,
        canaryAbsent: true,
        terminalOutcome: disconnectOutcome,
      },
      admissionWindows: [
        unauthorizedWindow,
        staleWindow,
        ownerWindow,
        duplicateWindow,
        disconnectedOwnerWindow,
        disconnectedPassiveWindow,
      ].map(({ decision, windowClose }) => ({ decision, windowClose })),
      independentLeaderFacingTap: {
        acceptedConnections: tapAcceptedConnections,
        primary: {
          before: primaryTapBefore,
          after: primaryTapAfter,
          delta: primaryTapDelta,
        },
        ownerDisconnect: {
          before: disconnectTapBefore,
          after: disconnectTapAfter,
          delta: disconnectTapDelta,
        },
        metrics: tapMetrics,
      },
      safety: {
        allowResponsesSent: 0,
        tuiInputBytesWritten,
        canariesCreated: 0,
        rawPrinted: false,
        rawStorage: "tmpfs-only; harness cleanup removes after sanitize/project",
      },
      rawRecordCount,
      rawCaptureSha256,
    };
  } finally {
    await Promise.allSettled([
      tui?.close(),
      owner?.close(),
      passive?.close(),
      disconnectOwner?.close(),
    ]);
    await proxy?.close().catch(() => {});
    await Promise.allSettled([
      policyOwnerListener?.close(),
      policyPassiveListener?.close(),
      policyDisconnectOwnerListener?.close(),
      tap?.close(),
      ownerTap?.close(),
      passiveTap?.close(),
      disconnectOwnerTap?.close(),
    ]);
    if (leader.exitCode === null && leader.signalCode === null) {
      try {
        process.kill(-leader.pid, "SIGTERM");
      } catch {
        leader.kill("SIGTERM");
      }
    }
    recorder?.close();
    rmSync(scenarioRoot, { recursive: true, force: true });
  }
  return summary;
}

let result;
let exitCode = 0;
try {
  result = await main();
} catch (error) {
  exitCode = 1;
  result = {
    schema: "test223-approval-owner-matrix-summary/v2",
    ok: false,
    protocolFreeze: false,
    errorCode: error instanceof ProbeError ? error.code : "UNEXPECTED_SCENARIO_FAILURE",
    diagnostics: failureDiagnostics,
    safety: {
      allowResponsesSent: 0,
      rawPrinted: false,
    },
  };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = exitCode;
