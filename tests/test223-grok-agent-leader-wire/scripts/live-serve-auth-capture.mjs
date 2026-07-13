import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
} from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const EXPECTED_BINARY_SHA256 = "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135";
const TMPFS_MAGIC = 0x01021994;
const rawDir = resolve(process.env.RAW_DIR || "/capture-raw");
const binary = process.env.GROK_BINARY || "/host-grok/grok";
const authPath = process.env.GROK_AUTH_PATH || "/host-grok/auth.json";
const agentIdPath = process.env.GROK_AGENT_ID_PATH || "/host-grok/agent_id";
const home = join(rawDir, "home");
const cwd = join(rawDir, "cwd");
const debugPath = join(rawDir, "serve-debug.log");
const rawCapturePath = join(rawDir, "live-serve-auth.raw.ndjson");

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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withTimeout(promise, ms, code, stage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure(code, stage)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function countTreeEntries(path) {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += countTreeEntries(join(path, entry.name));
  }
  return count;
}

function deleteRawContents() {
  if (!existsSync(rawDir)) return;
  for (const entry of readdirSync(rawDir)) rmSync(join(rawDir, entry), { recursive: true, force: true });
}

function allocateLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length >= 126) fail("EARLY_FRAME_TOO_LARGE", "build-matrix");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function parseHttpResponse(bytes) {
  const headerEnd = bytes.indexOf("\r\n\r\n");
  if (headerEnd < 0) return undefined;
  const headerText = bytes.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0]?.match(/^HTTP\/1\.[01]\s+(\d{3})\b/);
  if (!statusMatch) return undefined;
  return {
    status: Number(statusMatch[1]),
    headerNames: lines.slice(1)
      .map((line) => line.slice(0, Math.max(0, line.indexOf(":"))).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
    body: bytes.subarray(headerEnd + 4),
  };
}

async function rawUpgradeProbe({ name, port, path, headers = {}, earlyApplicationData }, recorder) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const key = randomBytes(16).toString("base64");
  const requestLines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([header, value]) => `${header}: ${value}`),
    "",
    "",
  ];
  const request = Buffer.concat([
    Buffer.from(requestLines.join("\r\n")),
    earlyApplicationData ? maskedTextFrame(earlyApplicationData) : Buffer.alloc(0),
  ]);
  recorder.record({
    role: name,
    transport: "serve-http-upgrade",
    connection: name,
    stream: "socket",
    direction: "client_to_serve",
    boundary: "write",
    bytes: request,
  });
  let response = Buffer.alloc(0);
  let parsed;
  let ended = false;
  socket.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    recorder.record({
      role: name,
      transport: "serve-http-upgrade",
      connection: name,
      stream: "socket",
      direction: "serve_to_client",
      boundary: "read",
      bytes,
    });
    response = Buffer.concat([response, bytes]);
    parsed ||= parseHttpResponse(response);
    if (parsed?.status === 101) socket.destroy();
  });
  socket.once("end", () => { ended = true; });
  socket.once("close", () => { ended = true; });
  await withTimeout(new Promise((resolveProbe, rejectProbe) => {
    socket.once("error", rejectProbe);
    socket.once("connect", () => socket.write(request));
    const poll = async () => {
      while (!parsed && !ended) await sleep(10);
      if (!parsed) rejectProbe(new ProbeFailure("NO_HTTP_RESPONSE", name));
      else resolveProbe();
    };
    void poll();
  }), 5_000, "HTTP_UPGRADE_TIMEOUT", name);
  socket.destroy();
  const bodyText = parsed.body.toString("latin1").toLowerCase();
  return {
    name,
    httpStatus: parsed.status,
    upgraded: parsed.status === 101,
    responseHeaderNames: parsed.headerNames,
    responseBodyBytes: parsed.body.length,
    responseContainedSessionData: bodyText.includes("session") || bodyText.includes("jsonrpc"),
    earlyApplicationDataSent: Boolean(earlyApplicationData),
    webSocketCloseCode: null,
    closeObservation: parsed.status === 101
      ? "client destroyed TCP after upgrade headers; no WebSocket close frame sent"
      : "HTTP response ended without a WebSocket session",
  };
}

