#!/usr/bin/env bash
set -euo pipefail

echo "# test698 — capability-negotiated atomic peer replies"
echo "source_commit=${TEST698_SOURCE_COMMIT:-unknown}"

AGENT_TESTS=(
  /workspace/agent-node/src/inbox-message-policy.test.ts
  /workspace/agent-node/src/peer-reply-inbox.test.ts
  /workspace/agent-node/src/peer-reply-send.test.ts
  /workspace/agent-node/src/reply-routing-source.test.ts
  /workspace/agent-node/src/runtime/config-apply.test.ts
)
SERVER_TESTS=(
  /workspace/server/src/peer-reply-capability.test.ts
  /workspace/server/src/peer-reply-atomic.test.ts
  /workspace/server/src/scheduled-run-terminal.test.ts
  /workspace/server/src/send-reply-agent-warning.test.ts
  /workspace/server/src/send-reply-attachments.test.ts
)

echo "L0 focused unit + Hub lifecycle matrix"
COMMHUB_DB=/tmp/test698-main.sqlite bun test "${AGENT_TESTS[@]}" "${SERVER_TESTS[@]}"

echo "L1 build the real agent-node entrypoint"
bun build /workspace/agent-node/src/cli.ts \
  --outfile /tmp/test698-agent-node.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty >/tmp/test698-build.log

echo "L2 production denominator"
test "$(grep -Fc 'server.tool(' /workspace/server/src/tools.ts)" -gt 0
test "$(grep -Fc '"send_peer_reply"' /workspace/server/src/tools.ts)" -eq 1
test "$(grep -Fc 'runInboxTurnByReplyPolicy(' /workspace/agent-node/src/cli.ts)" -eq 1
test "$(grep -Fc 'callCommHub("send_peer_reply"' /workspace/agent-node/src/cli.ts)" -eq 1
! grep -Fq 'REPLY_VIA_SEND_TASK' /workspace/agent-node/src/cli.ts

run_mutation() {
  local name="$1" file="$2" sed_expr="$3"
  shift 3
  local backup="/tmp/test698-${name}.bak"
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
  rm -f "/tmp/test698-mutation-${name}.sqlite"
  set +e
  COMMHUB_DB="/tmp/test698-mutation-${name}.sqlite" bun test "$@" \
    >"/tmp/test698-mutation-${name}.log" 2>&1
  rc=$?
  set -e
  mv "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_SURVIVED: $name"
    cat "/tmp/test698-mutation-${name}.log"
    exit 1
  fi
  echo "MUTATION_RED: $name rc=$rc"
}

echo "L3 witnessed-red product gates"
run_mutation "terminal-reply-replies-again" \
  /workspace/agent-node/src/peer-reply-inbox.ts \
  's/if (replyExpected) return/if (true) return/' \
  /workspace/agent-node/src/peer-reply-inbox.test.ts
run_mutation "new-reply-wake-removed" \
  /workspace/agent-node/src/peer-reply-inbox.ts \
  's/if (event.type !== "new_reply") return false;/if (true) return false;/' \
  /workspace/agent-node/src/peer-reply-inbox.test.ts
run_mutation "old-hub-fallback-removed" \
  /workspace/agent-node/src/peer-reply-send.ts \
  's/if (!isPeerReplyCapabilityUnavailable(error)) throw error;/if (true) throw error;/' \
  /workspace/agent-node/src/peer-reply-send.test.ts
run_mutation "capability-provenance-bypassed" \
  /workspace/server/src/tools.ts \
  's/if (token?.bound_node_id !== nodeId) delete copy.peer_reply_inbox_capable;/if (false) delete copy.peer_reply_inbox_capable;/' \
  /workspace/server/src/peer-reply-capability.test.ts
run_mutation "recipient-capability-gate-removed" \
  /workspace/server/src/tools.ts \
  's/if (!recipientCapable) {/if (false) {/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "reply-rename-canonicalization-removed" \
  /workspace/server/src/tools.ts \
  's/const replyTargetAlias = canonicalReplyTarget.alias;/const replyTargetAlias = alias;/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "node-ownership-check-removed" \
  /workspace/server/src/tools.ts \
  's/if (token.bound_node_id !== taskBefore.to_node_id) {/if (false) {/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "task-terminalization-removed" \
  /workspace/server/src/tools.ts \
  's/^             SET status = ?1,$/             SET status = status,/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "reply-requires-response" \
  /workspace/server/src/tools.ts \
  "/VALUES (?1, ?2, ?3, 'reply'/s/'none'/'reply'/" \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "scheduled-run-sync-removed" \
  /workspace/server/src/tools.ts \
  's/syncScheduledRunForTask(in_reply_to, effectiveNetId);/void (in_reply_to, effectiveNetId);/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "capability-advertisement-removed" \
  /workspace/agent-node/src/runtime/config-apply.ts \
  's/peer_reply_inbox_capable: true,/peer_reply_inbox_capable: undefined,/' \
  /workspace/agent-node/src/runtime/config-apply.test.ts

echo "RESULT: PASS"
