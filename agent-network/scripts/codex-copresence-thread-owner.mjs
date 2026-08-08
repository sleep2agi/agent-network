#!/usr/bin/env node
import { realpathSync } from "node:fs";

function fail(message) { console.error(`REFUSE: ${message}`); process.exit(2); }
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1];
  if (!key || value === undefined) fail("arguments must be --key value pairs");
  args[key] = value;
}
for (const key of ["ws", "thread-id", "node-id", "alias", "cwd", "mode"]) if (!args[key]) fail(`--${key} is required`);
if (!/^ws:\/\/127\.0\.0\.1:[0-9]+$/.test(args.ws)) fail("--ws must be loopback websocket");
if (!/^[A-Za-z0-9_-]{8,128}$/.test(args["thread-id"])) fail("unsafe thread id");
if (!/^n_[A-Za-z0-9]+$/.test(args["node-id"])) fail("unsafe node id");
if (!["claim", "verify"].includes(args.mode)) fail("--mode must be claim or verify");
const expectedCwd = realpathSync(args.cwd);
const expectedName = `anet:${args["node-id"]}:${args.alias}`;

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(args.ws);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5_000);
  ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket open failed")); }, { once: true });
}).catch((error) => fail(error.message));
ws.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id); if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.code ?? "rpc"}: ${message.error.message ?? "error"}`));
  else waiter.resolve(message.result);
});
function request(method, params, timeout = 10_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
function notify(method, params) { ws.send(JSON.stringify({ jsonrpc: "2.0", method, params })); }
async function readThread() {
  const result = await request("thread/read", { threadId: args["thread-id"], includeTurns: false });
  const thread = result?.thread;
  if (!thread || thread.id !== args["thread-id"]) fail("thread/read did not return the exact configured thread");
  let actualCwd;
  try { actualCwd = realpathSync(thread.cwd); } catch { fail("thread cwd is missing or not resolvable"); }
  if (actualCwd !== expectedCwd) fail(`thread cwd mismatch: expected ${expectedCwd}, got ${actualCwd}`);
  return thread;
}
try {
  await request("initialize", { clientInfo: { name: "anet-fleet-normalizer", title: "fleet normalizer", version: "1" } });
  notify("initialized", {});
  await request("thread/resume", { threadId: args["thread-id"] });
  let thread = await readThread();
  if (thread.name !== expectedName) {
    if (args.mode !== "claim" || (thread.name !== null && thread.name !== "")) {
      fail(`thread owner mismatch: expected ${expectedName}, got ${JSON.stringify(thread.name)}`);
    }
    await request("thread/name/set", { threadId: args["thread-id"], name: expectedName });
    thread = await readThread();
    if (thread.name !== expectedName) fail("thread owner claim did not persist");
  }
  console.log(JSON.stringify({ ok: true, thread_id: thread.id, owner: expectedName, cwd: expectedCwd, mode: args.mode }));
  ws.close();
} catch (error) { fail(error.message); }