class AcpWebSocketClient {
  constructor(name, url, recorder) {
    this.name = name;
    this.url = url;
    this.recorder = recorder;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.closeEvent = undefined;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => rejectOpen(new ProbeFailure("WS_OPEN_ERROR", this.name)), {
        once: true,
      });
    }), 5_000, "WS_OPEN_TIMEOUT", this.name);
    this.socket.addEventListener("message", (event) => { void this.onMessage(event.data); });
    this.socket.addEventListener("close", (event) => {
      this.closeEvent = { code: event.code, reasonBytes: Buffer.byteLength(event.reason || "") };
      for (const pending of this.pending.values()) pending.reject(new ProbeFailure("WS_CLOSED", this.name));
      this.pending.clear();
    });
  }

  send(payload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    this.recorder.record({
      role: this.name,
      transport: "serve-websocket-acp",
      connection: this.name,
      stream: "websocket-message",
      direction: "client_to_serve",
      boundary: "message",
      bytes,
    });
    this.socket.send(bytes.toString("utf8"));
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return withTimeout(new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest });
      this.send({ jsonrpc: "2.0", id, method, params });
    }), timeoutMs, "ACP_REQUEST_TIMEOUT", `${this.name}:${method}`);
  }

  async initializeAndAuthenticate() {
    const initialized = await this.request("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const methods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
    if (!methods.some((method) => method?.id === "cached_token")) {
      fail("CACHED_TOKEN_NOT_ADVERTISED", this.name);
    }
    await this.request("authenticate", { methodId: "cached_token", meta: { headless: true } });
  }

  async onMessage(data) {
    const bytes = typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(await data.arrayBuffer());
    this.recorder.record({
      role: this.name,
      transport: "serve-websocket-acp",
      connection: this.name,
      stream: "websocket-message",
      direction: "serve_to_client",
      boundary: "message",
      bytes,
    });
    let message;
    try {
      message = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("NON_JSON_WEBSOCKET_MESSAGE", this.name);
    }
    if (message?.method && message?.id !== undefined) {
      this.serverRequests.push(message.method);
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "probe rejects all server requests" },
      });
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new ProbeFailure("ACP_ERROR_RESPONSE", this.name));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method) {
      const update = message.params?.update;
      this.notifications.push({
        method: message.method,
        updateType: typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null,
        replay: message.params?._meta?.isReplay === true,
      });
    }
  }

  clearNotifications() {
    this.notifications = [];
  }

  async close() {
    if (!this.socket) return;
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.closeEvent ||= { code: null, reasonBytes: null, timedOut: false, alreadyClosed: true };
      return;
    }
    this.socket.close(1000, "probe complete");
    const outcome = await Promise.race([
      new Promise((resolveClose) => this.socket.addEventListener("close", () => resolveClose("closed"), {
        once: true,
      })),
      sleep(3_000).then(() => "timeout"),
    ]);
    if (outcome === "timeout" && !this.closeEvent) {
      this.closeEvent = { code: null, reasonBytes: null, timedOut: true, alreadyClosed: false };
    } else if (this.closeEvent) {
      this.closeEvent.timedOut = false;
      this.closeEvent.alreadyClosed = false;
    }
  }
}

