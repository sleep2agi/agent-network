import { accessSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import { safeAdopt } from "../../agent-node/src/runtime/codex-policy-gateway/safe-adopt";
import { CodexUpstreamTransport } from "../../agent-node/src/runtime/codex-policy-gateway/upstream-transport";
import { spawnOwnedCodexUpstream } from "../../agent-node/src/runtime/codex-policy-gateway/owned-upstream-provider";
import { resolveSqliteDriver } from "../../agent-node/src/runtime/codex-policy-gateway/sqlite-driver";

let passed = 0;
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`ok ${passed}: ${label}`);
}

async function nativeBoundary<T>(promise: Promise<T>, label: string): Promise<T> {
  check(Object.getPrototypeOf(promise) === Promise.prototype, `${label}: Promise.prototype`);
  check(promise.constructor === Promise, `${label}: base constructor`);
  check(Promise.resolve(promise) === promise, `${label}: Promise.resolve identity`);
  check(!Object.hasOwn(promise, "then"), `${label}: no decorated own then`);
  const adopted = safeAdopt<T>(promise);
  check(Object.getPrototypeOf(adopted) === Promise.prototype, `${label}: safeAdopt returns base Promise`);
  return await adopted;
}

check(/^v20\.20\./.test(process.version), "runtime is exact Node 20.20.x line");
const require = createRequire(import.meta.url);
const sqlitePkg = require("better-sqlite3/package.json") as { version: string };
check(sqlitePkg.version === "12.9.0", "better-sqlite3 fallback is exact pinned 12.9.0");

const dbPath = "/tmp/rfc030-node20-real.sqlite3";
rmSync(dbPath, { force: true });
const first = resolveSqliteDriver(dbPath);
check(first.flavor === "better-sqlite3", "Node 20 selects synchronous better-sqlite3 fallback");
first.driver.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
first.driver.prepare("INSERT INTO evidence(value) VALUES (?)").run("durable-node20");
first.driver.close();
accessSync(dbPath);
const second = resolveSqliteDriver(dbPath);
const row = second.driver.prepare("SELECT value FROM evidence WHERE id = 1").get() as { value: string };
check(row.value === "durable-node20", "SQLite write survives close and reopen");
second.driver.close();

const providerPromise = spawnOwnedCodexUpstream({
  binary: "/harness/fake-owned-upstream.mjs",
  baselineGate: async () => undefined,
  startupTimeoutMs: 2_000,
  termTimeoutMs: 500,
  killTimeoutMs: 500,
  env: { PATH: process.env.PATH, HOME: "/tmp" },
});
const provider = await nativeBoundary(providerPromise, "owned provider spawn");
check(/^ws:\/\/127\.0\.0\.1:\d+$/.test(provider.url), "owned provider exposes strict loopback URL");
await nativeBoundary(provider.shutdown(), "owned provider graceful shutdown");

const abortProvider = await nativeBoundary(
  spawnOwnedCodexUpstream({
    binary: "/harness/fake-owned-upstream.mjs",
    baselineGate: async () => undefined,
    startupTimeoutMs: 2_000,
    termTimeoutMs: 500,
    killTimeoutMs: 500,
    env: { PATH: process.env.PATH, HOME: "/tmp" },
  }),
  "owned provider second spawn",
);
await nativeBoundary(abortProvider.abort(), "owned provider force abort");

async function openWss(): Promise<{
  server: WebSocketServer;
  url: string;
  received: Promise<string>;
}> {
  let resolveReceived!: (value: string) => void;
  const received = new Promise<string>((resolve) => {
    resolveReceived = resolve;
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.once("message", (data) => resolveReceived(data.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ws address");
  return { server, url: `ws://127.0.0.1:${address.port}`, received };
}

async function closeWss(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const gracefulWss = await openWss();
const transport = new CodexUpstreamTransport({ url: gracefulWss.url });
await nativeBoundary(transport.connect(), "transport connect");
await nativeBoundary(transport.probe(), "transport readiness probe");
await nativeBoundary(
  transport.writeFrame({ jsonrpc: "2.0", method: "evidence/native", params: { ok: true } }),
  "transport writeFrame",
);
const frame = await gracefulWss.received;
check(frame.includes('"method":"evidence/native"'), "real WebSocket received serialized frame");
await nativeBoundary(transport.close(), "transport graceful close");
await closeWss(gracefulWss.server);

const abortWss = await openWss();
const abortTransport = new CodexUpstreamTransport({ url: abortWss.url });
await nativeBoundary(abortTransport.connect(), "abort transport connect");
await nativeBoundary(abortTransport.abort(), "transport force abort");
await closeWss(abortWss.server);

console.log(`R1 + Node20.20 probe PASS: ${passed}/${passed}`);
