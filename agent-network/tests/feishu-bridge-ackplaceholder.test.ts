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
const { createIPCEventHandler, withRateLimit } = bridge as {
  createIPCEventHandler: (
    adapter: unknown,
    ttlMs: number,
    ackPlaceholder: boolean,
  ) => (event: unknown) => Promise<void>;
  withRateLimit: (
    inner: (event: unknown) => Promise<void>,
    adapter: unknown,
  ) => (event: unknown) => Promise<void>;
};
if (typeof createIPCEventHandler !== "function") {
  console.error("[harness] createIPCEventHandler not exported by bridge.ts");
  process.exit(2);
}
if (typeof withRateLimit !== "function") {
  console.error("[harness] withRateLimit not exported by bridge.ts");
  process.exit(2);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockAdapter(
  {
    sendThrowsOnCall = [] as number[],
    allowFrom = [] as string[],
  }: { sendThrowsOnCall?: number[]; allowFrom?: string[] } = {},
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
    // 2026-06-29: bridge's withRateLimit needs to read the current
    // access.allowFrom list to exempt operator-vouched explicit users
    // from the DM flood limit (Vincent's multi-turn heavy work was
    // tripping 3/60s). Test default is [] (no exemption — keeps the
    // pre-existing 16 case behavior identical); tests for the new
    // exemption pass an explicit allowFrom override.
    getAllowFrom(): readonly string[] {
      return allowFrom;
    },
  };
  return adapter;
}