function summarizeEvents(events) {
  const counts = new Map();
  for (const event of events) {
    const key = `${event.method}:${event.updateType || "none"}:${event.replay ? "replay" : "live"}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([shape, count]) => ({ shape, count }));
}

async function main() {
  if (!existsSync(binary) || !existsSync(authPath)) fail("MISSING_PINNED_INPUT", "preflight");
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  chmodSync(rawDir, 0o700);
  const statfs = statfsSync(rawDir);
  if (Number(statfs.type) !== TMPFS_MAGIC) fail("RAW_DIR_NOT_TMPFS", "preflight");
  if (lstatSync(rawDir).isSymbolicLink()) fail("RAW_DIR_SYMLINK", "preflight");
  deleteRawContents();
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });

  const version = await withTimeout(new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(binary, ["--version"], {
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", rejectVersion);
    child.once("exit", (code) => code === 0 ? resolveVersion(stdout.trim()) : rejectVersion(
      new ProbeFailure("VERSION_EXIT_NONZERO", "preflight"),
    ));
  }), 5_000, "VERSION_TIMEOUT", "preflight");
  if (!version.includes(EXPECTED_VERSION)) fail("VERSION_MISMATCH", "preflight");
  if (sha256File(binary) !== EXPECTED_BINARY_SHA256) fail("BINARY_HASH_MISMATCH", "preflight");

  const recorder = new ByteRecorder(rawCapturePath, "live-serve-auth", {
    generation: 1,
  });
  let serve;
  let observer;
  let submitter;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const scope = Object.keys(auth).find((key) => /^https?:\/\/.+::[^:]+$/.test(key));
    const port = await allocateLoopbackPort();
    const secret = `probe-${randomUUID()}`;
    const wrongSecret = `wrong-${randomUUID()}`;
    const childEnv = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: home,
      GROK_HOME: home,
      GROK_AUTH_PATH: authPath,
      GROK_FOLDER_TRUST: "1",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      ...(scope ? {
        GROK_OIDC_ISSUER: scope.slice(0, scope.lastIndexOf("::")),
        GROK_OIDC_CLIENT_ID: scope.slice(scope.lastIndexOf("::") + 2),
      } : {}),
    };
    if (existsSync(agentIdPath)) {
      const agentId = readFileSync(agentIdPath);
      // The isolated copy is raw auth material and remains inside tmpfs.
      const target = join(home, "agent_id");
      await import("node:fs").then(({ writeFileSync }) => writeFileSync(target, agentId, { mode: 0o600 }));
    }
    serve = spawn(binary, [
      "agent", "--no-leader", "serve",
      "--bind", `127.0.0.1:${port}`,
      "--secret", secret,
      "--debug", "--debug-file", debugPath,
    ], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let serveExited = false;
    serve.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
    serve.once("exit", () => { serveExited = true; });
    await withTimeout((async () => {
      while (!stderr.includes("WebSocket URL")) {
        if (serveExited) fail("SERVE_EXITED_DURING_START", "serve-start");
        await sleep(25);
      }
    })(), 10_000, "SERVE_START_TIMEOUT", "serve-start");

    const unauthorizedFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd, mcpServers: [] },
    });
    const matrixSpecs = [
      { name: "missing", path: "/ws", earlyApplicationData: unauthorizedFrame },
      { name: "wrong-query", path: `/ws?server-key=${encodeURIComponent(wrongSecret)}`, earlyApplicationData: unauthorizedFrame },
      { name: "correct-query", path: `/ws?server-key=${encodeURIComponent(secret)}` },
      { name: "wrong-bearer", path: "/ws", headers: { Authorization: `Bearer ${wrongSecret}` } },
      { name: "correct-bearer", path: "/ws", headers: { Authorization: `Bearer ${secret}` } },
      { name: "correct-x-server-key", path: "/ws", headers: { "X-Server-Key": secret } },
      {
        name: "correct-query-wrong-bearer",
        path: `/ws?server-key=${encodeURIComponent(secret)}`,
        headers: { Authorization: `Bearer ${wrongSecret}` },
      },
      {
        name: "wrong-query-correct-bearer",
        path: `/ws?server-key=${encodeURIComponent(wrongSecret)}`,
        headers: { Authorization: `Bearer ${secret}` },
      },
    ];
    const authMatrix = [];
    for (const spec of matrixSpecs) authMatrix.push(await rawUpgradeProbe({ ...spec, port }, recorder));
    const unauthorized = authMatrix.filter((entry) => entry.name === "missing" || entry.name === "wrong-query");
    if (unauthorized.some((entry) => entry.upgraded || entry.responseContainedSessionData)) {
      fail("UNAUTHORIZED_UPGRADE_OR_DATA", "auth-matrix");
    }
    if (unauthorized.some((entry) => !entry.earlyApplicationDataSent)) {
      fail("UNAUTHORIZED_MUTATION_FRAME_NOT_SENT", "auth-matrix");
    }
    const sessionsBeforeAuthorized = countTreeEntries(join(home, ".grok", "sessions"))
      + countTreeEntries(join(home, "sessions"));
    if (sessionsBeforeAuthorized !== 0) fail("UNAUTHORIZED_SESSION_MUTATION_AMBIGUOUS", "auth-matrix");
    if (authMatrix.find((entry) => entry.name === "correct-query")?.httpStatus !== 101) {
      fail("CORRECT_QUERY_NOT_ACCEPTED", "auth-matrix");
    }

    const url = `ws://127.0.0.1:${port}/ws?server-key=${encodeURIComponent(secret)}`;
    observer = new AcpWebSocketClient("observer", url, recorder);
    submitter = new AcpWebSocketClient("submitter", url, recorder);
    await observer.connect();
    await submitter.connect();
    await Promise.all([observer.initializeAndAuthenticate(), submitter.initializeAndAuthenticate()]);
    const created = await submitter.request("session/new", { cwd, mcpServers: [] });
    if (typeof created?.sessionId !== "string") fail("SESSION_NEW_NO_ID", "serve-acp");
    await observer.request("session/load", { sessionId: created.sessionId, cwd, mcpServers: [] });
    observer.clearNotifications();
    submitter.clearNotifications();
    const response = await submitter.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Reply with exactly SERVE_AUTH_CAPTURE_OK." }],
    }, 180_000);
    await sleep(1_500);
    const submitterCompletion = submitter.notifications.some((event) =>
      event.method === "_x.ai/session/prompt_complete");
    if (response?.stopReason !== "end_turn" || !submitterCompletion) {
      fail("AUTHORIZED_ACP_PROMPT_INCOMPLETE", "serve-acp");
    }

    await Promise.all([observer.close(), submitter.close()]);
    const summary = {
      ok: true,
      protocolFreeze: false,
      baseline: {
        version: EXPECTED_VERSION,
        binarySha256: EXPECTED_BINARY_SHA256,
      },
      transport: {
        bindScope: "loopback-only",
        websocketPath: "/ws",
        applicationFraming: "one direct JSON-RPC object per WebSocket text message",
        nativeLeaderOuterEnvelopeObserved: false,
        unixSocketObserved: false,
        unixSocketOwnerOrSymlinkCheckApplicable: false,
      },
      authMatrix,
      unauthorizedBoundary: {
        earlySessionMutationFrameSent: true,
        allUnauthorizedAttemptsRejectedBeforeUpgrade: unauthorized.every((entry) => !entry.upgraded),
        unauthorizedResponseContainedSessionData: unauthorized.some((entry) => entry.responseContainedSessionData),
        isolatedSessionArtifactsBeforeAuthorizedClient: sessionsBeforeAuthorized,
      },
      serveSemantics: {
        authorizedAcpProxyCompletedPrompt: true,
        passiveObserverReceivedCrossConnectionEvents: observer.notifications.length > 0,
        passiveObserverEventShapes: summarizeEvents(observer.notifications),
        submitterEventShapes: summarizeEvents(submitter.notifications),
        classification: observer.notifications.length > 0
          ? "ACP WebSocket proxy with observed cross-connection delivery"
          : "ACP WebSocket proxy; loaded idle connection was not a durable observer",
        nativeClientEquivalent: false,
      },
      serverRequests: {
        observer: [...new Set(observer.serverRequests)].sort(),
        submitter: [...new Set(submitter.serverRequests)].sort(),
        allRejectedByProbe: true,
      },
      close: {
        observer: observer.closeEvent || null,
        submitter: submitter.closeEvent || null,
      },
      rawCapture: {
        storage: "tmpfs-only",
        persisted: false,
      },
    };
    recorder.close();
    if (serve.exitCode === null && serve.signalCode === null) serve.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => serve.once("exit", resolveExit)), sleep(1_000)]);
    deleteRawContents();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await Promise.allSettled([observer?.close(), submitter?.close()]);
    try { recorder.close(); } catch {}
    if (serve && serve.exitCode === null && serve.signalCode === null) serve.kill("SIGTERM");
    deleteRawContents();
  }
}

main().catch((error) => {
  const sanitized = error instanceof ProbeFailure
    ? { ok: false, protocolFreeze: false, stage: error.stage, errorCode: error.code }
    : { ok: false, protocolFreeze: false, stage: "unexpected", errorCode: "UNEXPECTED_FAILURE" };
  try { deleteRawContents(); } catch {}
  process.stdout.write(`${JSON.stringify(sanitized)}\n`);
  process.exitCode = 1;
});
