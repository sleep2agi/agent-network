import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { WebSocketServer } from "ws";
import { asMessageId, asTaskId } from "../../agent-node/src/runtime/codex-policy-gateway/contract";
import { BridgeAdapter } from "../../agent-node/src/runtime/codex-policy-gateway/bridge-adapter";
import { GatewayLedger } from "../../agent-node/src/runtime/codex-policy-gateway/ledger";
import { GatewayScheduler } from "../../agent-node/src/runtime/codex-policy-gateway/scheduler";
import { resolveSqliteDriver } from "../../agent-node/src/runtime/codex-policy-gateway/sqlite-driver";
import { buildAllowlistEnv, TUI_BEARER_ENV_NAME } from "../../agent-node/src/runtime/codex-policy-gateway/tui-child-launcher";
import {
  ProductionTuiLauncher,
  PRODUCTION_TUI_ENV_ALLOWLIST,
  TUI_TERM_GRACE_MS,
} from "../../agent-node/src/runtime/codex-policy-gateway/production-tui-launcher";
import {
  CodexUpstreamTransport,
  UPSTREAM_WS_MAX_PAYLOAD,
} from "../../agent-node/src/runtime/codex-policy-gateway/upstream-transport";

// Deliberately never printed. Reports identify it only as the R2 sentinel.
const RAW_UPSTREAM_SENTINEL = "MUTATION_RED_UPSTREAM_DETAIL_74f3b6a9";
const CAPTURE = "/tmp/rfc030-tui-capture.txt";
const DB = "/tmp/rfc030-r2.sqlite3";

let passed = 0;
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`ok ${passed}: ${label}`);
}

function noSentinel(value: unknown, label: string): void {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = "<unrenderable>";
  }
  check(!rendered.includes(RAW_UPSTREAM_SENTINEL), `${label}: upstream detail absent`);
}

class RejectingRpc {
  readonly handlers = new Map<string, Array<(params: unknown) => void>>();
  request<T>(): Promise<T> {
    const error = new Error(RAW_UPSTREAM_SENTINEL) as Error & { data?: unknown };
    error.data = { nested: RAW_UPSTREAM_SENTINEL };
    return Promise.reject(error);
  }
  on(event: string, fn: (params: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }
}

const adapterLogs: string[] = [];
const diagnosticEntries: unknown[] = [];
const adapter = new BridgeAdapter({
  client: new RejectingRpc(),
  threadId: "thread-r2",
  log: (message) => adapterLogs.push(message),
  diagnostics: {
    newCorrelationId: () => "r2-local-1",
    reportInternalError: (entry) => diagnosticEntries.push(entry),
  },
});
const clientOutcome = await adapter.startTurn({
  submissionId: "submission-r2-client",
  taskId: "task-r2-client",
  text: "safe task text",
  fromAlias: "display",
  clientUserMessageId: "anet:r2-client",
});
check(clientOutcome.kind === "failed", "adapter turns raw upstream rejection into stable failure");
noSentinel(clientOutcome, "client surface");
noSentinel(adapterLogs, "adapter log surface");
noSentinel(diagnosticEntries, "adapter diagnostic surface");
check(
  diagnosticEntries.length === 1 &&
    JSON.stringify(diagnosticEntries[0]).includes("RedactedUpstreamFailure"),
  "diagnostic keeps a redacted classification and local correlation",
);

rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });
const { driver } = resolveSqliteDriver(DB);
const ledger = new GatewayLedger(driver);
const schedulerLogs: string[] = [];
const scheduler = new GatewayScheduler({
  ledger,
  ownerAttached: () => true,
  log: (message) => schedulerLogs.push(message),
  dispatcher: {
    async startTurn() {
      throw new Error(RAW_UPSTREAM_SENTINEL);
    },
  },
});
const enqueue = await scheduler.enqueueTask({
  taskId: asTaskId("task-r2-persisted"),
  messageId: asMessageId("message-r2-persisted"),
  text: "safe persisted task",
  authenticatedSender: {
    alias: "display",
    tokenId: "token-stamped",
    role: "node",
    networkId: "network-r2",
  },
});
check(enqueue.outcome === "accepted", "scheduler accepts stamped R2 probe task");

let persisted = ledger.get("message-r2-persisted");
for (let i = 0; i < 100 && persisted?.state !== "failed"; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  persisted = ledger.get("message-r2-persisted");
}
check(persisted?.state === "failed", "unexpected dispatcher throw reaches terminal failed state");
noSentinel(persisted, "ledger API surface");
noSentinel(schedulerLogs, "scheduler log surface");
driver.close();

const persistedBytes = [DB, `${DB}-wal`, `${DB}-shm`]
  .filter(existsSync)
  .map((path) => readFileSync(path).toString("latin1"))
  .join("");
noSentinel(persistedBytes, "SQLite persisted bytes");