function makeEvent(
  suffix = "1",
  opts: { senderId?: string; chatId?: string; conversationType?: "dm" | "group" } = {},
) {
  const conversationType = opts.conversationType ?? "dm";
  const chatId = opts.chatId ?? "oc_X";
  return {
    platform: "feishu",
    connectionId: "test#feishu",
    conversation: {
      platform: "feishu",
      conversationId: chatId,
      conversationType,
    },
    sender: { id: opts.senderId ?? "ou_Y" },
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
  // PR #335 introduced multi-message dispatch (text + attachments); the
  // text-leg log line now reads "reply text sent" (vs the original
  // "reply sent") to disambiguate from attachment-side outbound logs.
  assert.ok(
    log.includes("reply text sent (messageId=mock-send-2) (after placeholder=mock-send-1)"),
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

// ── Rate-limit cases (Vincent 2026-06-26 wildcard + abuse defense) ──────

await test("10. DM rate limit: 4th event from same sender gets RATE_LIMIT_NOTICE_TEXT, never reaches inner", async () => {
  const adapter = makeMockAdapter();
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  // 3 DM events from same sender — all pass
  for (let i = 1; i <= 3; i++) {
    await wrapped(makeEvent(`dm-${i}`, { senderId: "ou_burst" }));
  }
  assert.equal(innerCalls.length, 3, "first 3 events reach inner");
  assert.equal(adapter.sendCalls.length, 0, "no rate-limit message sent yet");

  // 4th — rate limited
  await wrapped(makeEvent("dm-4", { senderId: "ou_burst" }));
  assert.equal(innerCalls.length, 3, "4th event must NOT reach inner");
  assert.equal(adapter.sendCalls.length, 1, "rate-limit notice sent");
  assert.equal(
    (adapter.sendCalls[0] as { text: string }).text,
    "处理频率超出限制，请稍后重试",
  );
  assert.ok(
    stderrLog.join("").includes("rate-limited (dm) from=ou_burst"),
    "rate-limit stderr log",
  );
});

await test("11. Group rate limit: 3rd event from same chat gets RATE_LIMIT_NOTICE_TEXT", async () => {
  const adapter = makeMockAdapter();
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  // 2 group events from same chat — both pass
  for (let i = 1; i <= 2; i++) {
    await wrapped(
      makeEvent(`grp-${i}`, {
        senderId: `ou_member-${i}`,
        chatId: "oc_room",
        conversationType: "group",
      }),
    );
  }
  assert.equal(innerCalls.length, 2);
  assert.equal(adapter.sendCalls.length, 0);

  // 3rd — rate limited regardless of which sender (group quota is per chat)
  await wrapped(
    makeEvent("grp-3", {
      senderId: "ou_member-3",
      chatId: "oc_room",
      conversationType: "group",
    }),
  );
  assert.equal(innerCalls.length, 2, "3rd group event must NOT reach inner");
  assert.equal(adapter.sendCalls.length, 1);
  assert.equal(
    (adapter.sendCalls[0] as { text: string }).text,
    "处理频率超出限制，请稍后重试",
  );
  assert.ok(stderrLog.join("").includes("rate-limited (group)"));
});

await test("12. different senders / chats keep independent quotas", async () => {
  const adapter = makeMockAdapter();
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  // 3 DMs from sender A — fills A's quota
  for (let i = 1; i <= 3; i++) {
    await wrapped(makeEvent(`a-${i}`, { senderId: "ou_A" }));
  }
  // 1 DM from sender B — B has its own quota, should pass
  await wrapped(makeEvent("b-1", { senderId: "ou_B" }));
  assert.equal(innerCalls.length, 4, "B's first DM should pass despite A's quota full");
  assert.equal(adapter.sendCalls.length, 0, "no rate-limit messages yet");

  // 4th DM from A — rate limited
  await wrapped(makeEvent("a-4", { senderId: "ou_A" }));
  assert.equal(innerCalls.length, 4);
  assert.equal(adapter.sendCalls.length, 1);
});

await test("13. flood audit fires after 3+ rate-limit denies from same sender", async () => {
  const adapter = makeMockAdapter();
  const wrapped = withRateLimit(async () => {}, adapter);

  // Burn DM quota (3 events).
  for (let i = 1; i <= 3; i++) {
    await wrapped(makeEvent(`q-${i}`, { senderId: "ou_flood" }));
  }
  // Trigger 3 rate-limit denies (events 4, 5, 6).
  for (let i = 4; i <= 6; i++) {
    await wrapped(makeEvent(`q-${i}`, { senderId: "ou_flood" }));
  }
  assert.equal(adapter.sendCalls.length, 3, "3 rate-limit notices sent");
  const log = stderrLog.join("");
  // Audit fires when flood count reaches threshold (3).
  assert.ok(
    log.includes("[feishu:audit] flood from=ou_flood"),
    "flood audit must be logged at 3+ denies",
  );
});

await test("14. rate-limit notice send failure logged (not silent)", async () => {
  const adapter = makeMockAdapter({ sendThrowsOnCall: [1] });
  const wrapped = withRateLimit(async () => {}, adapter);
  // Fill DM quota.
  for (let i = 1; i <= 3; i++) {
    await wrapped(makeEvent(`s-${i}`, { senderId: "ou_S" }));
  }
  // Trigger rate-limit; adapter.send throws on first call (the rate-limit notice).
  await wrapped(makeEvent("s-4", { senderId: "ou_S" }));
  const log = stderrLog.join("");
  assert.ok(
    log.includes("rate-limit notice send failed"),
    "send-failure log must surface",
  );
});

await test("16. rate-limit Maps hard cap evicts oldest when sweep can't drop anything (defense-in-depth)", async () => {
  // Simulates a synchronous flood of >10k unique senders inside one window
  // (the worst case the lazy GC can't address — nothing is stale yet).
  // The hard cap should force the oldest entries out until size <= cap.
  const adapter = makeMockAdapter();
  const wrapped = withRateLimit(async () => {}, adapter);

  // Use the real clock — all events land effectively at the same instant,
  // which is exactly the scenario the hard cap is meant for.
  const FLOOD_SIZE = 10_010; // 10 over the cap
  for (let i = 1; i <= FLOOD_SIZE; i++) {
    await wrapped(makeEvent(`f-${i}`, { senderId: `ou_flood-${i}` }));
  }
  const state = wrapped.__getState();
  // The cap enforcement runs at the start of each call, then the call adds
  // its own entry — so steady-state size can transiently sit at cap+1
  // between two arrivals. The spec is bounded growth, not a strict
  // equality at any one instant.
  assert.ok(
    state.dmKeyCount <= 10_001,
    `dmTimes must respect hard cap (≤ cap+1 transient); got ${state.dmKeyCount}`,
  );
  // Sanity: at least most of the 10_010 events were evicted (vs. naïve
  // unbounded growth which would leave size at 10_010).
  assert.ok(
    state.dmKeyCount < 10_010,
    `hard cap must have evicted entries; size remained at ${state.dmKeyCount}`,
  );
});

await test("15. rate-limit Maps lazy-GC stale entries (no unbounded growth on wildcard allowlist) — preview.3 blocker fix", async () => {
  // 通信牛 review 2026-06-26 — without sweep, each unique open_id leaves a
  // Map entry forever. After `allowFrom: ["*"]` opens the bot to the org,
  // unique-sender count is unbounded → memory leak. This case proves the
  // lazy sweep evicts stale entries past the window.
  const adapter = makeMockAdapter();
  const wrapped = withRateLimit(async () => {}, adapter);

  // Mock Date.now to drive the sliding window deterministically.
  const realNow = Date.now;
  let mockNow = realNow();
  // @ts-expect-error — overwriting Date.now for the test
  Date.now = () => mockNow;

  try {
    // 60 unique senders, each 1 DM (under per-sender quota of 3, so each
    // reaches inner). Past the GC threshold of 50, so sweep is eligible.
    for (let i = 1; i <= 60; i++) {
      await wrapped(makeEvent(`u-${i}`, { senderId: `ou_unique-${i}` }));
    }
    let state = wrapped.__getState();
    assert.equal(
      state.dmKeyCount,
      60,
      "no stale entries to sweep yet — Map at 60",
    );
    assert.equal(adapter.sendCalls.length, 0, "no rate-limit messages");

    // Jump past the 60s window — every existing entry is now stale.
    mockNow += 70_000;

    // One more event from a brand-new sender. The lazy sweep at the top of
    // the call should evict all 60 stale entries; only the new sender's
    // single timestamp remains.
    await wrapped(makeEvent("u-61", { senderId: "ou_unique-61" }));
    state = wrapped.__getState();
    assert.equal(
      state.dmKeyCount,
      1,
      "sweep must have evicted all stale entries; only the fresh sender remains",
    );
  } finally {
    // @ts-expect-error — restore real Date.now
    Date.now = realNow;
  }
});

// ── allowFrom-explicit DM exemption (2026-06-29 Vincent flood-limit catch) ──

await test("17. DM rate limit exempts sender on access.allowFrom explicit list (Vincent flood-limit fix)", async () => {
  // Vincent's open_id is on the access.json allowFrom explicit list. He
  // does multi-turn heavy work (each turn 20-70s) and was tripping the
  // 3-msg/60s DM limit. Explicit-listed users are operator-vouched and
  // should NOT be flood-limited.
  const VINCENT_OID = "ou_vincent_explicit";
  const adapter = makeMockAdapter({ allowFrom: [VINCENT_OID, "ou_someone_else"] });
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  // 10 DM events from Vincent — all must pass (no limit applied)
  for (let i = 1; i <= 10; i++) {
    await wrapped(makeEvent(`vincent-${i}`, { senderId: VINCENT_OID }));
  }
  assert.equal(innerCalls.length, 10, "all 10 explicit-allow events reached inner");

  // No rate-limit notice was sent (no `RATE_LIMIT_NOTICE_TEXT` in adapter.send)
  const sentTexts = adapter.sendCalls.map((c) => (c as { text?: string }).text);
  assert.equal(
    sentTexts.filter((t) => t && t.includes("超出限制")).length,
    0,
    "explicit-allow user never sees rate-limit notice",
  );

  // dmTimes Map remains empty for Vincent (he skipped the limit machinery)
  const state = wrapped.__getState();
  assert.equal(state.dmKeyCount, 0, "explicit-allow path bypasses dmTimes Map writes");
});

await test("18. wildcard allowFrom=['*'] does NOT exempt (public channel still rate-limited)", async () => {
  // The public-channel shape `allowFrom: ["*"]` accepts any open_id but
  // does NOT vouch for any specific user — flood protection MUST still
  // apply (otherwise a public bot is an instant abuse vector).
  const adapter = makeMockAdapter({ allowFrom: ["*"] });
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  for (let i = 1; i <= 5; i++) {
    await wrapped(makeEvent(`pub-${i}`, { senderId: "ou_anyone" }));
  }
  assert.equal(
    innerCalls.length,
    3,
    "public-wildcard channel still applies DM_RATE_LIMIT_COUNT=3",
  );
  // 4th + 5th events trigger the notice send
  const notices = adapter.sendCalls
    .map((c) => (c as { text?: string }).text)
    .filter((t) => t && t.includes("超出限制"));
  assert.equal(notices.length, 2, "wildcard sender sees rate-limit notice on 4th + 5th");
});

await test("19. Group rate limit applies even for allowFrom-explicit user (group-side gate by chat)", async () => {
  // Group conversations gate by chat_id (not sender), so an exemption
  // would let one user starve the group. Explicit allowFrom does NOT
  // bypass group-side rate-limit; this test locks the boundary.
  const VINCENT_OID = "ou_vincent_explicit";
  const adapter = makeMockAdapter({ allowFrom: [VINCENT_OID] });
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  for (let i = 1; i <= 4; i++) {
    await wrapped(
      makeEvent(`grp-${i}`, {
        senderId: VINCENT_OID,
        chatId: "oc_shared_group",
        conversationType: "group",
      }),
    );
  }
  assert.equal(
    innerCalls.length,
    2,
    "group still applies GROUP_RATE_LIMIT_COUNT=2 even for allowFrom-explicit sender",
  );
});

await test("20. allowFrom=[] (no explicit list, no wildcard) treats every DM sender as non-exempt", async () => {
  // Edge: access.json with empty allowFrom (initial state before operator
  // configures). Every DM sender is non-exempt — matches the pre-2026-06-29
  // behavior, so no regression for not-yet-configured channels.
  const adapter = makeMockAdapter({ allowFrom: [] });
  const innerCalls: string[] = [];
  const inner = async (e: { idempotencyKey: string }) =>
    void innerCalls.push(e.idempotencyKey);
  const wrapped = withRateLimit(inner, adapter);

  for (let i = 1; i <= 5; i++) {
    await wrapped(makeEvent(`empty-${i}`, { senderId: "ou_any" }));
  }
  assert.equal(innerCalls.length, 3, "empty allowFrom: DM limit still applies");
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
