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
        this.pendingCalls.delete(String(id));
        rejectRequest(new ProbeError(`ACP_${method.replaceAll("/", "_").toUpperCase()}_TIMEOUT`));
      }, timeoutMs);
      this.pendingCalls.set(String(id), {
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
      const pending = this.pendingCalls.get(String(message.id));
      if (!pending) return;
      this.pendingCalls.delete(String(message.id));
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
      const parsed = { at: Date.now(), direction, outer, inner, frame: Buffer.from(frame) };
      this.frames.push(parsed);
      parsedFrames.push(parsed);
    }
    this.buffers.set(direction, buffer);
    return parsedFrames;
  }

  permissionRequests(direction, since = 0) {
    return this.frames.filter((frame) => frame.at >= since
      && frame.direction === direction
      && frame.inner?.method === "session/request_permission"
      && frame.inner?.id !== undefined);
  }

  permissionResponses(direction, since = 0) {
    const requestIds = new Set(this.permissionRequests("leader_to_tui", since)
      .map((frame) => String(frame.inner.id)));
    return this.frames.filter((frame) => frame.at >= since
      && frame.direction === direction
      && requestIds.has(String(frame.inner?.id))
      && frame.inner?.method === undefined
      && (frame.inner?.result !== undefined || frame.inner?.error !== undefined));
  }
}