// Real WebSocket transport receives an upstream-controlled close reason. It
// must expose stable transport state/diagnostics only.
const transportLogs: string[] = [];
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({
    id: 72,
    error: {
      code: -32_000,
      message: RAW_UPSTREAM_SENTINEL,
      data: { nested: RAW_UPSTREAM_SENTINEL },
    },
  }));
  socket.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 73,
    error: {
      code: -32_000,
      message: RAW_UPSTREAM_SENTINEL,
      data: { nested: RAW_UPSTREAM_SENTINEL },
    },
  }));
  setTimeout(() => socket.close(1011, RAW_UPSTREAM_SENTINEL), 20);
});
await new Promise<void>((resolve, reject) => {
  wss.once("listening", resolve);
  wss.once("error", reject);
});
const address = wss.address();
if (address === null || typeof address === "string") throw new Error("missing R2 WS address");
const transport = new CodexUpstreamTransport({
  url: `ws://127.0.0.1:${address.port}`,
  log: (message) => transportLogs.push(message),
});
const transportResponses = new Promise<unknown[]>((resolve) => {
  const frames: unknown[] = [];
  transport.onFrame((frame) => {
    frames.push(frame);
    if (frames.length === 2) resolve(frames);
  });
});
await transport.connect();
const [malformedErrorResponse, redactedResponse] = await transportResponses;
check(
  JSON.stringify(malformedErrorResponse) === '{"malformed":true}',
  "invalid-version error frame is dropped, never repaired into a live response",
);
noSentinel(malformedErrorResponse, "invalid error frame surface");
noSentinel(redactedResponse, "transport response/client surface");
check(
  JSON.stringify(redactedResponse).includes('"message":"upstream request failed"') &&
    !JSON.stringify(redactedResponse).includes('"data"'),
  "transport redacts upstream error message/data before final-A routing",
);
await new Promise((resolve) => setTimeout(resolve, 30));
let transportClientError: unknown = null;
try {
  await transport.writeFrame({ jsonrpc: "2.0", method: "r2/probe" });
} catch (error) {
  transportClientError = error;
}
check(transportClientError instanceof Error, "closed transport fails client operation");
noSentinel(transportClientError instanceof Error ? transportClientError.message : transportClientError, "transport client surface");
noSentinel(transportLogs, "transport log surface");
await transport.close();
await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));

const oversizedLogs: string[] = [];
const oversizedWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
oversizedWss.on("connection", (socket) => {
  socket.send("x".repeat(UPSTREAM_WS_MAX_PAYLOAD + 1));
});
await new Promise<void>((resolve, reject) => {
  oversizedWss.once("listening", resolve);
  oversizedWss.once("error", reject);
});
const oversizedAddress = oversizedWss.address();
if (oversizedAddress === null || typeof oversizedAddress === "string") {
  throw new Error("missing oversized WS address");
}
const oversizedTransport = new CodexUpstreamTransport({
  url: `ws://127.0.0.1:${oversizedAddress.port}`,
  log: (message) => oversizedLogs.push(message),
});
const oversizedClosed = new Promise<void>((resolve) => oversizedTransport.onClose(resolve));
await oversizedTransport.connect();
await oversizedClosed;
check(oversizedLogs.some((line) => line.includes("code=upstream_socket_error")), "oversized upstream frame closes at the fixed payload bound");
check(!oversizedLogs.join("\n").includes("xxx"), "oversized upstream payload is absent from diagnostics");
await oversizedTransport.abort();
await new Promise<void>((resolve, reject) =>
  oversizedWss.close((error) => error ? reject(error) : resolve()),
);

check(
  [...PRODUCTION_TUI_ENV_ALLOWLIST].sort().join(",") ===
    ["ANET_CODEX_TUI_BEARER", "CODEX_HOME", "HOME", "PATH", "TMPDIR"].sort().join(","),
  "production launcher allowlist is the exact five-key set",
);
check(TUI_TERM_GRACE_MS === 1_000, "launcher TERM grace is pinned to one second");

const bearer = "r2-bearer-material-never-print-0123456789";
const launchEnv = buildAllowlistEnv(bearer, {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp",
  TMPDIR: "/tmp",
  CODEX_HOME: "/tmp/codex-home",
});
check(
  Object.keys(launchEnv).sort().join(",") ===
    [TUI_BEARER_ENV_NAME, "CODEX_HOME", "HOME", "PATH", "TMPDIR"].sort().join(","),
  "launch request contains exactly the five allowed environment keys",
);

let foreignEnvRejected = false;
try {
  buildAllowlistEnv(bearer, { COMMHUB_TOKEN: "must-not-pass" } as never);
} catch {
  foreignEnvRejected = true;
}
check(foreignEnvRejected, "foreign environment slot is rejected before spawn");

let nonLoopbackRejected = false;
try {
  const negative = new ProductionTuiLauncher({
    binary: "/repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs",
  });
  await negative.launch({ wsUrl: "ws://0.0.0.0:1234", env: launchEnv });
} catch {
  nonLoopbackRejected = true;
}
check(nonLoopbackRejected, "non-strict-loopback remote is rejected before PTY spawn");

