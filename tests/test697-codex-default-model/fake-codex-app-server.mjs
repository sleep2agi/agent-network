#!/usr/bin/env node
// Minimal line-delimited JSON-RPC app-server for the real direct-stdio lane.
// Captures thread/start params and completes one deterministic turn.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const capture = process.env.TEST697_STDIO_CAPTURE || "/tmp/test697-stdio-capture.jsonl";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "thread/start") {
    appendFileSync(capture, JSON.stringify(req.params) + "\n");
    send({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "stdio-697" } } });
  } else if (req.method === "turn/start") {
    send({ jsonrpc: "2.0", id: req.id, result: { turn: { id: "turn-697" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "item/completed", params: { turnId: "turn-697", item: { type: "agentMessage", text: "TEST697_STDIO_OK" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { turnId: "turn-697" } });
    }, 10);
  } else if (req.method === "shutdown") {
    send({ jsonrpc: "2.0", id: req.id, result: null });
    process.exit(0);
  } else {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
