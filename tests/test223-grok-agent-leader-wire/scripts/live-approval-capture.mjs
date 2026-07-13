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
import { createServer, createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const CAPTURE_NAME = "live-approval-reject-only";
const CANARY_FILE = "CAPTURE_PATH_CANARY_APPROVAL_REJECT_ONLY";
const CANARY_BODY = "CAPTURE_BODY_CANARY_APPROVAL_REJECT_ONLY";
const READY_MARKER = "CAPTURE_BODY_CANARY_APPROVAL_READY";

class ScenarioError extends Error {
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
  throw new ScenarioError(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function boundedAppend(previous, chunk, maximum = 2_000_000) {
  return Buffer.concat([previous, Buffer.from(chunk)]).subarray(-maximum);
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
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.permissionRequests = [];
    this.permissionResponses = 0;
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
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = boundedAppend(this.stderr, chunk, 32_768);
    });
    this.child.once("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new ScenarioError("ACP_PROCESS_EXITED"));
      }
      this.pending.clear();
    });
    const initialized = await this.request("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    }, 30_000);
    if (!Array.isArray(initialized?.authMethods)
      || !initialized.authMethods.some((method) => method?.id === "cached_token")) {
      throw new ScenarioError("CACHED_TOKEN_AUTH_NOT_ADVERTISED");
    }
    await this.request("authenticate", {
      methodId: "cached_token",
      meta: { headless: true },
    }, 30_000);
  }

  writeFrame(frame) {
    if (!this.child?.stdin.writable) throw new ScenarioError("ACP_STDIN_NOT_WRITABLE");
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
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new ScenarioError(`ACP_${method.replaceAll("/", "_").toUpperCase()}_TIMEOUT`));
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
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
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
        throw new ScenarioError("ACP_STDOUT_NON_JSON");
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    const at = Date.now();
    if (message?.method && message?.id !== undefined) {
      if (message.method === "session/request_permission") {
        this.permissionRequests.push({ at, message });
        // Deliberately no response. Approval ownership belongs to the real TUI
        // in this compatibility scenario.
        return;
      }
      throw new ScenarioError("UNEXPECTED_ACP_SERVER_REQUEST");
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new ScenarioError("ACP_JSONRPC_ERROR"));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method) this.notifications.push({ at, message });
  }

  compactEvents(since) {
    return this.notifications
      .filter(({ at }) => at >= since)
      .map(({ at, message }) => ({
        tMs: at - since,
        method: message.method,
        update: message?.params?.update?.sessionUpdate,
        stopReason: message?.params?.stopReason,
      }))
      .filter((event) => event.method === "_x.ai/session/prompt_complete"
        || ["pending_interaction", "interaction_resolved", "turn_completed"].includes(event.update));
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

class NativeFrameTracker {
  constructor() {
    this.buffers = new Map();
    this.frames = [];
  }

  push(direction, chunk) {
    let buffer = Buffer.concat([this.buffers.get(direction) || Buffer.alloc(0), Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > 1024 * 1024) throw new ScenarioError("NATIVE_FRAME_TOO_LARGE");
      if (buffer.length < 4 + length) break;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let outer;
      try {
        outer = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new ScenarioError("NATIVE_OUTER_NON_JSON");
      }
      let inner;
      if (outer?.type === "acp") {
        try {
          inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
        } catch {
          throw new ScenarioError("NATIVE_INNER_ACP_NON_JSON");
        }
      }
      this.frames.push({ at: Date.now(), direction, outer, inner });
    }
    this.buffers.set(direction, buffer);
  }

  permissionRequest(direction) {
    return this.frames.find((frame) => frame.direction === direction
      && frame.inner?.method === "session/request_permission"
      && frame.inner?.id !== undefined);
  }

  response(direction, id) {
    return this.frames.find((frame) => frame.direction === direction
      && frame.inner?.id === id
      && frame.inner?.method === undefined
      && (frame.inner?.result !== undefined || frame.inner?.error !== undefined));
  }
}

async function startNativeProxy({ proxyPath, leaderPath, recorder, tracker }) {
  rmSync(proxyPath, { force: true });
  const connections = [];
  let accepted = 0;
  const server = createServer((client) => {
    accepted += 1;
    if (accepted !== 1) {
      client.destroy();
      return;
    }
    const connection = "real-tui-native-1";
    const upstream = createConnection(leaderPath);
    connections.push(client, upstream);
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
      tracker.push("tui_to_leader", chunk);
      upstream.write(chunk, () => recorder.record({
        role: "native-proxy",
        transport: "leader-native-ipc",
        connection,
        stream: "leader-facing",
        direction: "gateway_to_leader",
        boundary: "write",
        bytes: chunk,
      }));
    });
    upstream.on("data", (chunk) => {
      recorder.record({
        role: "native-proxy",
        transport: "leader-native-ipc",
        connection,
        stream: "leader-facing",
        direction: "leader_to_gateway",
        boundary: "read",
        bytes: chunk,
      });
      tracker.push("leader_to_tui", chunk);
      client.write(chunk, () => recorder.record({
        role: "native-proxy",
        transport: "leader-native-ipc",
        connection,
        stream: "tui-facing",
        direction: "gateway_to_tui",
        boundary: "write",
        bytes: chunk,
      }));
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
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
    close: async () => {
      for (const connection of connections) connection.destroy();
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
  let terminalBytes = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    terminalBytes = boundedAppend(terminalBytes, chunk);
  });
  child.stderr.on("data", (chunk) => {
    terminalBytes = boundedAppend(terminalBytes, chunk);
  });
  await waitFor(
    () => terminalBytes.length >= 120 || child.exitCode !== null || child.signalCode !== null,
    15_000,
    "TUI_INITIAL_FRAME_TIMEOUT",
  );
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new ScenarioError("TUI_EXITED_BEFORE_CAPTURE");
  }
  await sleep(3_500);
  return {
    child,
    rejectCurrentApproval: async () => {
      // Escape is the only fail-closed automation used here. It never
      // confirms the currently highlighted allow choice. The native ACP
      // response below must still prove that 0.2.93 mapped it to reject_once;
      // otherwise the scenario fails without sending Enter.
      child.stdin.write("\x1b");
    },
    outputSha256: () => createHash("sha256").update(terminalBytes).digest("hex"),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        sleep(750),
      ]);
    },
  };
}

