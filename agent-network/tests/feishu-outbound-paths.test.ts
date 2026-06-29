/**
 * RFC-020 §15.1 — feishu outbound-path helpers.
 *
 * Single source of truth for `/work/feishu-attachments/<conn>/<convKey>/`
 * naming, shared by adapter inbound download + bridge outbound whitelist
 * + worker→agent envelope. The unification eliminates the 2026-06-29
 * Vincent UAT bug: agent wrote files using inbound's `oc_<chat>/`
 * convention, bridge whitelist used outbound's `ou_<user>/` — every
 * generated PDF was rejected.
 *
 * Run: `bun tests/feishu-outbound-paths.test.ts`
 */

import {
  feishuConvKey,
  feishuOutboundDir,
  OUTBOUND_ROOT,
} from "../src/im/feishu/outbound-paths";
import { validateOutboundPath } from "../src/im/feishu/outbound-marker";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. feishuConvKey unit ──────────────────────────────────────────────────

expect("conv key: open_chat_id passthrough", feishuConvKey("oc_9a7eedbba275a87999f7ee2cfb10f4cb") === "oc_9a7eedbba275a87999f7ee2cfb10f4cb");
expect("conv key: open_id passthrough", feishuConvKey("ou_74d554f4024ca8f2b643180229571f57") === "ou_74d554f4024ca8f2b643180229571f57");
expect("conv key: om_ msg id passthrough", feishuConvKey("om_abc123") === "om_abc123");
expect("conv key: sanitize special chars", feishuConvKey("foo/bar:baz") === "foo_bar_baz");
expect("conv key: keep dashes + underscores", feishuConvKey("a-b_c") === "a-b_c");
expect("conv key: empty → empty", feishuConvKey("") === "");
expect("conv key: undefined → empty", feishuConvKey(undefined) === "");
expect("conv key: null → empty", feishuConvKey(null) === "");
expect("conv key: non-string → empty", feishuConvKey(42 as any) === "");

// ── 2. feishuOutboundDir ───────────────────────────────────────────────────

expect(
  "outbound dir: vincent's actual UAT shape",
  feishuOutboundDir("feishu-local", "oc_9a7eedbba275a87999f7ee2cfb10f4cb") ===
    "/work/feishu-attachments/feishu-local/oc_9a7eedbba275a87999f7ee2cfb10f4cb/",
);
expect(
  "outbound dir: trailing slash",
  feishuOutboundDir("feishu-local", "oc_x").endsWith("/"),
);
expect(
  "outbound dir: no `#feishu` suffix on connection name",
  !feishuOutboundDir("feishu-local", "oc_x").includes("#feishu"),
);
expect(
  "outbound dir: empty conv → still valid prefix shape",
  feishuOutboundDir("feishu-local", "") === "/work/feishu-attachments/feishu-local//",
);
expect(
  "outbound dir: fallback connection name",
  feishuOutboundDir("", "oc_x") === "/work/feishu-attachments/feishu/oc_x/",
);

// ── 3. CROSS-CHECK — validate uses the SAME prefix the helper produces ────
// Vincent's actual UAT: agent wrote
//   /work/feishu-attachments/feishu-local/oc_9a7eedbba275a87999f7ee2cfb10f4cb/TMWork.pdf
// Bridge whitelist must accept this path when convId is the same chat_id
// the user was sending from. Before the unify fix, bridge computed
// `feishu-local#feishu/ou_<userid>/` and rejected — this test locks the fix.

const VINCENT_CONN = "feishu-local";
const VINCENT_CHAT_ID = "oc_9a7eedbba275a87999f7ee2cfb10f4cb";
const VINCENT_WRITES = `/work/feishu-attachments/feishu-local/${VINCENT_CHAT_ID}/TMWork_v1.20.4_进度报告.pdf`;
const EXPECTED_DIR = feishuOutboundDir(VINCENT_CONN, VINCENT_CHAT_ID);

expect(
  "regression: Vincent's UAT writes the same prefix the helper produces",
  VINCENT_WRITES.startsWith(EXPECTED_DIR),
  `path=${VINCENT_WRITES} | prefix=${EXPECTED_DIR}`,
);

const validateResult = validateOutboundPath({
  p: VINCENT_WRITES,
  expectedDir: EXPECTED_DIR,
  realpathFn: () => VINCENT_WRITES,
  statFn: () => ({ size: 12345 }),
});
expect(
  "regression: validate(Vincent's-write, helper-computed-prefix) → null (accept)",
  validateResult === null,
  `got: ${validateResult}`,
);

// Cross-conversation: same connection, DIFFERENT chat → reject
const OTHER_CHAT_ID = "oc_DIFFERENT_CHAT_FFFFFFFFFFFFFFFFFFFF";
const otherDir = feishuOutboundDir(VINCENT_CONN, OTHER_CHAT_ID);
const crossReject = validateOutboundPath({
  p: VINCENT_WRITES,
  expectedDir: otherDir,
  realpathFn: () => VINCENT_WRITES,
  statFn: () => ({ size: 12345 }),
});
expect(
  "cross-conv: vincent's path with another conv's expectedDir → reject",
  crossReject !== null && crossReject.includes("会话目录"),
  `got: ${crossReject}`,
);

// ── 4. Bug-class regression — `#feishu` suffix on connectionName SHOULD NOT match
// The original bug was that bridge computed `feishu-local#feishu` and used
// it as the prefix. Confirm the helper-produced prefix does NOT contain that
// suffix, so the bug shape can't reappear silently.

expect(
  "no `#feishu` suffix slips into prefix",
  !EXPECTED_DIR.includes("feishu-local#feishu"),
);
expect(
  "exact expected prefix shape",
  EXPECTED_DIR === `/work/feishu-attachments/feishu-local/${VINCENT_CHAT_ID}/`,
);

// ── 5. Bug-class regression — sender.id (ou_<user>) MUST NOT be the convKey
// Bridge previously used `event.sender.id` for DMs. The agent wrote via
// `conversation.conversationId` (oc_<chat>). Tests below assert that the
// path the agent writes (oc_<chat>) IS what the helper computes for the
// SAME `conversationId` input — not the user's open_id.

const SENDER_OPEN_ID = "ou_74d554f4024ca8f2b643180229571f57";
const SENDER_BASED_DIR = feishuOutboundDir("feishu-local", SENDER_OPEN_ID);
const dmAttempt = validateOutboundPath({
  p: VINCENT_WRITES,
  expectedDir: SENDER_BASED_DIR,
  realpathFn: () => VINCENT_WRITES,
  statFn: () => ({ size: 12345 }),
});
expect(
  "regression: sender.id-based prefix would reject vincent's write (proves bug shape would still fail if convKey policy regressed)",
  dmAttempt !== null,
);

// ── 6. OUTBOUND_ROOT shape lock ────────────────────────────────────────────

expect(
  "OUTBOUND_ROOT is /work/feishu-attachments",
  OUTBOUND_ROOT === "/work/feishu-attachments",
);
expect(
  "feishuOutboundDir always starts with OUTBOUND_ROOT",
  feishuOutboundDir("any", "any-conv").startsWith(OUTBOUND_ROOT + "/"),
);

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-outbound-paths tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
