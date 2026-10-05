#!/usr/bin/env bun
// Fake `codex` for the TM upgrade rehearsal: speaks just enough codex app-server JSON-RPC over
// `app-server --listen ws://…` for a headless agent-node to create a thread and complete one turn.
// No OpenAI login, no model call. Every invocation is logged to $FAKE_CODEX_LOG.
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_CODEX_LOG || "/tmp/fake-codex.log";
const log = (l) => { try { appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} ${l}\n`); } catch {} };
log(`invoke ${JSON.stringify(args)} CODEX_HOME=${process.env.CODEX_HOME ?? ""}`);
if (args[0] === "--version" || args[0] === "-V") { console.log("codex-cli 0.155.0"); process.exit(0); }
if (args[0] !== "app-server") { process.exit(0); }
// Crash-loop switch: while this file exists every app-server launch dies at once (models an app-server
// that cannot start — OOM-killed at boot, broken binary, bad config).
if (existsSync(process.env.FAKE_CODEX_CRASH_FLAG || "/tmp/fake-codex-crash")) { log("crash-on-start (flag set)"); process.exit(1); }
const li = args.indexOf("--listen");
if (li < 0) { log("stdio app-server not supported by this fake"); process.exit(2); }
const url = new URL(args[li + 1]);
let turnNo = 0;
Bun.serve({
  hostname: url.hostname,
  port: Number(url.port),
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 }); },
  websocket: {
    message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.id === undefined || msg.id === null) return;
      log(`rpc ${msg.method}`);
      let result = {};
      const threadId = msg.params?.threadId || "thread_tm_rehearsal";
      if (msg.method === "thread/start") result = { thread: { id: "thread_tm_rehearsal" } };
      if (msg.method === "thread/resume") result = { thread: { id: threadId } };
      if (msg.method === "thread/read") result = { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
      if (msg.method === "thread/turns/list") result = { data: [], nextCursor: null, backwardsCursor: null };
      if (msg.method === "turn/start") {
        const turnId = `turn_${++turnNo}_${process.pid}`;
        result = { turn: { id: turnId, status: "inProgress" } };
        setTimeout(() => {
          const text = `FAKE_CODEX_OK pid=${process.pid} turn=${turnNo}`;
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } }));
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: { id: `item_${turnNo}`, type: "agentMessage", phase: "final_answer", text } } }));
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", items: [] } } }));
        }, 50);
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    },
  },
});
console.log(`listening on: ${url.href}`);
setInterval(() => {}, 1000);
