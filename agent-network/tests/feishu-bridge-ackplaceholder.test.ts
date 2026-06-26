#!/usr/bin/env node
// Test harness for the Feishu bridge ackPlaceholder + edit-fallback paths.
// Validates the "real user path" through createIPCEventHandler that
// commhub_send_task cannot exercise (commhub bypasses the bridge entirely).
//
// Covers per 通信牛 review 2026-06-26:
//   1. Happy path: placeholder send → reply IPC → adapter.edit replaces it.
//   2. 必改1: placeholder + reply edit FAILS → fallback adapter.send fires
//      (no lost reply, no orphan "⏳ 处理中…").
//   3. Placeholder send fails → reply IPC → adapter.send fallback fires
//      (no edit attempt; user sees the reply as a new message).
//   4. ackPlaceholder=false → no placeholder send → reply IPC → adapter.send.
//   5. TTL expiry with placeholder → adapter.edit timeout notice.
//   6. 必改2: TTL expiry with placeholder + edit FAILS → fallback adapter.send
//      timeout notice (no orphan placeholder).
//   7. TTL expiry without placeholder → adapter.send timeout notice.
//   8. Concurrent multiple events → each tracked independently (no cross-talk).
//   9. Pending Map cleanup: after reply, the entry is evicted (a second
//      reply with the same eventKey is a no-op).
//
// Usage:
//   cd agent-network
//   npm run build       # produces dist/src/im/feishu/bridge.js (worker bundle)
//   node tests/feishu-bridge-ackplaceholder.test.mjs
//
// Exits with non-zero status on any failure (CI gate).

import { strict as assert } from "node:assert";

// process.send must be a function for createIPCEventHandler to take the IPC
// branch. Stub BEFORE the dynamic import so the module-level guards
// (typeof process.send === "function") see it.
const sentEnvelopes: unknown[] = [];
// @ts-expect-error — test stub overrides node's ChildProcess.send signature
process.send = (msg: unknown) => {
  sentEnvelopes.push(msg);
  return true;
};

// Source import — bun handles .ts directly, no build required.
const bridge = await import("../src/im/feishu/bridge.js");
const { createIPCEventHandler } = bridge as {
  createIPCEventHandler: (
    adapter: unknown,
    ttlMs: number,
    ackPlaceholder: boolean,
  ) => (event: unknown) => Promise<void>;
};
if (typeof createIPCEventHandler !== "function") {
  console.error("[harness] createIPCEventHandler not exported by bridge.ts");
  process.exit(2);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockAdapter({
  sendThrowsOnce = false,
  sendAlwaysThrows = false,
  editThrowsOnce = false,
  editAlwaysThrows = false,
} = {}) {
  const sendCalls = [];
  const editCalls = [];
  let sendThrowCounter = sendThrowsOnce ? 1 : 0;
  let editThrowCounter = editThrowsOnce ? 1 : 0;
  const adapter = {
    sendCalls,
    editCalls,
    async send(message) {
      sendCalls.push(message);
      if (sendAlwaysThrows) {
        throw new Error("mock adapter.send always-throws");
      }
      if (sendThrowCounter > 0) {
        sendThrowCounter--;
        throw new Error("mock adapter.send throws-once");
      }
      return { messageId: `mock-send-${sendCalls.length}` };
    },
    async edit(target, messageId, message) {
      editCalls.push({ target, messageId, message });
      if (editAlwaysThrows) {
        throw new Error("mock adapter.edit always-throws");
      }
      if (editThrowCounter > 0) {
        editThrowCounter--;
        throw new Error("mock adapter.edit throws-once");
      }
    },
  };
  return adapter;
}

function makeEvent(suffix = "1") {
  return {
    platform: "feishu",
    connectionId: "test#feishu",
    conversation: {
      platform: "feishu",
      conversationId: "oc_X",
      conversationType: "dm",
    },
    sender: { id: "ou_Y" },
    messageId: `om_${suffix}`,
    mentioned: false,
    content: { text: `hi ${suffix}` },
    receivedAt: 1,
    idempotencyKey: `feishu:test#feishu:om_${suffix}`,
  };
}

function triggerReply(eventKey, text) {
  process.emit("message", { type: "reply", eventKey, text });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  // Two ticks to let the void-async branches inside listeners resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// Capture stderr writes for assertions (the bridge uses stderr for all
// outcome logging). Replace process.stderr.write so test output stays clean.
const stderrLog = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
  stderrLog.push(typeof chunk === "string" ? chunk : chunk.toString());
  return true;
};

// ── Test runner ────────────────────────────────────────────────────────────

let total = 0;
let pass = 0;
const failures = [];

async function test(name, fn) {
  total++;
  // Reset per-test global state.
  sentEnvelopes.length = 0;
  stderrLog.length = 0;
  process.removeAllListeners("message");
  try {
    await fn();
    pass++;
    originalStderrWrite(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    originalStderrWrite(`  ✗ ${name}\n      ${err?.stack || err?.message || err}\n`);
  }
}

// ── Cases ──────────────────────────────────────────────────────────────────

await test("1. happy path: placeholder → reply → edit replaces", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, /*ackPlaceholder*/ true);
  const evt = makeEvent("1");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder send must have fired");
  assert.equal(adapter.sendCalls[0].text, "⏳ 处理中…");
  assert.equal(sentEnvelopes.length, 1, "IPC envelope must be sent to parent");
  assert.equal(sentEnvelopes[0].type, "event");

  triggerReply(evt.idempotencyKey, "real reply");
  await flush();

  assert.equal(adapter.editCalls.length, 1, "reply must trigger edit (placeholder present)");
  assert.equal(adapter.editCalls[0].messageId, "mock-send-1");
  assert.equal(adapter.editCalls[0].message.text, "real reply");
  assert.equal(adapter.sendCalls.length, 1, "no extra send after edit");
  assert.ok(stderrLog.join("").includes("reply edited (placeholder=mock-send-1)"));
});

