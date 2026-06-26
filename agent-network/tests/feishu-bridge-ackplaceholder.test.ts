#!/usr/bin/env node
// Test harness for the Feishu bridge ackPlaceholder + new-reply-message
// design (Vincent 2026-06-26: no edit-in-place — every final reply is a
// brand-new in-thread message so the user gets a second push notification).
//
// Locks in:
//   - adapter.edit is NEVER called from the IPC path (editCalls.length === 0
//     in every case). adapter.edit stays on the IMAdapter surface but is
//     reserved for future use.
//   - placeholder still fires on event arrival when ackPlaceholder=true.
//   - reply / timeout always go through adapter.send.
//
// Cases:
//   1. Happy path: placeholder send → reply IPC → reply send (new message).
//   2. Reply send fails (after placeholder) → "reply delivery failed" log,
//      no retry (pending was evicted; matches the IPC contract).
//   3. Placeholder send fails → reply IPC → reply send still fires.
//   4. ackPlaceholder=false → no placeholder; reply IPC → reply send.
//   5. TTL expiry with placeholder → timeout-notify send (new message).
//   6. TTL timeout-notify send fails → "timeout-notify send failed" log.
//   7. TTL expiry without placeholder → timeout-notify send.
//   8. Concurrent multiple events → tracked independently (no cross-talk).
//   9. Pending Map cleanup: duplicate reply is a no-op after the first wins.
//
// Usage (bun runs .ts natively — no build step):
//   cd agent-network
//   npm run test:feishu-bridge
//   # = bun tests/feishu-bridge-ackplaceholder.test.ts
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

function makeMockAdapter(
  {
    sendThrowsOnCall = [] as number[],
  }: { sendThrowsOnCall?: number[] } = {},
) {
  const sendCalls: unknown[] = [];
  const editCalls: unknown[] = [];
  const adapter = {
    sendCalls,
    editCalls,
    async send(message: { text?: string }) {
      sendCalls.push(message);
      if (sendThrowsOnCall.includes(sendCalls.length)) {
        throw new Error(`mock adapter.send throws on call #${sendCalls.length}`);
      }
      return { messageId: `mock-send-${sendCalls.length}` };
    },
    // adapter.edit stays on the interface but should NEVER be called by the
    // current bridge logic. Any call here is a regression for Vincent's
    // 2026-06-26 design lock.
    async edit(target: unknown, messageId: string, message: unknown) {
      editCalls.push({ target, messageId, message });
      throw new Error(
        "REGRESSION: adapter.edit was called — Vincent 2026-06-26 design lock requires reply/timeout to send NEW messages, never edit",
      );
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

await test("1. happy path: placeholder send → reply IPC → reply send (new message)", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, /*ackPlaceholder*/ true);
  const evt = makeEvent("1");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder send fires first");
  assert.equal((adapter.sendCalls[0] as { text: string }).text, "⏳ 处理中…");
  assert.equal(sentEnvelopes.length, 1, "IPC envelope sent to parent");

  triggerReply(evt.idempotencyKey, "real reply");
  await flush();

  assert.equal(adapter.editCalls.length, 0, "design lock — no edit-in-place");
  assert.equal(adapter.sendCalls.length, 2, "reply must be a NEW send, not an edit");
  assert.equal((adapter.sendCalls[1] as { text: string }).text, "real reply");
  const log = stderrLog.join("");
  assert.ok(log.includes("placeholder sent (messageId=mock-send-1)"));
  assert.ok(
    log.includes("reply sent (messageId=mock-send-2) (after placeholder=mock-send-1)"),
    "reply log must include 'after placeholder' note",
  );
});

await test("2. reply send fails (after placeholder) → 'reply delivery failed' logged, no retry", async () => {
  const adapter = makeMockAdapter({ sendThrowsOnCall: [2] });
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("2");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder ok");

  triggerReply(evt.idempotencyKey, "doomed reply");
  await flush();

  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 2, "reply send attempted (and threw)");
  const log = stderrLog.join("");
  assert.ok(log.includes("reply delivery failed"), "failure must be logged");
  assert.ok(
    !log.includes("reply sent (messageId=mock-send-2)"),
    "no success log when send threw",
  );
});

