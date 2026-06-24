#!/usr/bin/env node
/* R2.3 必改3 — TTL expiry sends "[处理超时…]" notice, no silent drop
 *
 * MIRROR of bridge.ts createIPCEventHandler timeout branch (lines ~145-215).
 * Tests the documented spec with a mock adapter (FeishuAdapter is fork-only;
 * real connect needs creds, so we mirror the pending-map + setTimeout logic
 * here and exercise it with the SAME contract).
 *
 * Spec (from bridge.ts):
 *   - On event arrival, set `pending.set(idempotencyKey, event)` + schedule
 *     setTimeout(ttlMs) for expiry-notify.
 *   - On parent reply via process.on('message'): pending.delete(eventKey) +
 *     adapter.send(text); setTimeout fires later but finds entry missing →
 *     no-op (early return).
 *   - On expiry without reply: pending.delete + adapter.send("[处理超时…]")
 *     to the originating conversation. Never silent.
 *   - TTL bound to channelConfig.taskTimeoutMs (default 15 min in bridge.ts:70).
 *
 * Test uses a short TTL (200ms) for time-bounded execution. The
 * spec-critical behaviour — "no silent drop, user gets [处理超时…]" — is
 * orthogonal to the actual ttl value.
 */

const TIMEOUT_TEXT = "[处理超时，任务可能仍在后台运行]";
const TTL_MS = 200;

// Mock adapter — captures .send calls (mirrors FeishuAdapter contract surface)
const sentMessages = [];
const mockAdapter = {
  send: async (opts) => {
    sentMessages.push(opts);
    console.log(`  mockAdapter.send invoked: text=${JSON.stringify(opts.text?.slice(0, 50))} target=${JSON.stringify(opts.target)} correlation.taskId=${opts.correlation?.taskId}`);
  },
};

// === Mirror of bridge.ts createIPCEventHandler — keep in sync with bridge.ts:145-215 ===
function createIPCEventHandler(adapter, ttlMs) {
  const pending = new Map();

  // Simulate "parent reply arrived" message handler — call sendReply() to invoke
  function sendReply(rawEnvelope) {
    if (rawEnvelope?.type !== "reply") return;
    const event = pending.get(rawEnvelope.eventKey);
    if (!event) return;
    pending.delete(rawEnvelope.eventKey);
    void adapter.send({
      target: event.conversation,
      text: rawEnvelope.text,
      replyToMessageId: event.messageId,
      correlation: { taskId: rawEnvelope.eventKey },
    });
  }

  const handler = async (event) => {
    pending.set(event.idempotencyKey, event);
    setTimeout(() => {
      if (!pending.has(event.idempotencyKey)) return;
      pending.delete(event.idempotencyKey);
      void adapter.send({
        target: event.conversation,
        text: TIMEOUT_TEXT,
        replyToMessageId: event.messageId,
        correlation: { taskId: event.idempotencyKey },
      });
    }, ttlMs);
  };
  return { handler, sendReply, getPendingSize: () => pending.size };
}

const ipc = createIPCEventHandler(mockAdapter, TTL_MS);

// Case A: event arrives, NO reply, ttl fires → expect "[处理超时…]" sent
const eventA = {
  idempotencyKey: "test-timeout-A",
  conversation: { conversationType: "p2p", conversationId: "p2p_test_A" },
  sender: { id: "ou_sender_A" },
  content: { text: "slow task" },
  messageId: "msg_A",
};
await ipc.handler(eventA);

// Case B: event arrives, reply BEFORE ttl → expect reply text sent, NOT timeout
const eventB = {
  idempotencyKey: "test-timeout-B",
  conversation: { conversationType: "p2p", conversationId: "p2p_test_B" },
  sender: { id: "ou_sender_B" },
  content: { text: "fast task" },
  messageId: "msg_B",
};
await ipc.handler(eventB);
// Reply for B arrives quickly (50ms < 200ms TTL)
setTimeout(() => {
  ipc.sendReply({ type: "reply", eventKey: "test-timeout-B", text: "fast reply text" });
}, 50);

// Wait for both ttls to settle + cleanup
await new Promise((r) => setTimeout(r, 400));

// Assertions
const failures = [];
const aMsg = sentMessages.find(m => m.correlation?.taskId === "test-timeout-A");
const bMsg = sentMessages.find(m => m.correlation?.taskId === "test-timeout-B");

// Case A: expect timeout text
if (!aMsg) failures.push("Case A — no adapter.send was called for eventA (expected timeout-notify)");
else if (aMsg.text !== TIMEOUT_TEXT) failures.push(`Case A — adapter.send text was "${aMsg.text}" expected "${TIMEOUT_TEXT}"`);

// Case B: expect reply text (not timeout)
if (!bMsg) failures.push("Case B — no adapter.send was called for eventB (expected reply)");
else if (bMsg.text === TIMEOUT_TEXT) failures.push("Case B — adapter.send sent timeout-notify but reply arrived in time (should be reply text)");
else if (bMsg.text !== "fast reply text") failures.push(`Case B — adapter.send text was "${bMsg.text}" expected "fast reply text"`);

// Case A: not silent drop (must have been called at least)
if (sentMessages.filter(m => m.correlation?.taskId === "test-timeout-A").length === 0) {
  failures.push("Case A — SILENT DROP (no adapter.send invocation) — necessitates fix");
}

console.log(`R2.3_RESULT={"total_sends":${sentMessages.length},"a_sent":${!!aMsg},"a_was_timeout":${aMsg?.text === TIMEOUT_TEXT},"b_sent":${!!bMsg},"b_was_reply":${bMsg?.text === "fast reply text"},"failures":${failures.length}}`);

if (failures.length === 0) {
  console.log("✓ R2.3 PASS — timeout-notify fires when no reply, reply takes precedence when in-time");
  process.exit(0);
} else {
  console.error("✗ R2.3 FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