await test("2. 必改1: edit fails → fallback adapter.send fires", async () => {
  const adapter = makeMockAdapter({ editAlwaysThrows: true });
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("2");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder send fires");

  triggerReply(evt.idempotencyKey, "real reply 2");
  await flush();

  assert.equal(adapter.editCalls.length, 1, "edit was attempted");
  assert.equal(adapter.sendCalls.length, 2, "fallback send must have fired after edit failed");
  assert.equal(adapter.sendCalls[1].text, "real reply 2");
  const log = stderrLog.join("");
  assert.ok(log.includes("reply edit failed"), "edit-failure log must be present");
  assert.ok(log.includes("reply sent"), "fallback send-success log must be present");
});

await test("3. placeholder send fails → reply → fallback send (no edit attempt)", async () => {
  const adapter = makeMockAdapter({ sendThrowsOnce: true });
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("3");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder send was attempted");
  assert.ok(stderrLog.join("").includes("placeholder send failed"));

  triggerReply(evt.idempotencyKey, "real reply 3");
  await flush();

  assert.equal(adapter.editCalls.length, 0, "no edit because no placeholderMessageId");
  assert.equal(adapter.sendCalls.length, 2, "reply send fires");
  assert.equal(adapter.sendCalls[1].text, "real reply 3");
});

await test("4. ackPlaceholder=false → no placeholder; reply → adapter.send", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, /*ackPlaceholder*/ false);
  const evt = makeEvent("4");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 0, "no placeholder send when disabled");

  triggerReply(evt.idempotencyKey, "real reply 4");
  await flush();

  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 1, "reply send fires (new message)");
  assert.equal(adapter.sendCalls[0].text, "real reply 4");
});

await test("5. TTL with placeholder → edit timeout notice", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 50, true);
  const evt = makeEvent("5");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder send");
  await wait(80);
  assert.equal(adapter.editCalls.length, 1, "TTL must edit placeholder");
  assert.equal(adapter.editCalls[0].message.text, "[处理超时，任务可能仍在后台运行]");
  assert.equal(adapter.sendCalls.length, 1, "no extra send");
});

await test("6. 必改2: TTL with placeholder + edit fails → fallback send", async () => {
  const adapter = makeMockAdapter({ editAlwaysThrows: true });
  const onEvent = createIPCEventHandler(adapter, 50, true);
  const evt = makeEvent("6");
  await onEvent(evt);
  await wait(80);
  assert.equal(adapter.editCalls.length, 1, "TTL edit attempted");
  assert.equal(adapter.sendCalls.length, 2, "fallback send fires after edit failure");
  assert.equal(adapter.sendCalls[1].text, "[处理超时，任务可能仍在后台运行]");
  const log = stderrLog.join("");
  assert.ok(log.includes("timeout edit failed"));
  assert.ok(log.includes("timeout-notify sent"));
});

await test("7. TTL without placeholder → adapter.send", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 50, /*ackPlaceholder*/ false);
  const evt = makeEvent("7");
  await onEvent(evt);
  await wait(80);
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 1, "single timeout-notify send");
  assert.equal(adapter.sendCalls[0].text, "[处理超时，任务可能仍在后台运行]");
});

await test("8. concurrent events tracked independently", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const e1 = makeEvent("8a");
  const e2 = makeEvent("8b");
  await Promise.all([onEvent(e1), onEvent(e2)]);
  assert.equal(adapter.sendCalls.length, 2, "two placeholder sends");
  assert.equal(sentEnvelopes.length, 2, "two IPC envelopes");

  // Reply to second event first — must edit the correct placeholder.
  triggerReply(e2.idempotencyKey, "reply 8b");
  await flush();
  assert.equal(adapter.editCalls.length, 1);
  // Placeholder messageId for e2 is "mock-send-2" (second send call).
  assert.equal(adapter.editCalls[0].messageId, "mock-send-2");
  assert.equal(adapter.editCalls[0].message.text, "reply 8b");

  // Reply to first.
  triggerReply(e1.idempotencyKey, "reply 8a");
  await flush();
  assert.equal(adapter.editCalls.length, 2);
  assert.equal(adapter.editCalls[1].messageId, "mock-send-1");
  assert.equal(adapter.editCalls[1].message.text, "reply 8a");
});

await test("9. pending evicted after reply (duplicate reply is no-op)", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("9");
  await onEvent(evt);
  triggerReply(evt.idempotencyKey, "reply 9");
  await flush();
  assert.equal(adapter.editCalls.length, 1);

  // Send the same reply again — must be a no-op (pending already evicted).
  triggerReply(evt.idempotencyKey, "reply 9 again");
  await flush();
  assert.equal(adapter.editCalls.length, 1, "duplicate reply must not trigger another edit");
  assert.equal(adapter.sendCalls.length, 1, "no extra send either");
});

// ── Summary ────────────────────────────────────────────────────────────────

originalStderrWrite(
  `\nfeishu-bridge-ackplaceholder.test: ${pass}/${total} passed\n`,
);
if (failures.length > 0) {
  originalStderrWrite(`\nFailures:\n`);
  for (const f of failures) {
    originalStderrWrite(`  - ${f.name}: ${f.err?.message || f.err}\n`);
  }
  process.exit(1);
}
process.exit(0);