// The PTY wrapper inherits the bearer, so caller PATH must not select it.
const shadowDir = "/tmp/rfc030-shadow-pty";
const shadowMarker = `${shadowDir}/executed`;
rmSync(shadowDir, { recursive: true, force: true });
mkdirSync(shadowDir, { recursive: true });
writeFileSync(
  `${shadowDir}/script`,
  `#!/bin/sh\nprintf executed > '${shadowMarker}'\nexit 91\n`,
  { mode: 0o755 },
);
chmodSync(`${shadowDir}/script`, 0o755);
const shadowLauncher = new ProductionTuiLauncher({
  binary: "/repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs",
  cwd: "/tmp",
  writeStdout: () => {},
  writeStderr: () => {},
});
const shadowOutcome = await shadowLauncher.launch({
  wsUrl: "ws://127.0.0.1:43209",
  env: buildAllowlistEnv(bearer, {
    PATH: `${shadowDir}:/usr/bin:/bin`,
    HOME: "/tmp",
    TMPDIR: "/tmp",
    CODEX_HOME: "/tmp/codex-home",
  }),
});
check(shadowOutcome.spawned === true, "fixed PTY wrapper launches with a PATH shadow present");
await shadowLauncher.terminate();
check(!existsSync(shadowMarker), "PATH-shadowed script never executes or receives the bearer");
rmSync(shadowDir, { recursive: true, force: true });

process.env.COMMHUB_TOKEN = "host-token-must-not-inherit";
process.env.AWS_SECRET_ACCESS_KEY = "host-cloud-secret-must-not-inherit";
rmSync(CAPTURE, { force: true });
const launcherLogs: string[] = [];
const launcherOutput: Buffer[] = [];
const launcher = new ProductionTuiLauncher({
  binary: "/repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs",
  threadId: "thread-r2-production-resume",
  cwd: "/tmp",
  log: (message) => launcherLogs.push(message),
  writeStdout: (chunk) => launcherOutput.push(Buffer.from(chunk)),
  writeStderr: (chunk) => launcherOutput.push(Buffer.from(chunk)),
});
const launchOutcome = await launcher.launch({
  wsUrl: "ws://127.0.0.1:43210",
  env: launchEnv,
});
check(launchOutcome.spawned === true, "real util-linux PTY child reports spawned");

for (let i = 0; i < 100 && !existsSync(CAPTURE); i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
check(existsSync(CAPTURE), "fake Codex observed the real PTY exec boundary");
const capture = readFileSync(CAPTURE, "utf8");
const capturedArgs = capture
  .split("\n")
  .filter((line) => line.startsWith("ARG="))
  .map((line) => line.slice(4));
const capturedEnvKeys = new Set(
  capture
    .split("\n")
    .filter((line) => line.startsWith("ENV_KEY="))
    .map((line) => line.slice(8)),
);
check(capturedArgs.includes("--remote") && capturedArgs.includes("ws://127.0.0.1:43210"), "PTY argv pins strict loopback remote");
check(
  capturedArgs[0] === "resume" && capturedArgs.includes("thread-r2-production-resume"),
  "production PTY path resumes the assembly-bound thread",
);
check(
  capturedArgs.includes("--remote-auth-token-env") && capturedArgs.includes(TUI_BEARER_ENV_NAME),
  "PTY argv references only the pinned bearer environment name",
);
check(capturedArgs.includes("approval_policy=never"), "PTY argv pins approval=never");
check(capturedArgs.includes("sandbox_mode=read-only"), "PTY argv pins read-only sandbox");
check(!capture.includes(bearer), "bearer plaintext is absent from argv/key-only capture");
for (const key of [TUI_BEARER_ENV_NAME, "CODEX_HOME", "HOME", "PATH", "TMPDIR"]) {
  check(capturedEnvKeys.has(key), `PTY child receives allowlisted ${key}`);
}
check(
  [...capturedEnvKeys].sort().join(",") ===
    [TUI_BEARER_ENV_NAME, "CODEX_HOME", "HOME", "PATH", "TMPDIR"].sort().join(","),
  "real PTY child environment is exactly the five-key allowlist",
);
for (const key of ["COMMHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "ANET_HUB_TOKEN"]) {
  check(!capturedEnvKeys.has(key), `PTY child does not inherit ${key}`);
}
noSentinel(launcherLogs, "launcher log surface");
check(!launcherLogs.join("\n").includes(bearer), "launcher logs contain no bearer plaintext");
check(!Buffer.concat(launcherOutput).toString("utf8").includes(bearer), "PTY output contains no bearer plaintext");

const pid = Number(/^PID=(\d+)$/m.exec(capture)?.[1]);
const pgid = Number(/^PGID=(\d+)$/m.exec(capture)?.[1]);
check(Number.isInteger(pid) && pid > 1 && Number.isInteger(pgid) && pgid > 1, "PTY process and group ids captured");
const teardownStarted = Date.now();
await launcher.terminate();
const teardownMs = Date.now() - teardownStarted;
check(teardownMs <= 2 * TUI_TERM_GRACE_MS + 750, "TERM/KILL teardown stays within the two fixed bounds");

let groupGone = false;
for (let i = 0; i < 50 && !groupGone; i++) {
  try {
    process.kill(-pgid, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") groupGone = true;
    else throw error;
  }
}
check(groupGone, "bounded teardown leaves no PTY process group");

console.log(`R2 + real PTY launcher probe PASS: ${passed}/${passed}`);