function optionOfKind(request, kind) {
  const options = request?.inner?.params?.options;
  return Array.isArray(options) ? options.find((option) => option?.kind === kind) : undefined;
}

function samePermission(left, right) {
  const a = left?.message?.params;
  const b = right?.message?.params;
  return a?.sessionId === b?.sessionId
    && a?.toolCall?.toolCallId === b?.toolCall?.toolCallId
    && a?.toolCall?.kind === "edit"
    && b?.toolCall?.kind === "edit";
}

async function main() {
  const binary = process.env.GROK_BINARY;
  const authPath = process.env.GROK_AUTH_PATH;
  const rawOutput = process.env.RAW_OUTPUT || process.argv[2];
  if (!binary) throw new ScenarioError("GROK_BINARY_REQUIRED");
  if (!authPath) throw new ScenarioError("GROK_AUTH_PATH_REQUIRED");
  if (!rawOutput) throw new ScenarioError("RAW_OUTPUT_REQUIRED");

  const root = resolve(process.env.SCENARIO_ROOT || "/tmp/test223-live-approval");
  if (!root.startsWith("/tmp/")) throw new ScenarioError("SCENARIO_ROOT_MUST_BE_TMP");
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const runtime = join(root, "runtime");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });

  const childEnv = childEnvironment(home, authPath);
  const agentId = join(dirname(authPath), "agent_id");
  if (existsSync(agentId)) symlinkSync(agentId, join(home, "agent_id"));

  const versionResult = spawnSync(binary, ["--version"], {
    env: childEnv,
    encoding: "utf8",
    timeout: 10_000,
  });
  const version = String(versionResult.stdout || "").trim();
  if (versionResult.status !== 0 || version !== EXPECTED_VERSION) {
    throw new ScenarioError("PINNED_GROK_VERSION_MISMATCH");
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
    env: childEnv,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let leaderStderr = Buffer.alloc(0);
  leader.stderr.on("data", (chunk) => {
    leaderStderr = boundedAppend(leaderStderr, chunk, 32_768);
  });

  let recorder;
  let proxy;
  let tui;
  let submitter;
  let passive;
  try {
    await waitFor(() => {
      if (leader.exitCode !== null || leader.signalCode !== null) {
        throw new ScenarioError("LEADER_EXITED_DURING_STARTUP");
      }
      if (!existsSync(leaderPath)) return false;
      const socket = lstatSync(leaderPath);
      return socket.isSocket() && !socket.isSymbolicLink();
    }, 15_000, "LEADER_SOCKET_TIMEOUT");
    if (statSync(leaderPath).uid !== process.getuid()) {
      throw new ScenarioError("LEADER_SOCKET_OWNER_MISMATCH");
    }

    recorder = new ByteRecorder(rawOutput, CAPTURE_NAME, {
      generation: 1,
      grokBuild: "0.2.93-f00f96316d",
    });
    const tracker = new NativeFrameTracker();
    proxy = await startNativeProxy({ proxyPath, leaderPath, recorder, tracker });

    submitter = new AcpClient({
      role: "submitter-acp",
      binary,
      socketPath: leaderPath,
      cwd,
      env: childEnv,
      recorder,
      connection: "submitter-acp-1",
    });
    passive = new AcpClient({
      role: "passive-acp",
      binary,
      socketPath: leaderPath,
      cwd,
      env: childEnv,
      recorder,
      connection: "passive-acp-1",
    });
    await submitter.connect();
    await passive.connect();

    const created = await submitter.request("session/new", { cwd, mcpServers: [] }, 30_000);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new ScenarioError("SESSION_NEW_NO_ID");
    }
    await submitter.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Reply exactly ${READY_MARKER}.` }],
    });
    await passive.request("session/load", { sessionId, cwd, mcpServers: [] }, 30_000);

    tui = await startTui({ binary, proxyPath, cwd, sessionId, env: childEnv });
    await waitFor(() => proxy.accepted() === 1, 10_000, "TUI_NATIVE_PROXY_NOT_CONNECTED");

    submitter.permissionRequests = [];
    passive.permissionRequests = [];
    submitter.notifications = [];
    passive.notifications = [];
    const startedAt = Date.now();
    let promptResult;
    let promptFailed = false;
    const promptPromise = submitter.request("session/prompt", {
      sessionId,
      prompt: [{
        type: "text",
        text: `Use only the file-writing tool to create ${CANARY_FILE} containing exactly ${CANARY_BODY}. Do not use a shell. After the tool decision, explain the outcome briefly.`,
      }],
    }).then((result) => {
      promptResult = result;
    }, () => {
      promptFailed = true;
    });

    const submitterPermission = await waitFor(
      () => submitter.permissionRequests[0],
      60_000,
      "SUBMITTER_PERMISSION_NOT_OBSERVED",
    );
    const passivePermission = await waitFor(
      () => passive.permissionRequests[0],
      10_000,
      "PASSIVE_PERMISSION_NOT_OBSERVED",
    );
    if (!samePermission(submitterPermission, passivePermission)) {
      throw new ScenarioError("ACP_PERMISSION_FANOUT_MISMATCH");
    }
    const nativePermission = await waitFor(
      () => tracker.permissionRequest("leader_to_tui"),
      10_000,
      "TUI_NATIVE_PERMISSION_NOT_OBSERVED",
    );
    const rejectOnce = optionOfKind(nativePermission, "reject_once");
    if (!rejectOnce?.optionId) {
      throw new ScenarioError("TUI_REJECT_ONCE_OPTION_MISSING");
    }
    if (optionOfKind(nativePermission, "allow_once")?.optionId === rejectOnce.optionId) {
      throw new ScenarioError("TUI_PERMISSION_OPTION_IDS_COLLIDE");
    }

    await tui.rejectCurrentApproval();
    const nativeResponse = await waitFor(
      () => tracker.response("tui_to_leader", nativePermission.inner.id),
      10_000,
      "TUI_REJECT_ONLY_UI_AUTOMATION_UNSTABLE",
    );
    const selectedOptionId = nativeResponse.inner?.result?.outcome?.optionId;
    const selectedOutcome = nativeResponse.inner?.result?.outcome?.outcome;
    if (selectedOutcome !== "selected" || selectedOptionId !== rejectOnce.optionId) {
      throw new ScenarioError("TUI_SELECTION_WAS_NOT_REJECT_ONCE");
    }
    if (submitter.permissionResponses !== 0 || passive.permissionResponses !== 0) {
      throw new ScenarioError("ACP_RESPONDED_TO_PERMISSION");
    }

    await Promise.race([
      promptPromise,
      sleep(180_000).then(() => { throw new ScenarioError("POST_REJECT_PROMPT_TIMEOUT"); }),
    ]);
    await sleep(1_000);
    if (promptFailed) throw new ScenarioError("POST_REJECT_PROMPT_FAILED");
    if (existsSync(join(cwd, CANARY_FILE))) {
      throw new ScenarioError("REJECTED_CANARY_WAS_CREATED");
    }
    if (submitter.permissionRequests.length !== 1 || passive.permissionRequests.length !== 1) {
      throw new ScenarioError("UNEXPECTED_PERMISSION_REQUEST_COUNT");
    }

    const interactionResolved = passive.notifications.find(({ message }) =>
      message?.method === "_x.ai/session_notification"
      && message?.params?.update?.sessionUpdate === "interaction_resolved");
    if (!interactionResolved) throw new ScenarioError("INTERACTION_RESOLVED_NOT_OBSERVED");

    const summary = {
      ok: true,
      scenario: CAPTURE_NAME,
      grokVersion: EXPECTED_VERSION,
      topology: ["submitter-acp", "passive-acp", "real-grok-tui", "shared-leader"],
      permissionFanout: {
        submitterAcp: 1,
        passiveAcp: 1,
        realTuiNative: 1,
      },
      responses: {
        submitterAcp: 0,
        passiveAcp: 0,
        realTui: "reject_once",
      },
      result: {
        canaryExists: false,
        promptStopReason: promptResult?.stopReason,
        rejectMayContinueTurn: promptResult?.stopReason === "end_turn",
      },
      timingMs: {
        submitterPermission: submitterPermission.at - startedAt,
        passivePermission: passivePermission.at - startedAt,
        tuiNativePermission: nativePermission.at - startedAt,
        tuiNativeResponse: nativeResponse.at - startedAt,
        interactionResolved: interactionResolved.at - startedAt,
      },
      eventOrder: {
        submitter: submitter.compactEvents(startedAt),
        passive: passive.compactEvents(startedAt),
      },
      tuiOutputSha256: tui.outputSha256(),
      rawStorage: "RAW_OUTPUT under RAW_DIR tmpfs only",
    };
    return summary;
  } finally {
    await Promise.allSettled([
      tui?.close(),
      submitter?.close(),
      passive?.close(),
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
  }
}

let summary;
let exitCode = 0;
try {
  summary = await main();
  const rawOutput = process.env.RAW_OUTPUT || process.argv[2];
  const rawBytes = readFileSync(rawOutput);
  summary.rawCapture = {
    records: rawBytes.toString("utf8").split("\n").filter(Boolean).length,
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
  };
} catch (error) {
  exitCode = 1;
  summary = {
    ok: false,
    scenario: CAPTURE_NAME,
    errorCode: error instanceof ScenarioError ? error.code : "UNEXPECTED_SCENARIO_FAILURE",
    safety: {
      allowResponsesSent: 0,
      forgedResponsesSent: 0,
      rawPayloadPrinted: false,
    },
  };
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = exitCode;
