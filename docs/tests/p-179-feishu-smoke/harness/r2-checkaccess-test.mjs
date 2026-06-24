#!/usr/bin/env node
/* R2.1 必改1 — checkAccess group mentioned-gate test
 *
 * MIRROR of adapter.ts:456-479 `checkAccess` (function is module-internal,
 * not exported). This test exercises the documented spec. Live audit via
 * real adapter happens in the 待凭证 round.
 *
 * Spec (from adapter.ts source):
 *   DM   : allow iff sender.id ∈ allowFrom
 *   Group: chat must be in allowChats first; then
 *          - groupPolicy="all"     → allow regardless of mention
 *          - groupPolicy="observe" → deny (no trigger)
 *          - groupPolicy="mention" → allow iff event.mentioned (default)
 *          - groupPolicy="command" → allow iff event.mentioned (treated as
 *            "mention" in current adapter.ts:469-478)
 *   Reason text on deny must contain identifying token (e.g. "mentioned"
 *   for the mention-gate path, per dispatch acceptance).
 */

// === Mirror function — keep in sync with agent-network/src/im/feishu/adapter.ts:456-479 ===
function checkAccess(event, access, groupPolicy) {
  if (event.conversation.conversationType === "p2p") {
    return access.allowFrom.includes(event.sender.id)
      ? { allow: true, reason: "" }
      : { allow: false, reason: "sender not in allowFrom (dm)" };
  }
  // group / topic
  if (!access.allowChats.includes(event.conversation.conversationId)) {
    return { allow: false, reason: "chat not in allowChats" };
  }
  if (groupPolicy === "all") return { allow: true, reason: "" };
  if (groupPolicy === "observe") {
    return { allow: false, reason: "groupPolicy=observe — chat in allowChats but no trigger" };
  }
  // mention / command
  if (event.mentioned) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `groupPolicy=${groupPolicy} requires @bot mention (not mentioned)`,
  };
}

const access = {
  allowFrom: ["ou_allowed_dm_user"],
  allowChats: ["oc_allowed_chat"],
};

const cases = [
  {
    label: "DM allowed sender → allow",
    event: { conversation: { conversationType: "p2p", conversationId: "p2p_a" }, sender: { id: "ou_allowed_dm_user" }, mentioned: false },
    groupPolicy: "mention",
    expect: { allow: true, reasonContains: null },
  },
  {
    label: "DM disallowed sender → deny",
    event: { conversation: { conversationType: "p2p", conversationId: "p2p_b" }, sender: { id: "ou_random_user" }, mentioned: false },
    groupPolicy: "mention",
    expect: { allow: false, reasonContains: "allowFrom" },
  },
  {
    label: "GROUP mentioned=false + allowChats + policy=mention → DENY with reason containing 'mentioned'",
    event: { conversation: { conversationType: "group", conversationId: "oc_allowed_chat" }, sender: { id: "ou_random" }, mentioned: false },
    groupPolicy: "mention",
    expect: { allow: false, reasonContains: "mentioned" },
  },
  {
    label: "GROUP mentioned=true + allowChats + policy=mention → ALLOW",
    event: { conversation: { conversationType: "group", conversationId: "oc_allowed_chat" }, sender: { id: "ou_random" }, mentioned: true },
    groupPolicy: "mention",
    expect: { allow: true, reasonContains: null },
  },
  {
    label: "GROUP mentioned=false + chat NOT in allowChats → DENY 'not in allowChats'",
    event: { conversation: { conversationType: "group", conversationId: "oc_other_chat" }, sender: { id: "ou_random" }, mentioned: true },
    groupPolicy: "mention",
    expect: { allow: false, reasonContains: "allowChats" },
  },
  {
    label: "GROUP mentioned=false + policy=all → ALLOW (override mention requirement)",
    event: { conversation: { conversationType: "group", conversationId: "oc_allowed_chat" }, sender: { id: "ou_random" }, mentioned: false },
    groupPolicy: "all",
    expect: { allow: true, reasonContains: null },
  },
  {
    label: "GROUP mentioned=true + policy=observe → DENY",
    event: { conversation: { conversationType: "group", conversationId: "oc_allowed_chat" }, sender: { id: "ou_random" }, mentioned: true },
    groupPolicy: "observe",
    expect: { allow: false, reasonContains: "observe" },
  },
];

let pass = 0, fail = 0;
const failures = [];
for (const c of cases) {
  const got = checkAccess(c.event, access, c.groupPolicy);
  const allowOk = got.allow === c.expect.allow;
  const reasonOk = c.expect.reasonContains === null ? true : got.reason.toLowerCase().includes(c.expect.reasonContains.toLowerCase());
  if (allowOk && reasonOk) {
    pass++;
    console.log(`  ✓ ${c.label}`);
  } else {
    fail++;
    failures.push(`${c.label} — got ${JSON.stringify(got)} expected allow=${c.expect.allow} reason~${c.expect.reasonContains}`);
    console.error(`  ✗ ${c.label} — got=${JSON.stringify(got)} expect=${JSON.stringify(c.expect)}`);
  }
}
console.log(`R2.1_RESULT={"pass":${pass},"fail":${fail},"total":${cases.length}}`);
if (fail > 0) {
  console.error("FAILED cases:\n  " + failures.join("\n  "));
}
process.exit(fail === 0 ? 0 : 1);
