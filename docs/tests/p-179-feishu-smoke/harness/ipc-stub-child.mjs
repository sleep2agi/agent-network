#!/usr/bin/env node
// L9/L10 IPC stub child — simulates the bridge worker's side of the IPC
// protocol contract (mirrors agent-network/src/im/feishu/bridge.ts).
//
// Contract reference (bridge.ts):
//   interface BridgeIncomingEnvelope { type: "event"; event: NormalizedIMEvent }
//   interface BridgeReplyEnvelope    { type: "reply"; eventKey: string; text: string }
//
// Behaviour:
//   1. On startup, emits a fake `{type:"event"}` upstream with a fixed
//      idempotencyKey.
//   2. Listens for `{type:"reply"}` from parent.
//   3. Verifies: eventKey === sent idempotencyKey AND text non-empty AND
//      text doesn't match known placeholder ("ack" / "[placeholder]" / "").
//   4. Exits 0 on PASS, 1 on FAIL, 2 on timeout.
//
// The parent is /ipc-roundtrip-test.mjs.

if (typeof process.send !== "function") {
  console.error("[stub-child] not forked with IPC channel (process.send unavailable)");
  process.exit(1);
}

const SENT_IDEMPOTENCY_KEY = "test-idem-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
const PLACEHOLDER_TEXTS = ["", "ack", "[placeholder]", "[ack]", "[agent-node 占位]", "M5a 占位"];

let received = false;

process.on("message", (raw) => {
  const r = raw && typeof raw === "object" ? raw : null;
  if (!r || r.type !== "reply") {
    console.error(`[stub-child] received non-reply: ${JSON.stringify(raw)}`);
    return;
  }
  received = true;
  const eventKey = r.eventKey;
  const text = r.text;

  const failures = [];
  if (typeof eventKey !== "string" || eventKey !== SENT_IDEMPOTENCY_KEY) {
    failures.push(`eventKey mismatch — expected="${SENT_IDEMPOTENCY_KEY}" got="${eventKey}"`);
  }
  if (typeof text !== "string" || text.length === 0) {
    failures.push(`text empty or non-string: ${JSON.stringify(text)}`);
  }
  if (PLACEHOLDER_TEXTS.includes(text)) {
    failures.push(`text is a known placeholder: "${text}"`);
  }

  if (failures.length === 0) {
    console.log("[stub-child] PASS — reply has correct eventKey echo + non-placeholder text");
    console.log(`[stub-child]   eventKey: ${eventKey}`);
    console.log(`[stub-child]   text:     ${text}`);
    process.exit(0);
  } else {
    console.error("[stub-child] FAIL — assertion failures:");
    for (const f of failures) console.error(`[stub-child]   - ${f}`);
    process.exit(1);
  }
});

// Send the simulated inbound event upstream. Shape mirrors NormalizedIMEvent
// (only the fields parent uses — minimal stub).
const fakeEvent = {
  idempotencyKey: SENT_IDEMPOTENCY_KEY,
  platform: "feishu",
  sender: { id: "ou_test_sender_open_id" },
  conversation: { conversationType: "p2p", conversationId: "p2p_test_chat" },
  content: { text: "你好，这是 L9/L10 mock IPC 测试事件" },
  messageId: "om_test_message_" + Date.now(),
  mentioned: false,
  receivedAt: Date.now(),
};
const envelope = { type: "event", event: fakeEvent };
console.log(`[stub-child] sending envelope upstream: idempotencyKey=${SENT_IDEMPOTENCY_KEY}`);
process.send(envelope);

// Timeout: parent has 6s to reply
setTimeout(() => {
  if (!received) {
    console.error(`[stub-child] TIMEOUT — no reply received in 6s for eventKey=${SENT_IDEMPOTENCY_KEY}`);
    process.exit(2);
  }
}, 6000);
