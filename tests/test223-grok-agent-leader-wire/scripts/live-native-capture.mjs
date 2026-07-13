import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, createConnection } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const binary = process.env.GROK_BINARY ? resolve(process.env.GROK_BINARY) : "";
const rawOutput = process.env.RAW_OUTPUT ? resolve(process.env.RAW_OUTPUT) : "";
const proofCwd = process.env.PROOF_CWD ? resolve(process.env.PROOF_CWD) : "";
const suppliedLeaderSocket = process.env.GROK_LEADER_SOCKET
  ? resolve(process.env.GROK_LEADER_SOCKET)
  : undefined;
const expectedVersion = "grok 0.2.93 (f00f96316d)";
const answer = "TEST223_TUI_LIVE_OK";
const networkPrompt = [
  "Reply with one string made by concatenating these fragments without spaces",
  "or punctuation: TEST223_ + TUI_ + LIVE_ + OK.",
  "Output only the concatenated result.",
].join(" ");

let stage = "configuration";
let recorder;
let ownedLeader;
let tui;
let submitter;
let runtimeDir;
let failureDiagnostics;
const proxies = [];
const childEnvKeyUnion = new Set();

function requireInput(value, name) {
  if (!value || value === "/") throw new Error(`${name} is required`);
}

function safeChildEnv(extra = {}) {
  const allowed = [
    "PATH",
    "HOME",
    "GROK_HOME",
    "GROK_AUTH_PATH",
    "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID",
    "GROK_AGENT_ID_PATH",
    "GROK_FOLDER_TRUST",
    "GROK_SANDBOX",
    "LANG",
    "LC_ALL",
    "TZ",
  ];
  const env = {};
  for (const key of allowed) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env.GROK_FOLDER_TRUST = "1";
  env.GROK_CLAUDE_MCPS_ENABLED = "false";
  env.GROK_CURSOR_MCPS_ENABLED = "false";
  env.GROK_CLAUDE_HOOKS_ENABLED = "false";
  env.GROK_CURSOR_HOOKS_ENABLED = "false";
  const childEnv = { ...env, ...extra };
  for (const key of Object.keys(childEnv)) childEnvKeyUnion.add(key);
  return childEnv;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 1_500);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function captureVersion() {
  const child = spawn(binary, ["--version"], {
    env: safeChildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_024); });
  await waitForExit(child, 10_000);
  if (child.exitCode === null && child.signalCode === null) await terminate(child);
  if (child.exitCode !== 0 || !stdout.includes(expectedVersion)) {
    throw new Error("unexpected Grok version");
  }
  return expectedVersion;
}

function assertSafeSocket(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isSocket()) throw new Error("unsafe leader socket");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("leader socket owner mismatch");
  }
}

async function waitForSocket(path, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertSafeSocket(path);
      return;
    } catch {
      if (child && child.exitCode !== null) throw new Error("leader exited before readiness");
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error("leader socket readiness timeout");
}

function recordBytes({ role, connection, stream, direction, boundary, bytes }) {
  recorder.record({
    role,
    transport: "leader-native-ipc",
    connection,
    stream,
    direction,
    boundary,
    bytes,
  });
}

