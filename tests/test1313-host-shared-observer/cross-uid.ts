// #1313 assertion helper: an observation must never be produced when only part of
// the process table could be inspected.
//
// 通信牛's #2784 review: a child of another uid can hold a listing fd (inherit or
// SCM_RIGHTS), so the socket's uid says nothing about the holder. That is why the
// provider scans ALL processes and refuses when any of them is unreadable — the
// right answer in a mixed-uid table is `permission_denied`, never a single-owner
// claim and never a fabricated uid.
import { observeHostSharedServe } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts";

const [url, expectedHolderUidRaw, forbiddenReason] = process.argv.slice(2);
const expectedHolderUid = Number(expectedHolderUidRaw);
const observed = observeHostSharedServe(url);

if (!observed.ok) {
  if (observed.reason !== "permission_denied") {
    console.error(`FAIL: expected permission_denied (unproven uniqueness) or a real observation, got ${observed.reason}`);
    process.exit(1);
  }
  if (forbiddenReason && observed.reason === forbiddenReason) {
    console.error(`FAIL: got ${observed.reason} — that would claim the socket has no holder`);
    process.exit(1);
  }
  console.log("cross-uid ok: refused with permission_denied (uniqueness unprovable in a mixed-uid table)");
  process.exit(0);
}

const ev = observed.processEvidence;
if (ev.uid !== expectedHolderUid) {
  console.error(`FAIL: evidence uid ${ev.uid}, expected the holder's real uid ${expectedHolderUid}`);
  process.exit(1);
}
if ("generation" in ev) {
  console.error("FAIL: evidence carries a generation claim — argv is diagnostics only");
  process.exit(1);
}
console.log(`cross-uid ok: observed uid=${ev.uid} pid=${ev.pid} socketUid=${ev.diagnostics.socketUid} (socket uid is a diagnostic, never a filter)`);
