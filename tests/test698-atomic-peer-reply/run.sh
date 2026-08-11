#!/usr/bin/env bash
set -euo pipefail

echo "# test698 — capability-negotiated atomic peer replies"
echo "source_commit=${TEST698_SOURCE_COMMIT:-unknown}"

AGENT_TESTS=(
  /workspace/agent-node/src/inbox-message-policy.test.ts
  /workspace/agent-node/src/peer-reply-inbox.test.ts
  /workspace/agent-node/src/peer-reply-send.test.ts
  /workspace/agent-node/src/reply-reliability.test.ts
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

echo "L1b real cli.ts receiver wiring"
bun /workspace/tests/test698-atomic-peer-reply/cli-wiring-e2e.ts

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

run_cli_mutation() {
  local name="$1" sed_expr="$2"
  local file=/workspace/agent-node/src/cli.ts
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
  set +e
  bun /workspace/tests/test698-atomic-peer-reply/cli-wiring-e2e.ts \
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

run_agent_wiring_mutation() {
  local name="$1" file="$2" sed_expr="$3"
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
  set +e
  bun /workspace/tests/test698-atomic-peer-reply/cli-wiring-e2e.ts \
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

run_server_wiring_mutation() {
  local name="$1" sed_expr="$2"
  local file=/workspace/server/src/tools.ts
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
  set +e
  bun /workspace/tests/test698-atomic-peer-reply/cli-wiring-e2e.ts \
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
run_cli_mutation "cli-reply-type-lost" \
  's/ || msgType === "reply"//'
run_cli_mutation "cli-terminal-reply-egress-restored" \
  's/if (inboxTurn.kind === "terminal_peer_reply") return;/if (false) return;/'
run_cli_mutation "cli-new-reply-wake-disabled" \
  's/routePeerReplySse(ev, scheduleWorkInboxDrain);/if (false) routePeerReplySse(ev, scheduleWorkInboxDrain);/'
run_cli_mutation "cli-fallback-reason-lost" \
  's/peer_reply_fallback_reason: args.fallbackReason/peer_reply_fallback_reason: undefined/'
run_cli_mutation "cli-failed-status-lost" \
  '/sendLegacyReply:/,/      }),/ s/status: args.failed ? "failed" : "replied"/status: "replied"/'
run_server_wiring_mutation "dashboard-origin-misrouted-to-task" \
  's/error: "peer_reply_origin_not_node" as const/error: "peer_reply_unsupported" as const/'
run_server_wiring_mutation "dashboard-origin-checked-after-capability" \
  's/if (!taskBefore.from_node_id) {/if (!taskBefore.from_node_id \&\& !peerCapabilityRequired) {/'
run_server_wiring_mutation "dashboard-null-target-origin-order-lost" \
  's/if (!taskBefore.from_node_id) {/if (!taskBefore.from_node_id \&\& !!taskBefore.to_node_id) {/'
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
run_agent_wiring_mutation "deleted-origin-terminal-wiring-removed" \
  /workspace/agent-node/src/peer-reply-send.ts \
  's/legacyError.code === "alias_not_found"/legacyError.code === "alias_missing_for_test"/'
run_mutation "legacy-mcp-code-lost" \
  /workspace/agent-node/src/reply-reliability.ts \
  's/...(mcpCode !== undefined ? { code: Number(mcpCode) } : {}),/...{},/' \
  /workspace/agent-node/src/reply-reliability.test.ts
run_mutation "identity-rotation-fallback-removed" \
  /workspace/agent-node/src/peer-reply-send.ts \
  's/|| error.code === "reply_task_not_owned"/|| false/' \
  /workspace/agent-node/src/peer-reply-send.test.ts \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "capability-provenance-bypassed" \
  /workspace/server/src/tools.ts \
  's/if (token?.bound_node_id !== nodeId) delete copy.peer_reply_inbox_capable;/if (false) delete copy.peer_reply_inbox_capable;/' \
  /workspace/server/src/peer-reply-capability.test.ts
run_mutation "recipient-capability-gate-removed" \
  /workspace/server/src/tools.ts \
  's/if (recipient?.peer_reply_inbox_capable !== 1 || liveSse < 1) {/if (false) {/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "recipient-capability-alias-binding-removed" \
  /workspace/server/src/tools.ts \
  's/WHERE node_id = ?1 AND network_id = ?2 AND alias = ?3/WHERE node_id = ?1 AND network_id = ?2 AND ?3 IS NOT NULL/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "rollback-capability-clear-removed" \
  /workspace/server/src/tools.ts \
  's/externalSchedulesJson, peerReplyInboxCapable ? 1 : 0]/externalSchedulesJson, 1]/' \
  /workspace/server/src/peer-reply-atomic.test.ts
run_mutation "legacy-fallback-marker-removed" \
  /workspace/agent-node/src/peer-reply-task-trace.ts \
  's/...(input.meta ? { meta: input.meta } : {}),/...{},/' \
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
run_mutation "legacy-agent-warning-removed" \
  /workspace/server/src/tools.ts \
  's/...(warning ? { warning } : {}),/...{},/' \
  /workspace/server/src/send-reply-agent-warning.test.ts

echo "RESULT: PASS"