await test("3. placeholder send fails → reply IPC → reply send still fires", async () => {
  const adapter = makeMockAdapter({ sendThrowsOnCall: [1] });
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("3");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder attempted (and threw)");
  assert.ok(stderrLog.join("").includes("placeholder send failed"));

  triggerReply(evt.idempotencyKey, "real reply 3");
  await flush();

  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 2, "reply send still fires");
  assert.equal((adapter.sendCalls[1] as { text: string }).text, "real reply 3");
  // No placeholderMessageId on the pending entry, so the log line should
  // NOT include "(after placeholder=...)".
  assert.ok(
    !stderrLog.join("").includes("after placeholder="),
    "reply log must omit the placeholder note when placeholder failed",
  );
});

await test("4. ackPlaceholder=false → no placeholder; reply IPC → reply send", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, /*ackPlaceholder*/ false);
  const evt = makeEvent("4");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 0, "no placeholder send when disabled");

  triggerReply(evt.idempotencyKey, "real reply 4");
  await flush();

  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 1, "reply send fires");
  assert.equal((adapter.sendCalls[0] as { text: string }).text, "real reply 4");
});

await test("5. TTL with placeholder → timeout-notify send (new message)", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 50, true);
  const evt = makeEvent("5");
  await onEvent(evt);
  assert.equal(adapter.sendCalls.length, 1, "placeholder ok");
  await wait(80);
  assert.equal(adapter.editCalls.length, 0, "no edit even on TTL");
  assert.equal(adapter.sendCalls.length, 2, "timeout-notify must be a new send");
  assert.equal(
    (adapter.sendCalls[1] as { text: string }).text,
    "[处理超时，任务可能仍在后台运行]",
  );
  assert.ok(
    stderrLog.join("").includes("timeout-notify sent (after placeholder=mock-send-1)"),
  );
});

await test("6. TTL timeout-notify send fails → 'timeout-notify send failed' logged", async () => {
  const adapter = makeMockAdapter({ sendThrowsOnCall: [2] });
  const onEvent = createIPCEventHandler(adapter, 50, true);
  const evt = makeEvent("6");
  await onEvent(evt);
  await wait(80);
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 2, "TTL send attempted (and threw)");
  assert.ok(stderrLog.join("").includes("timeout-notify send failed"));
});

await test("7. TTL without placeholder → timeout-notify send", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 50, /*ackPlaceholder*/ false);
  const evt = makeEvent("7");
  await onEvent(evt);
  await wait(80);
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 1, "single timeout-notify send");
  assert.equal(
    (adapter.sendCalls[0] as { text: string }).text,
    "[处理超时，任务可能仍在后台运行]",
  );
});

await test("8. concurrent events tracked independently", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const e1 = makeEvent("8a");
  const e2 = makeEvent("8b");
  await Promise.all([onEvent(e1), onEvent(e2)]);
  assert.equal(adapter.sendCalls.length, 2, "two placeholder sends");
  assert.equal(sentEnvelopes.length, 2, "two IPC envelopes");

  // Reply to second event first.
  triggerReply(e2.idempotencyKey, "reply 8b");
  await flush();
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 3, "e2 reply send fired");
  assert.equal((adapter.sendCalls[2] as { text: string }).text, "reply 8b");

  // Then the first.
  triggerReply(e1.idempotencyKey, "reply 8a");
  await flush();
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 4, "e1 reply send fired");
  assert.equal((adapter.sendCalls[3] as { text: string }).text, "reply 8a");
});

await test("9. pending evicted after reply (duplicate reply is no-op)", async () => {
  const adapter = makeMockAdapter();
  const onEvent = createIPCEventHandler(adapter, 10_000, true);
  const evt = makeEvent("9");
  await onEvent(evt);
  triggerReply(evt.idempotencyKey, "reply 9");
  await flush();
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 2, "placeholder + reply send");

  // Send the same reply again — pending was evicted by the first reply.
  triggerReply(evt.idempotencyKey, "reply 9 again");
  await flush();
  assert.equal(adapter.editCalls.length, 0);
  assert.equal(adapter.sendCalls.length, 2, "duplicate reply must not trigger another send");
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
