#!/usr/bin/env node
/* R2.2 dedup — same idempotencyKey 2x within DEDUP_WINDOW_MS → 2nd dropped
 *
 * MIRROR of bridge.ts:110-132 `withDedup` (module-internal, not exported).
 * Tests the documented spec end-to-end against the SAME logic shape.
 *
 * Spec (from bridge.ts):
 *   - Wrap an `onEvent(event)` handler.
 *   - Maintain a Map<idempotencyKey, ts>.
 *   - If key already in map and not aged out → drop (only inner handler
 *     does NOT fire); stderr "dedup drop <key>".
 *   - Else set key + ts; invoke inner.
 *   - GC at size>200 sweep aged entries.
 *
 * DEDUP_WINDOW_MS = 2 * 60 * 1000 (bridge.ts:74).
 */

const DEDUP_WINDOW_MS = 2 * 60 * 1000;

// === Mirror — keep in sync with agent-network/src/im/feishu/bridge.ts:110-132 ===
function withDedup(inner) {
  const seen = new Map();
  return async (event) => {
    const now = Date.now();
    if (seen.size > 200) {
      for (const [k, ts] of seen) {
        if (now - ts > DEDUP_WINDOW_MS) seen.delete(k);
      }
    }
    if (seen.has(event.idempotencyKey)) {
      process.stderr.write(`[mirror] dedup drop ${event.idempotencyKey}\n`);
      return;
    }
    seen.set(event.idempotencyKey, now);
    await inner(event);
  };
}

let invocations = 0;
const inner = async (event) => {
  invocations++;
  console.log(`  inner called: idempotencyKey=${event.idempotencyKey} invocations=${invocations}`);
};
const wrapped = withDedup(inner);

const event = {
  idempotencyKey: "test-dedup-key-fixed-001",
  conversation: { conversationType: "p2p", conversationId: "p2p_test" },
  sender: { id: "ou_test_sender" },
  content: { text: "hello" },
  messageId: "msg_001",
  mentioned: false,
};

await wrapped(event); // 1st
await wrapped(event); // 2nd (same key) — should be dropped
await wrapped(event); // 3rd (same key) — should also be dropped

const otherEvent = { ...event, idempotencyKey: "test-dedup-key-different-002" };
await wrapped(otherEvent); // 4th (different key) — should fire

const expected = 2; // 1st event + different-key event
const actual = invocations;

console.log(`R2.2_RESULT={"expected_invocations":${expected},"actual_invocations":${actual}}`);
if (actual === expected) {
  console.log("✓ dedup window correctly drops repeats while letting distinct keys through");
  process.exit(0);
} else {
  console.error(`✗ FAIL: expected ${expected} invocations, got ${actual}`);
  process.exit(1);
}