function createRecordedProxy({ role, socketPath, upstreamPath }) {
  let connectionSequence = 0;
  let readCallbacks = 0;
  let writeCallbacks = 0;
  const sockets = new Set();
  const server = createServer((front) => {
    const connection = `${role}-${++connectionSequence}`;
    const upstream = createConnection(upstreamPath);
    sockets.add(front);
    sockets.add(upstream);

    const forward = (source, target, stream, readDirection, writeDirection) => {
      source.on("data", (chunk) => {
        readCallbacks += 1;
        recordBytes({
          role,
          connection,
          stream,
          direction: readDirection,
          boundary: "read",
          bytes: chunk,
        });
        writeCallbacks += 1;
        recordBytes({
          role: "native-gateway",
          connection,
          stream,
          direction: writeDirection,
          boundary: "write",
          bytes: chunk,
        });
        if (!target.write(chunk)) {
          source.pause();
          target.once("drain", () => source.resume());
        }
      });
      source.on("end", () => {
        recordBytes({
          role,
          connection,
          stream,
          direction: readDirection,
          boundary: "eof",
          bytes: Buffer.alloc(0),
        });
        target.end();
      });
    };

    forward(front, upstream, "front-socket", `${role}_to_gateway`, "gateway_to_leader");
    forward(upstream, front, "leader-socket", "leader_to_gateway", `gateway_to_${role}`);
    for (const socket of [front, upstream]) {
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
  });

  return {
    role,
    socketPath,
    get connectionCount() { return connectionSequence; },
    get readCallbacks() { return readCallbacks; },
    get writeCallbacks() { return writeCallbacks; },
    async start() {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, () => {
          server.off("error", rejectListen);
          chmodSync(socketPath, 0o600);
          resolveListen();
        });
      });
      assertSafeSocket(socketPath);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

class AcpSubmitter {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.permissionRequests = 0;
    this.stderr = "";
  }

  async connect() {
    this.child = spawn(binary, [
      "agent", "--leader", "--leader-socket", this.socketPath, "stdio",
    ], {
      cwd: proofCwd,
      env: safeChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    this.child.once("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("ACP process exited"));
      }
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.onLine(line));

    const initialized = await this.request("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "test223-live-native-capture", version: "1" },
    });
    const methods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
    if (!methods.some((method) => method?.id === "cached_token")) {
      throw new Error("cached_token unavailable");
    }
    await this.request("authenticate", {
      methodId: "cached_token",
      meta: { headless: true },
    });
  }

  request(method, params, timeoutMs = 30_000) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("ACP stdin closed"));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new Error("ACP request timeout"));
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
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      for (const pending of this.pending.values()) pending.reject(new Error("invalid ACP JSON"));
      this.pending.clear();
      return;
    }
    if (message?.method && message?.id !== undefined) {
      if (message.method === "session/request_permission") this.permissionRequests += 1;
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "capture rejects client-side requests" },
      })}\n`);
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error("ACP response error"));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method) this.notifications.push({ at: Date.now(), message });
  }

  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await waitForExit(this.child, 1_000);
    await terminate(this.child);
  }
}

function visibleText(raw) {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("capture wait timeout");
}

async function main() {
  requireInput(binary, "GROK_BINARY");
  requireInput(rawOutput, "RAW_OUTPUT");
  requireInput(proofCwd, "PROOF_CWD");
  mkdirSync(proofCwd, { recursive: true, mode: 0o700 });
  runtimeDir = mkdtempSync(join(tmpdir(), "test223-native-"));
  chmodSync(runtimeDir, 0o700);

  stage = "version";
  const version = await captureVersion();
  recorder = new ByteRecorder(rawOutput, "leader-native-tui", {
    grokVersion: version,
    scenario: "real-tui-plus-acp-submitter",
  });

  let leaderSocket = suppliedLeaderSocket;
  if (!leaderSocket) {
    stage = "leader-start";
    leaderSocket = join(runtimeDir, "leader.sock");
    ownedLeader = spawn(binary, [
      "agent", "leader",
      "--no-exit-on-disconnect",
      "--relay-on-demand",
      "--no-auto-update",
      "--leader-socket", leaderSocket,
    ], {
      detached: true,
      env: safeChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Child diagnostics stay in memory and are never persisted or printed.
    ownedLeader.stdout.resume();
    ownedLeader.stderr.resume();
    await waitForSocket(leaderSocket, ownedLeader);
  } else {
    stage = "leader-validate";
    assertSafeSocket(leaderSocket);
  }

  stage = "proxy-start";
  const acpProxy = createRecordedProxy({
    role: "acp-submitter",
    socketPath: join(runtimeDir, "acp.sock"),
    upstreamPath: leaderSocket,
  });
  const tuiProxy = createRecordedProxy({
    role: "real-tui",
    socketPath: join(runtimeDir, "tui.sock"),
    upstreamPath: leaderSocket,
  });
  proxies.push(acpProxy, tuiProxy);
  await acpProxy.start();
  await tuiProxy.start();

  stage = "acp-connect";
  submitter = new AcpSubmitter(acpProxy.socketPath);
  await submitter.connect();
  const created = await submitter.request("session/new", { cwd: proofCwd, mcpServers: [] });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length < 8) {
    throw new Error("session/new omitted session id");
  }
  await submitter.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly READY_FOR_TUI_ATTACH." }],
  }, 180_000);
  submitter.notifications = [];

  stage = "tui-attach";
  let rawTui = "";
  let tuiExit = null;
  let wroteToTuiStdin = false;
  const tuiArgs = [
    binary,
    "--leader",
    "--leader-socket", tuiProxy.socketPath,
    "--cwd", proofCwd,
    "--resume", sessionId,
    "--permission-mode", "default",
    "--no-subagents",
    "--disallowed-tools", "search_tool,use_tool",
    "--no-alt-screen",
  ];
  const tuiCommand = `stty rows 36 cols 120; exec ${tuiArgs.map(shellQuote).join(" ")}`;
  tui = spawn("script", ["-qefc", tuiCommand, "/dev/null"], {
    cwd: proofCwd,
    env: safeChildEnv({ TERM: "xterm-256color", COLUMNS: "120", LINES: "36" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const appendTui = (chunk) => {
    rawTui = `${rawTui}${chunk}`.slice(-2_000_000);
  };
  tui.stdout.setEncoding("utf8");
  tui.stderr.setEncoding("utf8");
  tui.stdout.on("data", appendTui);
  tui.stderr.on("data", appendTui);
  tui.once("exit", (code, signal) => { tuiExit = { code, signal }; });
  await waitUntil(() => rawTui.length >= 120 || tuiExit !== null, 15_000);
  if (tuiExit) throw new Error("TUI exited during attach");
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));

  stage = "network-turn";
  submitter.notifications = [];
  const startedAt = Date.now();
  const promptResult = await submitter.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: networkPrompt }],
  }, 180_000);
  const resolvedAt = Date.now();
  await waitUntil(
    () => visibleText(rawTui).includes(answer) || tuiExit !== null,
    5_000,
  );

  const answerText = submitter.notifications
    .filter(({ at, message }) => {
      const update = message?.params?.update;
      return at >= startedAt
        && message?.params?.sessionId === sessionId
        && update?.sessionUpdate === "agent_message_chunk";
    })
    .map(({ message }) => message.params.update.content?.text || "")
    .join("")
    .trim();
  const completionSeen = submitter.notifications.some(({ at, message }) =>
    at >= startedAt
    && message?.params?.sessionId === sessionId
    && (
      message?.method === "_x.ai/session/prompt_complete"
      || message?.params?.update?.sessionUpdate === "turn_completed"
    ));
  const tuiRendered = visibleText(rawTui).includes(answer);
  failureDiagnostics = {
    answerMatched: answerText === answer,
    tuiRendered,
    completionSeen,
    promptStopReason: typeof promptResult?.stopReason === "string"
      ? promptResult.stopReason
      : "missing",
    permissionRequests: submitter.permissionRequests,
    tuiExited: tuiExit !== null,
    zeroTuiStdin: wroteToTuiStdin === false,
    acpConnections: acpProxy.connectionCount,
    tuiConnections: tuiProxy.connectionCount,
  };
  const ok = answerText === answer
    && tuiRendered
    && completionSeen
    && promptResult?.stopReason === "end_turn"
    && submitter.permissionRequests === 0
    && tuiExit === null
    && wroteToTuiStdin === false
    && acpProxy.connectionCount === 1
    && tuiProxy.connectionCount === 1;
  if (!ok) throw new Error("live native gate failed");

  stage = "finalize";
  await terminate(tui);
  tui = undefined;
  await submitter.close();
  submitter = undefined;
  for (const proxy of proxies.splice(0)) await proxy.close();
  if (ownedLeader) {
    await terminate(ownedLeader);
    ownedLeader = undefined;
  }
  recorder.close();
  const rawSha256 = createHash("sha256").update(readFileSync(rawOutput)).digest("hex");
  const summary = {
    schema: "test223-live-native-summary/v1",
    ok: true,
    protocolFreeze: false,
    grokVersion: version,
    selfStartedLeader: suppliedLeaderSocket === undefined,
    sameSession: true,
    distinctNativeConnections: true,
    zeroTuiStdin: wroteToTuiStdin === false,
    answerMatched: true,
    realTuiRendered: true,
    completionSeen: true,
    permissionRequests: 0,
    promptStopReason: "end_turn",
    promptDurationMs: resolvedAt - startedAt,
    nativeConnections: 2,
    nativeReadCallbacks: acpProxy.readCallbacks + tuiProxy.readCallbacks,
    nativeWriteCallbacks: acpProxy.writeCallbacks + tuiProxy.writeCallbacks,
    rawRecordCount: recorder.sequence,
    rawCaptureSha256: rawSha256,
    childEnvKeyNames: [...childEnvKeyUnion].sort(),
    childEnvEvidence: "exact union of keys passed by safeChildEnv to spawned child processes",
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try {
  await main();
} catch {
  process.stdout.write(`${JSON.stringify({
    schema: "test223-live-native-summary/v1",
    ok: false,
    protocolFreeze: false,
    stage,
    ...(failureDiagnostics ? { diagnostics: failureDiagnostics } : {}),
  })}\n`);
  process.exitCode = 1;
} finally {
  if (tui) await terminate(tui);
  if (submitter) await submitter.close();
  for (const proxy of proxies.splice(0)) {
    try { await proxy.close(); } catch { /* best-effort cleanup */ }
  }
  if (ownedLeader) await terminate(ownedLeader);
  if (recorder) recorder.close();
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
}
