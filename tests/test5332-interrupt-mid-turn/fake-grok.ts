#!/usr/bin/env bun
// Stand-in for `grok`. Speaks just enough ACP for one turn that is held until it is
// either released (a file appears) or cancelled (the client sends session/cancel).
// It records what happened in files, so the scenario reads facts instead of guessing.

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("grok 0.0.0-fake\n");
  process.exit(0);
}

const dir = process.env.GROK_FAKE_HOLD_DIR || "/tmp/grok-fake-hold";
mkdirSync(dir, { recursive: true });
const send = (msg: unknown) => { process.stdout.write(JSON.stringify(msg) + "\n"); };

let turnInFlight = false;
let cancelRequested = false;

async function holdTurn(id: unknown): Promise<void> {
  turnInFlight = true;
  cancelRequested = false;
  appendFileSync(`${dir}/prompts`, "p\n");
  writeFileSync(`${dir}/holding`, String(Date.now()));
  while (!cancelRequested && !existsSync(`${dir}/release`)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stopReason = cancelRequested ? "cancelled" : "end_turn";
  if (!cancelRequested) {
    send({ jsonrpc: "2.0", method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake-grok-done" } } } });
  }
  writeFileSync(`${dir}/ended`, JSON.stringify({ stopReason, at: Date.now() }));
  turnInFlight = false;
  send({ jsonrpc: "2.0", method: "_x.ai/session/prompt_complete", params: { stopReason } });
  send({ jsonrpc: "2.0", id, result: { stopReason } });
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  let msg: { id?: unknown; method?: string };
  try { msg = JSON.parse(text); } catch { continue; }

  // session/cancel is a notification: it carries no id and gets no response.
  if (msg.method === "session/cancel") {
    appendFileSync(`${dir}/cancels`, JSON.stringify({ at: Date.now(), turnInFlight }) + "\n");
    if (turnInFlight) cancelRequested = true;
    continue;
  }
  if (msg.id === undefined || msg.id === null) continue;
  const id = msg.id;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "1", authMethods: [{ id: "cached_token" }] } });
  } else if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess-card5332" } });
  } else if (msg.method === "session/prompt") {
    // Not awaited: the reader must keep taking lines (the cancel) while the turn is held.
    void holdTurn(id);
  } else {
    send({ jsonrpc: "2.0", id, result: {} });
  }
}
