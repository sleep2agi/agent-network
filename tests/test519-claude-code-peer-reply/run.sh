#!/usr/bin/env bash
# test519 — Claude Code channel commhub_send_peer_reply (#519 / RFC-030).
# Real Hub + real bundled node-server.ts over stdio; no Claude Code, no tmux.
set -euo pipefail
cd /workspace

echo "# test519 — claude-code channel peer reply closes the original task"
echo "source_commit=${SOURCE_COMMIT:-unknown}"

build() { (cd agent-network && bun build src/node-server.ts --outfile "$1" --target node >/dev/null); }
e2e() { CHANNEL_BUNDLE="$1" REPO=/workspace bun tests/test519-claude-code-peer-reply/channel-peer-reply-e2e.ts; }

echo "[L0] unit"
(cd agent-network && bun test src/channel-peer-reply.test.ts)

echo "[L1] real Hub + real channel bundle"
build /tmp/test519-node-server.js
e2e /tmp/test519-node-server.js

MUTATIONS=0
mutate_red() {
  local name=$1 file=$2 before=$3 after=$4
  local backup
  backup=$(mktemp)
  cp "$file" "$backup"
  bun tests/test519-claude-code-peer-reply/mutate.mjs "$file" "$before" "$after"
  if cmp -s "$file" "$backup"; then echo "MUTATION_NOOP: $name" >&2; cp "$backup" "$file"; exit 1; fi
  local rc=0
  set +e
  build "/tmp/test519-mut-$name.js" && e2e "/tmp/test519-mut-$name.js" >"/tmp/test519-mut-$name.log" 2>&1
  rc=$?
  set -e
  cp "$backup" "$file"; rm -f "$backup"
  if [[ $rc -eq 0 ]]; then echo "MUTATION_SURVIVED: $name" >&2; cat "/tmp/test519-mut-$name.log" >&2; exit 1; fi
  grep -m3 '^FAIL:' "/tmp/test519-mut-$name.log" || true
  MUTATIONS=$((MUTATIONS + 1))
  echo "MUTATION_RED: $name rc=$rc"
}

echo "[L2] witnessed-red mutations"
mutate_red capability-fallback-removed agent-network/src/channel-peer-reply.ts \
  '  const reason = peerReplyFallbackReason(atomic);' \
  '  const reason = null as string | null; void peerReplyFallbackReason;'
mutate_red close-despite-failed-wake agent-network/src/channel-peer-reply.ts \
  '  if (failed(wake.payload)) {' \
  '  if (false && failed(wake.payload)) {'
mutate_red old-hub-unknown-tool-not-recognised agent-network/src/channel-peer-reply.ts \
  '  if (isUnknownTool(code)) return "hub_without_send_peer_reply";' \
  '  if (false && isUnknownTool(code)) return "hub_without_send_peer_reply";'
mutate_red tool-not-listed agent-network/src/node-server.ts \
  '      name: PEER_REPLY_TOOL_NAME,' \
  '      name: "commhub_send_peer_reply_disabled",'
mutate_red instructions-reverted agent-network/src/node-server.ts \
  'If the sender is another agent node: commhub_send_peer_reply(task_id=' \
  'If your runtime has commhub_send_peer_reply(task_id='

[[ $MUTATIONS -eq 5 ]] || { echo "FAIL: expected 5 mutations, ran $MUTATIONS" >&2; exit 1; }
echo "RESULT: PASS (mutations=$MUTATIONS)"