async function startNativeProxy({ proxyPath, leaderPath, recorder, tracker }) {
  const sockets = new Set();
  let accepted = 0;
  let suppressedPermissionResponses = 0;
  let forwardedPermissionResponses = 0;
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
            .map((request) => String(request.inner.id)));
          const matchesPendingPermission = parsed.inner?.method === undefined
            && parsed.inner?.id !== undefined
            && permissionRequestIds.has(String(parsed.inner.id));
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
    forwardedPermissionResponses: () => forwardedPermissionResponses,
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
  constructor(ownerRole) {
    this.ownerRole = ownerRole;
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
      ownerRequestId: ownerRequest.message.id,
      tuple,
      consumed: false,
    };
  }

  disconnectOwner() {
    this.ownerConnected = false;
  }

  offer({ sourceRole, requestId, tuple, client }) {
    if (!this.pending || !sameTuple(this.pending.tuple, tuple)
      || String(requestId) !== String(this.pending.ownerRequestId)) {
      this.counts.stale += 1;
      return "stale_suppressed";
    }
    if (sourceRole !== this.ownerRole) {
      this.counts.unauthorized += 1;
      return "unauthorized_suppressed";
    }
    if (!this.ownerConnected) {
      this.counts.ownerLost += 1;
      return "owner_lost_suppressed";
    }
    if (this.pending.consumed) {
      this.counts.duplicate += 1;
      return "duplicate_suppressed";
    }
    if (client.role !== this.ownerRole) throw new ProbeError("POLICY_OWNER_CLIENT_MISMATCH");
    this.pending.consumed = true;
    this.counts.accepted += 1;
    this.wireResponses += 1;
    client.sendPermissionResponse(
      this.pending.ownerRequest,
      this.pending.tuple.rejectOptionId,
    );
    return "reject_once_sent";
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

async function main() {
  const binary = process.env.GROK_BINARY ? resolve(process.env.GROK_BINARY) : "";
  const authPath = process.env.GROK_AUTH_PATH ? resolve(process.env.GROK_AUTH_PATH) : "";
  const rawDir = process.env.RAW_DIR ? resolve(process.env.RAW_DIR) : "";
  if (!binary) throw new ProbeError("GROK_BINARY_REQUIRED");
  if (!authPath) throw new ProbeError("GROK_AUTH_PATH_REQUIRED");
  if (!rawDir || !existsSync(rawDir)) throw new ProbeError("RAW_DIR_REQUIRED");
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
  const proxyPath = join(runtime, "tui.sock");
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
  let proxy;
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
    proxy = await startNativeProxy({ proxyPath, leaderPath, recorder, tracker });

    owner = new AcpClient({
      role: "policy-owner-acp",
      binary,
      socketPath: leaderPath,
      cwd,
      env,
      recorder,
      connection: "policy-owner-acp-1",
    });
    passive = new AcpClient({
      role: "passive-acp",
      binary,
      socketPath: leaderPath,
      cwd,
      env,
      recorder,
      connection: "passive-acp-1",
    });
    await owner.connect();
    await passive.connect();

    const created = await owner.call("session/new", { cwd, mcpServers: [] }, 30_000);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new ProbeError("SESSION_NEW_NO_ID");
    }
    await owner.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    }, 180_000);
    await passive.call("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);

    tui = await startTui({ binary, proxyPath, cwd, sessionId, env });
    await waitFor(() => proxy.accepted() === 1, 10_000, "TUI_NATIVE_PROXY_NOT_CONNECTED");

    owner.permissionRequests = [];
    passive.permissionRequests = [];
    owner.notifications = [];
    passive.notifications = [];
    const primaryStarted = Date.now();
    const primaryPrompt = owner.request("session/prompt", {
      sessionId,
      prompt: promptForCanary(PRIMARY_CANARY, PRIMARY_BODY),
    }, 180_000);

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
      () => tracker.permissionRequests("leader_to_tui", primaryStarted)[0],
      10_000,
      "TUI_PERMISSION_NOT_OBSERVED",
    );
    const primaryFanout = {
      policyOwner: owner.permissionRequests.length,
      passive: passive.permissionRequests.length,
      realTui: tracker.permissionRequests("leader_to_tui", primaryStarted).length,
    };
    const gate = new PermissionPolicyGate(owner.role);
    gate.bind(ownerRequest, [passiveRequest, nativeRequest]);
    const tuple = permissionTuple(ownerRequest);

    const pendingBeforeAttacks = gate.pending?.consumed === false;
    const unauthorizedResult = gate.offer({
      sourceRole: passive.role,
      requestId: ownerRequest.message.id,
      tuple,
      client: passive,
    });
    const pendingAfterUnauthorized = gate.pending?.consumed === false;
    const staleRequestId = typeof ownerRequest.message.id === "number"
      ? ownerRequest.message.id + 1_000_000
      : `${ownerRequest.message.id}-stale`;
    const staleResult = gate.offer({
      sourceRole: owner.role,
      requestId: staleRequestId,
      tuple,
      client: owner,
    });
    const pendingAfterStale = gate.pending?.consumed === false;
    const ownerResult = gate.offer({
      sourceRole: owner.role,
      requestId: ownerRequest.message.id,
      tuple,
      client: owner,
    });
    const duplicateResult = gate.offer({
      sourceRole: owner.role,
      requestId: ownerRequest.message.id,
      tuple,
      client: owner,
    });

    const primaryResult = await primaryPrompt;
    failureDiagnostics.primaryStopReason = typeof primaryResult?.stopReason === "string"
      ? primaryResult.stopReason
      : "missing";
    await waitFor(
      () => owner.terminalEvent(primaryStarted),
      10_000,
      "PRIMARY_TERMINAL_EVENT_NOT_OBSERVED",
    );
    await sleep(500);
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
    if (proxy.forwardedPermissionResponses() !== 0
      || tui.inputBytesWritten !== 0) {
      throw new ProbeError("TUI_RESPONDED_OR_RECEIVED_INPUT");
    }
    if (unauthorizedResult !== "unauthorized_suppressed"
      || staleResult !== "stale_suppressed"
      || ownerResult !== "reject_once_sent"
      || duplicateResult !== "duplicate_suppressed"
      || !pendingBeforeAttacks || !pendingAfterUnauthorized || !pendingAfterStale) {
      throw new ProbeError("POLICY_GATE_MATRIX_MISMATCH");
    }
    const primaryTuiResponseAttempts = tracker.permissionResponses(
      "tui_to_leader",
      primaryStarted,
    ).length;
    const primaryTuiResponsesSuppressed = proxy.suppressedPermissionResponses();

    disconnectOwner = new AcpClient({
      role: "disconnect-owner-acp",
      binary,
      socketPath: leaderPath,
      cwd,
      env,
      recorder,
      connection: "disconnect-owner-acp-1",
    });
    await disconnectOwner.connect();
    await disconnectOwner.call("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);
    disconnectOwner.permissionRequests = [];
    owner.permissionRequests = [];
    passive.permissionRequests = [];
    const disconnectStarted = Date.now();
    const disconnectPrompt = disconnectOwner.request("session/prompt", {
      sessionId,
      prompt: promptForCanary(DISCONNECT_CANARY, DISCONNECT_BODY),
    }, 180_000);
    disconnectPrompt.catch(() => {});
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
      () => tracker.permissionRequests("leader_to_tui", disconnectStarted)[0],
      10_000,
      "DISCONNECT_TUI_PERMISSION_NOT_OBSERVED",
    );
    const disconnectFanout = {
      claimedOwner: disconnectOwner.permissionRequests.length,
      passive: passive.permissionRequests.length,
      priorPolicyOwner: owner.permissionRequests.length,
      realTui: tracker.permissionRequests("leader_to_tui", disconnectStarted).length,
    };
    const disconnectGate = new PermissionPolicyGate(disconnectOwner.role);
    disconnectGate.bind(disconnectRequest, [disconnectPassiveRequest, disconnectNativeRequest]);
    const disconnectTuple = permissionTuple(disconnectRequest);
    await disconnectOwner.close();
    disconnectGate.disconnectOwner();
    const disconnectedOwnerResult = disconnectGate.offer({
      sourceRole: disconnectOwner.role,
      requestId: disconnectRequest.message.id,
      tuple: disconnectTuple,
      client: disconnectOwner,
    });
    const disconnectedPassiveResult = disconnectGate.offer({
      sourceRole: passive.role,
      requestId: disconnectRequest.message.id,
      tuple: disconnectTuple,
      client: passive,
    });
    await sleep(1_500);
    if (existsSync(join(cwd, DISCONNECT_CANARY))) {
      throw new ProbeError("DISCONNECT_CANARY_CREATED");
    }
    if (disconnectOwner.permissionResponsesSent !== 0
      || passive.permissionResponsesSent !== 0
      || disconnectGate.wireResponses !== 0
      || disconnectedOwnerResult !== "owner_lost_suppressed"
      || disconnectedPassiveResult !== "unauthorized_suppressed") {
      throw new ProbeError("OWNER_DISCONNECT_NOT_FAIL_CLOSED");
    }
    if (proxy.forwardedPermissionResponses() !== 0
      || tui.inputBytesWritten !== 0) {
      throw new ProbeError("DISCONNECT_TUI_RESPONDED_OR_RECEIVED_INPUT");
    }
    const disconnectTerminal = passive.terminalEvent(disconnectStarted);
    const disconnectOutcome = disconnectTerminal
      ? "terminal_after_owner_disconnect"
      : "pending_until_cleanup";

    const tuiInputBytesWritten = tui.inputBytesWritten;
    const passiveResponsesSent = passive.permissionResponsesSent;
    await Promise.all([
      tui.close(),
      owner.close(),
      passive.close(),
      disconnectOwner.close(),
    ]);
    const disconnectTuiResponseAttempts = tracker.permissionResponses(
      "tui_to_leader",
      disconnectStarted,
    ).length;
    const disconnectTuiResponsesSuppressed = proxy.suppressedPermissionResponses()
      - primaryTuiResponsesSuppressed;
    const forwardedPermissionResponses = proxy.forwardedPermissionResponses();
    tui = undefined;
    owner = undefined;
    passive = undefined;
    disconnectOwner = undefined;
    await proxy.close();
    proxy = undefined;
    recorder.close();
    const rawRecordCount = recorder.sequence;
    const rawCaptureSha256 = createHash("sha256")
      .update(readFileSync(rawOutput))
      .digest("hex");
    recorder = undefined;

    summary = {
      schema: "test223-approval-owner-matrix-summary/v1",
      ok: true,
      protocolFreeze: false,
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
    schema: "test223-approval-owner-matrix-summary/v1",
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
