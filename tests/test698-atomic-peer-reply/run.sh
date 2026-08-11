#!/usr/bin/env bash
set -euo pipefail

echo "# test698 — atomic peer reply lifecycle"
echo "source_commit=${TEST698_SOURCE_COMMIT:-unknown}"

echo "L0 policy + focused Hub lifecycle tests"
COMMHUB_DB=/tmp/test698-atomic-peer-reply.sqlite bun test \
  /workspace/agent-node/src/inbox-message-policy.test.ts \
  /workspace/agent-node/src/reply-routing-source.test.ts \
  /workspace/server/src/peer-reply-atomic.test.ts \
  /workspace/server/src/scheduled-run-terminal.test.ts \
  /workspace/server/src/send-reply-agent-warning.test.ts \
  /workspace/server/src/send-reply-attachments.test.ts

echo "L1 build agent-node integration surface"
bun build /workspace/agent-node/src/cli.ts \
  --outfile /tmp/test698-agent-node.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty >/tmp/test698-build.log

echo "L2 structural denominator"
! grep -En 'REPLY_VIA_SEND_TASK|sendPeerReplyTaskWithTrace' /workspace/agent-node/src/cli.ts
grep -Fq 'scheduleWorkInboxDrain();' /workspace/agent-node/src/cli.ts
grep -Fq 'requires_response, network_id, meta_json' /workspace/server/src/tools.ts

run_mutation() {
  local name="$1" file="$2" sed_expr="$3"
  local backup="/tmp/test698-$(basename "$file").bak"
  cp "$file" "$backup"
  local before after rc
  before="$(sha256sum "$file" | cut -d' ' -f1)"
  sed -i "$sed_expr" "$file"
  after="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$before" = "$after" ]; then
    echo "MUTATION_NOOP: $name"
    mv "$backup" "$file"
    exit 1
  fi
  rm -f /tmp/test698-mutation.sqlite
  set +e
  COMMHUB_DB=/tmp/test698-mutation.sqlite bun test \
    /workspace/agent-node/src/inbox-message-policy.test.ts \
    /workspace/agent-node/src/reply-routing-source.test.ts \
    /workspace/server/src/peer-reply-atomic.test.ts >/tmp/test698-mutation.log 2>&1
  rc=$?
  set -e
  mv "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_SURVIVED: $name"
    cat /tmp/test698-mutation.log
    exit 1
  fi
  echo "MUTATION_RED: $name rc=$rc"
}

echo "L3 witnessed-red mutations"
run_mutation "reply-pingpong-enabled" \
  /workspace/agent-node/src/inbox-message-policy.ts \
  's/return { deliverToRuntime: true, replyExpected: false };/return { deliverToRuntime: true, replyExpected: true };/'
run_mutation "agent-route-reverted-to-send-task" \
  /workspace/agent-node/src/cli.ts \
  's/const result = await callCommHub("send_reply", {/const result = await callCommHub("send_task", {/'
run_mutation "new-reply-wake-removed" \
  /workspace/agent-node/src/cli.ts \
  's/if (ev.type === "new_reply") {/if (false \&\& ev.type === "new_reply") {/'
run_mutation "task-terminalization-removed" \
  /workspace/server/src/tools.ts \
  's/^             SET status = ?1,$/             SET status = status,/'
run_mutation "node-ownership-check-removed" \
  /workspace/server/src/tools.ts \
  's/if (!ownsTask) return/if (false) return/'
run_mutation "reply-requires-response" \
  /workspace/server/src/tools.ts \
  "/VALUES (?1, ?2, ?3, 'reply'/s/'none'/'task'/"

echo "RESULT: PASS"
