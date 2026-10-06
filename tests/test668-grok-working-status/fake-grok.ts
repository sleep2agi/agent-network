#!/usr/bin/env bun
// Stand-in for `grok`. Speaks just enough ACP for one held turn.
// It does not spawn MCP servers and it does not read the prompt.

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("grok 0.0.0-fake\n");
  process.exit(0);
}

const holdDir = process.env.GROK_FAKE_HOLD_DIR || "/tmp/grok-fake-hold";
mkdirSync(holdDir, { recursive: true });

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  let msg: { id?: unknown; method?: string };
  try {
    msg = JSON.parse(text);
  } catch {
    continue;
  }
  if (msg.id === undefined || msg.id === null) continue;
  const id = msg.id;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "1", authMethods: [{ id: "cached_token" }] },
    });
    continue;
  }
  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id, result: {} });
    continue;
  }
  if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess-board668" } });
    continue;
  }
  if (msg.method === "session/prompt") {
    writeFileSync(`${holdDir}/holding`, "1");
    while (!existsSync(`${holdDir}/release`)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fake-grok-done" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session/prompt_complete",
      params: { stopReason: "end_turn" },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    continue;
  }
  send({ jsonrpc: "2.0", id, result: {} });
}
