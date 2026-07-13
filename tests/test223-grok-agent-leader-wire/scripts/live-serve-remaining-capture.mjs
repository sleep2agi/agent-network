import { fork, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import net from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteRecorder } from "../lib/byte-recorder.mjs";

const EXPECTED_VERSION = "grok 0.2.93 (f00f96316d)";
const EXPECTED_BINARY_SHA256 = "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135";
const TMPFS_MAGIC = 0x01021994;
const CLOSE_TIMEOUT_MS = 3_000;
const FIRST_PROMPT = [
  "Produce one line containing the word alpha repeated exactly 240 times, separated by single spaces,",
  "then append the token SERVE_REMAINING_FIRST_DONE. Do not call tools.",
].join(" ");
const SECOND_PROMPT = "Reply with exactly SERVE_REMAINING_SECOND_DONE. Do not call tools.";
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

function maskClientFrame(opcode, payloadInput) {
  const payload = Buffer.from(payloadInput);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    fail("RAW_WS_FRAME_TOO_LARGE", "http-matrix");
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function parseHttpResponse(bytes) {
  const headerEnd = bytes.indexOf("\r\n\r\n");
  if (headerEnd < 0) return undefined;
  const lines = bytes.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const match = lines[0]?.match(/^HTTP\/1\.[01]\s+(\d{3})\b/);
  if (!match) return undefined;
  return {
    status: Number(match[1]),
    headerEnd,
    headerNames: lines.slice(1)
      .map((line) => line.slice(0, Math.max(0, line.indexOf(":"))).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
  };
}

async function rawUpgradeProbe({ name, port, path, secret, credential, origin, earlyFrame }, recorder) {
  const key = randomBytes(16).toString("base64");
  const headers = [];
  if (origin !== undefined) headers.push(`Origin: ${origin}`);
  let requestPath = path;
  if (credential === "correct-query") requestPath += `?server-key=${encodeURIComponent(secret)}`;
  if (credential === "wrong-query") requestPath += `?server-key=${encodeURIComponent(`wrong-${secret}`)}`;
  if (credential === "correct-bearer") headers.push(`Authorization: Bearer ${secret}`);
  if (credential === "wrong-bearer") headers.push(`Authorization: Bearer wrong-${secret}`);
  const requestHead = Buffer.from([
    `GET ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...headers,
    "",
    "",
  ].join("\r\n"));
  const request = Buffer.concat([
    requestHead,
    earlyFrame ? maskClientFrame(0x1, Buffer.from(earlyFrame)) : Buffer.alloc(0),
  ]);
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let response = Buffer.alloc(0);
  let parsed;
  let ended = false;
  recorder.record({
    role: name,
    transport: "serve-http-upgrade",
    connection: name,
    stream: "socket",
    direction: "client_to_serve",
    boundary: "write",
    bytes: request,
  });
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
  await sleep(75);
  socket.destroy();
  const body = response.subarray((parsed?.headerEnd ?? response.length) + 4);
  const lower = body.toString("latin1").toLowerCase();
  return {
    name,
    path,
    credential,
    originCase: origin === undefined ? "absent" : origin === "null" ? "null" : name.replace(/^origin-/, ""),
    httpStatus: parsed.status,
    upgraded: parsed.status === 101,
    responseHeaderNames: parsed.headerNames,
    responseBodyBytes: body.length,
    responseContainedSessionData: lower.includes("session") || lower.includes("jsonrpc"),
    earlyApplicationFrameSent: Boolean(earlyFrame),
  };
}

function listSessionEntries(home) {
  const roots = [join(home, ".grok", "sessions"), join(home, "sessions")];
  const entries = [];
  const visit = (root, path, prefix) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(path, entry.name);
      entries.push(`${basename(root)}:${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "o"}:${relative}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(root, target, relative);
    }
  };
  roots.forEach((root) => visit(root, root, ""));
  return entries.sort();
}

function sessionSnapshot(home) {
  const entries = listSessionEntries(home);
  return {
    count: entries.length,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

function classifyErrorMessage(message) {
  const text = typeof message === "string" ? message : "";
  if (/auth/i.test(text)) return "authentication-required";
  if (/method/i.test(text)) return "method-related";
  if (/session/i.test(text)) return "session-related";
  return text ? "other-redacted" : "absent";
}

class WsAcpClient {
  constructor({ name, url, recorder, onNotification }) {
    this.name = name;
    this.url = url;
    this.recorder = recorder;
    this.onNotificationCallback = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.closeEvent = undefined;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => { void this.onMessage(event.data); });
    this.socket.addEventListener("close", (event) => {
      this.closeEvent = {
        code: event.code,
        reasonBytes: Buffer.byteLength(event.reason || ""),
        wasClean: event.wasClean,
      };
      for (const pending of this.pending.values()) pending.resolve({
        ok: false,
        transportClosed: true,
        errorCode: null,
        errorMessageClass: "transport-closed",
      });
      this.pending.clear();
    });
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => rejectOpen(new ProbeFailure("WS_OPEN_ERROR", this.name)), {
        once: true,
      });
    }), 5_000, "WS_OPEN_TIMEOUT", this.name);
  }

  record(direction, bytes) {
    this.recorder?.record({
      role: this.name,
      transport: "serve-websocket-acp",
      connection: this.name,
      stream: "websocket-message",
      direction,
      boundary: "message",
      bytes,
    });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) fail("WS_NOT_OPEN", this.name);
    const bytes = Buffer.from(JSON.stringify(message));
    this.record("client_to_serve", bytes);
    this.socket.send(bytes.toString("utf8"));
  }

  call(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        resolveCall({
          ok: false,
          timedOut: true,
          errorCode: null,
          errorMessageClass: "timeout",
        });
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (response) => {
          clearTimeout(timer);
          resolveCall(response);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async requireCall(method, params, timeoutMs = 30_000) {
    const response = await this.call(method, params, timeoutMs);
    if (!response.ok) fail(`ACP_${method.replaceAll("/", "_").toUpperCase()}_FAILED`, this.name);
    return response.result;
  }

  async initialize() {
    return this.requireCall("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  async authenticateCached() {
    return this.requireCall("authenticate", {
      methodId: "cached_token",
      meta: { headless: true },
    });
  }

  async initializeAndAuthenticate() {
    const initialized = await this.initialize();
    await this.authenticateCached();
    return initialized;
  }

  async onMessage(data) {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(await data.arrayBuffer());
    this.record("serve_to_client", bytes);
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
        error: { code: -32000, message: "Phase0 probe rejects all server requests" },
      });
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.resolve({
          ok: false,
          timedOut: false,
          errorCode: typeof message.error.code === "number" ? message.error.code : null,
          errorMessageClass: classifyErrorMessage(message.error.message),
          errorDataShape: message.error.data && typeof message.error.data === "object"
            ? Object.keys(message.error.data).sort()
            : [],
        });
      } else {
        pending.resolve({ ok: true, result: message.result });
      }
      return;
    }
    if (message?.method) {
      const update = message.params?.update;
      const event = {
        at: Date.now(),
        method: message.method,
        updateType: typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null,
        replay: message.params?._meta?.isReplay === true,
      };
      this.notifications.push(event);
      this.onNotificationCallback?.(event);
    }
  }

  async waitForNotification(predicate, timeoutMs, code) {
    const existing = this.notifications.find(predicate);
    if (existing) return existing;
    return withTimeout(new Promise((resolveEvent) => {
      const previous = this.onNotificationCallback;
      this.onNotificationCallback = (event) => {
        previous?.(event);
        if (predicate(event)) resolveEvent(event);
      };
    }), timeoutMs, code, this.name);
  }

  async close(requestedCode = 1000, timeoutMs = CLOSE_TIMEOUT_MS) {
    if (!this.socket) return { requestedCode, observedCode: null, timedOut: false, alreadyClosed: true };
    if (this.socket.readyState === WebSocket.CLOSED) {
      return {
        requestedCode,
        observedCode: this.closeEvent?.code ?? null,
        timedOut: false,
        alreadyClosed: true,
      };
    }
    this.socket.close(requestedCode);
    const outcome = await Promise.race([
      new Promise((resolveClose) => this.socket.addEventListener("close", () => resolveClose("closed"), {
        once: true,
      })),
      sleep(timeoutMs).then(() => "timeout"),
    ]);
    return {
      requestedCode,
      observedCode: this.closeEvent?.code ?? null,
      observedReasonBytes: this.closeEvent?.reasonBytes ?? null,
      wasClean: this.closeEvent?.wasClean ?? null,
      timedOut: outcome === "timeout",
      timeoutMs,
      alreadyClosed: false,
    };
  }
}

