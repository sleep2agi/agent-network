#!/usr/bin/env node
// L9/L10 IPC round-trip test parent — simulates agent-node's role.
//
// Forks /ipc-stub-child.mjs which emits a fake `{type:"event"}`.
// Acts as a mock processTask() → replies with non-placeholder text echoing
// eventKey === idempotencyKey.
//
// Exits with child's exit code.
import { fork } from "node:child_process";

const child = fork("/ipc-stub-child.mjs", [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

child.on("message", (raw) => {
  const r = raw && typeof raw === "object" ? raw : null;
  if (!r || r.type !== "event") {
    console.error(`[parent] received non-event: ${JSON.stringify(raw)}`);
    return;
  }
  const ev = r.event;
  console.log(`[parent] received event idempotencyKey=${ev.idempotencyKey} text="${ev.content?.text ?? ""}"`);

  // Mock processTask() — synthesize a REAL reply (non-placeholder) that
  // mimics what think() would produce given the event.text input.
  const mockThinkReply = `回复: 已收到 "${(ev.content?.text || "").slice(0, 50)}" — 这是 L9/L10 真 think() mock 回复, 非占位.`;

  // Send back with eventKey === idempotencyKey (the canonical echo).
  const reply = {
    type: "reply",
    eventKey: ev.idempotencyKey,
    text: mockThinkReply,
  };
  console.log(`[parent] sending reply eventKey=${reply.eventKey} text="${reply.text.slice(0, 60)}..."`);
  child.send(reply);
});

child.on("exit", (code, signal) => {
  console.log(`[parent] child exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`[parent] child error: ${err?.message ?? err}`);
  process.exit(1);
});