function notificationShapes(events) {
  const counts = new Map();
  for (const event of events) {
    const shape = `${event.method}:${event.updateType || "none"}:${event.replay ? "replay" : "live"}`;
    counts.set(shape, (counts.get(shape) || 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([shape, count]) => ({ shape, count }));
}

function isTurnEvent(event) {
  if (event.method === "_x.ai/session/prompt_complete") return true;
  if (event.method === "_x.ai/session_notification" && event.updateType === "turn_completed") return true;
  return event.method === "session/update"
    && typeof event.updateType === "string"
    && /^(?:agent_|user_|tool_|plan)/.test(event.updateType);
}

function authShape(initialized) {
  return {
    advertisedMethodIds: (Array.isArray(initialized?.authMethods) ? initialized.authMethods : [])
      .map((method) => method?.id)
      .filter((id) => typeof id === "string")
      .sort(),
    defaultMethodId: typeof initialized?._meta?.defaultAuthMethodId === "string"
      ? initialized._meta.defaultAuthMethodId
      : null,
    loadSession: initialized?.agentCapabilities?.loadSession === true,
  };
}

async function runOwnerWorker() {
  const rawDir = resolve(process.env.RAW_DIR || "");
  const rawOutput = resolve(process.env.PROBE_RAW_OUTPUT || "");
  const url = process.env.PROBE_WS_URL || "";
  const cwd = process.env.PROBE_CWD || "";
  const sessionId = process.env.PROBE_SESSION_ID || "";
  if (!process.send || !url || !cwd || !sessionId || !rawOutput.startsWith(`${rawDir}/`)) {
    process.exit(2);
  }
  const recorder = new ByteRecorder(rawOutput, "live-serve-remaining-owner", { generation: 1 });
  let activeSent = false;
  let promptStarted = false;
  const client = new WsAcpClient({
    name: "authorized-owner",
    url,
    recorder,
    onNotification: (event) => {
      if (promptStarted && !activeSent && event.method === "session/update"
        && ["agent_thought_chunk", "agent_message_chunk"].includes(event.updateType)) {
        activeSent = true;
        process.send?.({ type: "active", eventShape: `${event.method}:${event.updateType || "none"}` });
      }
      if (event.method === "_x.ai/session/prompt_complete") process.send?.({ type: "complete" });
    },
  });
  try {
    await client.connect();
    const initialized = await client.initializeAndAuthenticate();
    await client.requireCall("session/load", { sessionId, cwd, mcpServers: [] });
    process.send({ type: "ready", authShape: authShape(initialized) });
    process.on("message", (message) => {
      if (message?.type !== "start") return;
      promptStarted = true;
      void client.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: FIRST_PROMPT }],
      }, 180_000).then((response) => {
        process.send?.({
          type: "response",
          ok: response.ok,
          stopReason: response.ok && typeof response.result?.stopReason === "string"
            ? response.result.stopReason
            : null,
          errorCode: response.ok ? null : response.errorCode,
        });
      });
    });
  } catch (error) {
    process.send?.({
      type: "error",
      errorCode: error instanceof ProbeFailure ? error.code : "OWNER_WORKER_UNEXPECTED",
    });
    try { recorder.close(); } catch {}
    process.exit(1);
  }
}

async function waitForChildMessage(child, messages, predicate, timeoutMs, code, stage) {
  const existing = messages.find(predicate);
  if (existing) return existing;
  return withTimeout(new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message) => {
      if (message?.type === "error") {
        cleanup();
        rejectMessage(new ProbeFailure(message.errorCode || "OWNER_WORKER_ERROR", stage));
      } else if (predicate(message)) {
        cleanup();
        resolveMessage(message);
      }
    };
    const onExit = () => {
      cleanup();
      rejectMessage(new ProbeFailure("OWNER_WORKER_EXITED_EARLY", stage));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  }), timeoutMs, code, stage);
}

async function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), sleep(1_500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function runMain() {
  const rawDir = resolve(process.env.RAW_DIR || "/capture-raw");
  process.env.RAW_DIR = rawDir;
  const binary = resolve(process.env.GROK_BINARY || "/host-grok/grok");
  const authPath = resolve(process.env.GROK_AUTH_PATH || "/host-grok/auth.json");
  const agentIdPath = resolve(process.env.GROK_AGENT_ID_PATH || "/host-grok/agent_id");
  let stage = "preflight";
  let recorder;
  let serve;
  let ownerWorker;
  const clients = [];
  try {
    if (!existsSync(binary) || !existsSync(authPath)) fail("MISSING_PINNED_INPUT", stage);
    verifyRawBoundary(rawDir);
    const home = join(rawDir, "home");
    const cwd = join(rawDir, "cwd");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    if (existsSync(agentIdPath)) writeFileSync(join(home, "agent_id"), readFileSync(agentIdPath), { mode: 0o600 });

    const version = await withTimeout(new Promise((resolveVersion, rejectVersion) => {
      const child = spawn(binary, ["--version"], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
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
    if (sha256File(binary) !== EXPECTED_BINARY_SHA256) fail("BINARY_HASH_MISMATCH", stage);

    recorder = new ByteRecorder(join(rawDir, "live-serve-remaining-main.raw.ndjson"),
      "live-serve-remaining-main", { generation: 1 });
    const authDocument = JSON.parse(readFileSync(authPath, "utf8"));
    const scope = Object.keys(authDocument).find((key) => /^https?:\/\/.+::[^:]+$/.test(key));
    const port = await allocateLoopbackPort();
    const secret = `phase0-${randomUUID()}`;
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
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      ...(scope ? {
        GROK_OIDC_ISSUER: scope.slice(0, scope.lastIndexOf("::")),
        GROK_OIDC_CLIENT_ID: scope.slice(scope.lastIndexOf("::") + 2),
      } : {}),
    };
    const forbiddenEnvKeys = Object.keys(childEnv).filter((key) =>
      key.startsWith("COMMHUB_") || key === "NTOK" || key === "DATABASE_URL"
      || key.startsWith("AWS_") || /(?:_TOKEN|_SECRET)$/.test(key));
    if (forbiddenEnvKeys.length > 0) fail("CHILD_ENV_ALLOWLIST_VIOLATION", stage);

    stage = "serve-start";
    serve = spawn(binary, [
      "agent", "--no-leader", "serve",
      "--bind", `127.0.0.1:${port}`,
      "--secret", secret,
      "--debug", "--debug-file", join(rawDir, "serve-debug.log"),
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
        if (serveExited) fail("SERVE_EXITED_DURING_START", stage);
        await sleep(25);
      }
    })(), 10_000, "SERVE_START_TIMEOUT", stage);

    stage = "http-matrix";
    const beforeRejected = sessionSnapshot(home);
    if (beforeRejected.count !== 0) fail("PREEXISTING_SESSION_STATE", stage);
    const earlyFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd, mcpServers: [] },
    });
    const specs = [
      { name: "origin-absent", path: "/ws", credential: "correct-query" },
      { name: "origin-localhost", path: "/ws", credential: "correct-query", origin: "http://localhost" },
      { name: "origin-evil", path: "/ws", credential: "correct-query", origin: "https://evil.invalid" },
      { name: "origin-null", path: "/ws", credential: "correct-query", origin: "null" },
      { name: "path-root", path: "/", credential: "correct-query", earlyFrame },
      { name: "path-attach", path: "/attach", credential: "correct-query", earlyFrame },
      { name: "path-agent-ws", path: "/agent/ws", credential: "correct-query", earlyFrame },
      { name: "auth-missing", path: "/ws", credential: "missing", earlyFrame },
      { name: "auth-wrong-query", path: "/ws", credential: "wrong-query", earlyFrame },
      { name: "auth-wrong-bearer", path: "/ws", credential: "wrong-bearer", earlyFrame },
      { name: "auth-correct-bearer", path: "/ws", credential: "correct-bearer" },
    ];
    const httpMatrix = [];
    for (const spec of specs) {
      httpMatrix.push(await rawUpgradeProbe({ ...spec, port, secret }, recorder));
    }
    const rejected = httpMatrix.filter((entry) => entry.name.startsWith("auth-wrong")
      || entry.name === "auth-missing" || entry.name.startsWith("path-"));
    if (rejected.some((entry) => entry.upgraded || entry.responseContainedSessionData)) {
      fail("REJECTED_HTTP_ROUTE_EXPOSED_SESSION", stage);
    }
    if (rejected.some((entry) => !entry.earlyApplicationFrameSent)) {
      fail("REJECTED_HTTP_ROUTE_MISSING_MUTATION_CANARY", stage);
    }
    const afterRejected = sessionSnapshot(home);
    if (afterRejected.count !== beforeRejected.count || afterRejected.digest !== beforeRejected.digest) {
      fail("REJECTED_HTTP_ROUTE_MUTATED_SESSION_STATE", stage);
    }
    if (httpMatrix.find((entry) => entry.name === "origin-absent")?.httpStatus !== 101) {
      fail("CORRECT_WS_ROUTE_UNAVAILABLE", stage);
    }

    const url = `ws://127.0.0.1:${port}/ws?server-key=${encodeURIComponent(secret)}`;
    stage = "account-auth-boundary";
    const authProbe = new WsAcpClient({ name: "account-auth-boundary", url, recorder });
    clients.push(authProbe);
    await authProbe.connect();
    const initialized = await authProbe.initialize();
    const observedAuthShape = authShape(initialized);
    if (!observedAuthShape.advertisedMethodIds.includes("cached_token")) {
      fail("CACHED_TOKEN_NOT_ADVERTISED", stage);
    }
    const preAuthSession = await authProbe.call("session/new", { cwd, mcpServers: [] });
    const invalidAuth = await authProbe.call("authenticate", {
      methodId: "phase0.invalid",
      meta: { headless: true },
    });
    if (invalidAuth.ok) fail("INVALID_ACCOUNT_AUTH_ACCEPTED", stage);

    const interactiveMethodId = observedAuthShape.advertisedMethodIds
      .find((methodId) => methodId !== "cached_token") || null;
    const interactiveAuthProbe = new WsAcpClient({ name: "interactive-auth-boundary", url, recorder });
    clients.push(interactiveAuthProbe);
    await interactiveAuthProbe.connect();
    await interactiveAuthProbe.initialize();
    const interactiveAuthAttempt = interactiveMethodId
      ? await interactiveAuthProbe.call("authenticate", {
        methodId: interactiveMethodId,
        meta: { headless: true },
      }, 15_000)
      : {
        ok: false,
        timedOut: false,
        errorCode: null,
        errorMessageClass: "not-advertised",
      };
    await authProbe.authenticateCached();
    const created = await authProbe.requireCall("session/new", { cwd, mcpServers: [] });
    if (typeof created?.sessionId !== "string") fail("SESSION_NEW_NO_ID_AFTER_CACHED_AUTH", stage);
    const sessionId = created.sessionId;
    const accountAuthBoundary = {
      initialize: observedAuthShape,
      preAuthSessionNew: {
        accepted: preAuthSession.ok,
        resultShape: preAuthSession.ok && preAuthSession.result && typeof preAuthSession.result === "object"
          ? Object.keys(preAuthSession.result).sort()
          : [],
        errorCode: preAuthSession.ok ? null : preAuthSession.errorCode ?? null,
        errorMessageClass: preAuthSession.ok ? null : preAuthSession.errorMessageClass,
      },
      invalidMethod: {
        accepted: invalidAuth.ok,
        errorCode: invalidAuth.errorCode ?? null,
        errorMessageClass: invalidAuth.errorMessageClass,
      },
      cachedToken: { accepted: true, sessionNewAccepted: true },
      advertisedInteractiveMethodHeadless: {
        methodId: interactiveMethodId,
        outcome: interactiveAuthAttempt.ok
          ? "accepted"
          : interactiveAuthAttempt.timedOut ? "timeout" : "jsonrpc-error",
        errorCode: interactiveAuthAttempt.ok ? null : interactiveAuthAttempt.errorCode ?? null,
        errorMessageClass: interactiveAuthAttempt.ok ? null : interactiveAuthAttempt.errorMessageClass,
        resultShape: interactiveAuthAttempt.ok && interactiveAuthAttempt.result
          && typeof interactiveAuthAttempt.result === "object"
          ? Object.keys(interactiveAuthAttempt.result).sort()
          : [],
      },
    };
    await interactiveAuthProbe.close();
    await authProbe.close();

    stage = "concurrent-clients";
    const idleObserver = new WsAcpClient({ name: "idle-observer", url, recorder });
    const queuedSubmitter = new WsAcpClient({ name: "queued-submitter", url, recorder });
    clients.push(idleObserver, queuedSubmitter);
    await Promise.all([idleObserver.connect(), queuedSubmitter.connect()]);
    await Promise.all([
      idleObserver.initializeAndAuthenticate(),
      queuedSubmitter.initializeAndAuthenticate(),
    ]);
    await Promise.all([
      idleObserver.requireCall("session/load", { sessionId, cwd, mcpServers: [] }),
      queuedSubmitter.requireCall("session/load", { sessionId, cwd, mcpServers: [] }),
    ]);
    idleObserver.notifications = [];
    queuedSubmitter.notifications = [];

    const ownerMessages = [];
    ownerWorker = fork(scriptPath, ["--owner-worker"], {
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        RAW_DIR: rawDir,
        PROBE_RAW_OUTPUT: join(rawDir, "live-serve-remaining-owner.raw.ndjson"),
        PROBE_WS_URL: url,
        PROBE_CWD: cwd,
        PROBE_SESSION_ID: sessionId,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    ownerWorker.on("message", (message) => ownerMessages.push(message));
    await waitForChildMessage(ownerWorker, ownerMessages, (message) => message?.type === "ready",
      30_000, "OWNER_WORKER_READY_TIMEOUT", stage);
    ownerWorker.send({ type: "start" });
    const activeMessage = await waitForChildMessage(ownerWorker, ownerMessages,
      (message) => message?.type === "active", 60_000, "OWNER_ACTIVE_TIMEOUT", stage);
    const ownerCompletedBeforeQueue = ownerMessages.some((message) =>
      message?.type === "complete" || message?.type === "response");
    if (ownerCompletedBeforeQueue) {
      fail("OWNER_ACTIVE_WINDOW_COLLAPSED", stage);
    }
    const queuedAt = Date.now();
    const queuedPromptPromise = queuedSubmitter.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: SECOND_PROMPT }],
    }, 180_000);

    stage = "active-tail";
    const activeTail = new WsAcpClient({ name: "active-tail", url, recorder });
    clients.push(activeTail);
    const tailConnectedAt = Date.now();
    await activeTail.connect();
    await activeTail.initializeAndAuthenticate();
    await activeTail.requireCall("session/load", { sessionId, cwd, mcpServers: [] });
    const tailFirstEvent = await activeTail.waitForNotification(
      (event) => event.method === "session/update"
        && ["agent_thought_chunk", "agent_message_chunk"].includes(event.updateType),
      30_000,
      "ACTIVE_TAIL_NO_LIVE_EVENT",
    );
    if (ownerMessages.some((message) => message?.type === "complete" || message?.type === "response")) {
      fail("ACTIVE_TAIL_ATTACHED_AFTER_OWNER_COMPLETION", stage);
    }

    stage = "owner-disconnect";
    const ownerDisconnectAt = Date.now();
    ownerWorker.kill("SIGKILL");
    const ownerExit = await withTimeout(new Promise((resolveExit) => {
      ownerWorker.once("exit", (code, signal) => resolveExit({ code, signal }));
    }), 5_000, "OWNER_DISCONNECT_TIMEOUT", stage);
    const firstTailCompletion = await activeTail.waitForNotification(
      (event) => event.method === "_x.ai/session/prompt_complete",
      180_000,
      "FIRST_TURN_DID_NOT_COMPLETE_AFTER_OWNER_DISCONNECT",
    );
    const queuedResponse = await queuedPromptPromise;
    const queuedDoneAt = Date.now();
    if (!queuedResponse.ok || queuedResponse.result?.stopReason !== "end_turn") {
      fail("QUEUED_SECOND_PROMPT_DID_NOT_COMPLETE", stage);
    }
    if (firstTailCompletion.at < ownerDisconnectAt) fail("FIRST_TURN_COMPLETED_BEFORE_OWNER_DISCONNECT", stage);

    stage = "normal-close";
    const closeProbe = new WsAcpClient({ name: "normal-close", url, recorder });
    clients.push(closeProbe);
    await closeProbe.connect();
    await closeProbe.initializeAndAuthenticate();
    const normalClose = await closeProbe.close(1000, CLOSE_TIMEOUT_MS);

    await sleep(500);
    const summary = {
      schema: "test223-live-serve-remaining-summary/v1",
      ok: true,
      protocolFreeze: false,
      baseline: {
        version: EXPECTED_VERSION,
        binarySha256: EXPECTED_BINARY_SHA256,
      },
      isolation: {
        rawStorage: "explicit-tmpfs-only-and-destroyed",
        home: "isolated-under-raw-tmpfs",
        serveBind: "127.0.0.1-only",
        childEnvKeys: Object.keys(childEnv).sort(),
        forbiddenChildEnvKeyCount: forbiddenEnvKeys.length,
        hostNetworkUseByHarness: "loopback-only; Grok vendor auth/model egress only",
      },
      httpMatrix,
      rejectedBoundary: {
        checkedCases: rejected.map((entry) => entry.name).sort(),
        allRejectedBeforeWebSocket: rejected.every((entry) => !entry.upgraded),
        anySessionDataReturned: rejected.some((entry) => entry.responseContainedSessionData),
        sessionStateBefore: beforeRejected,
        sessionStateAfter: afterRejected,
        mutationObserved: beforeRejected.digest !== afterRejected.digest,
      },
      accountAuthBoundary,
      concurrentClients: {
        twoAuthorizedClientsLoadedBeforePrompt: true,
        ownerActiveSignalShape: activeMessage.eventShape,
        secondPromptSubmittedWhileOwnerActive: !ownerCompletedBeforeQueue,
        queuedSecondPromptStopReason: queuedResponse.result.stopReason,
        firstTurnCompletedBeforeSecondResponse: firstTailCompletion.at <= queuedDoneAt,
      },
      ownerDisconnect: {
        authorizedOwnerWasActive: true,
        disconnectKind: "worker-process-killed-after-active-tail-observed",
        exitCode: ownerExit.code,
        exitSignal: ownerExit.signal,
        firstTurnCompletedAfterDisconnect: firstTailCompletion.at >= ownerDisconnectAt,
        queuedSecondTurnCompletedAfterDisconnect: queuedDoneAt >= ownerDisconnectAt,
      },
      observerSemantics: {
        idleObserverEventCount: idleObserver.notifications.length,
        idleObserverTurnEventCount: idleObserver.notifications.filter(isTurnEvent).length,
        idleObserverShapes: notificationShapes(idleObserver.notifications),
        activeTailConnectedAfterActiveSignal: tailConnectedAt >= queuedAt,
        activeTailFirstEventDelayMs: tailFirstEvent.at - tailConnectedAt,
        activeTailEventCount: activeTail.notifications.length,
        activeTailTurnEventCount: activeTail.notifications.filter(isTurnEvent).length,
        activeTailShapes: notificationShapes(activeTail.notifications),
        activeTailSawPromptComplete: activeTail.notifications.some((event) =>
          event.method === "_x.ai/session/prompt_complete"),
        queuedSubmitterShapes: notificationShapes(queuedSubmitter.notifications),
      },
      serverRequests: {
        methods: [...new Set(clients.flatMap((client) => client.serverRequests))].sort(),
        disposition: "all-rejected-fail-closed",
      },
      close: {
        normalClientRequestedCode: 1000,
        normalClient: normalClose,
        serverAcknowledgedRequestedCode: normalClose.observedCode === 1000,
        ownerActiveDisconnectHasWebSocketCloseCode: false,
      },
      rawCapture: { persisted: false, destroyedBeforeExit: true },
    };

    recorder.close();
    recorder = undefined;
    await terminateChild(serve);
    serve = undefined;
    deleteRawContents(rawDir);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await terminateChild(ownerWorker, "SIGKILL");
    for (const client of clients) {
      try {
        if (client.socket?.readyState === WebSocket.OPEN) client.socket.close(1000);
      } catch {}
    }
    await terminateChild(serve);
    try { recorder?.close(); } catch {}
    try { deleteRawContents(rawDir); } catch {}
  }
}

if (process.argv.includes("--owner-worker")) {
  void runOwnerWorker();
} else {
  runMain().catch((error) => {
    const ownFrame = typeof error?.stack === "string"
      ? error.stack.split("\n").find((line) => line.includes(basename(scriptPath)))
      : undefined;
    const ownLocation = ownFrame?.match(/:(\d+):(\d+)\)?$/);
    const sanitized = error instanceof ProbeFailure
      ? { ok: false, protocolFreeze: false, stage: error.stage, errorCode: error.code }
      : {
        ok: false,
        protocolFreeze: false,
        stage: "unexpected",
        errorCode: "UNEXPECTED_FAILURE",
        errorType: typeof error?.name === "string" ? error.name : "UnknownError",
        sourceLine: ownLocation ? Number(ownLocation[1]) : null,
      };
    process.stdout.write(`${JSON.stringify(sanitized)}\n`);
    process.exitCode = 1;
  });
}
