#!/usr/bin/env bash
set -euo pipefail

echo "# test698 — atomic peer reply lifecycle"
echo "source_commit=${TEST698_SOURCE_COMMIT:-unknown}"

echo "L0 policy + focused Hub lifecycle tests"
COMMHUB_DB=/tmp/test698-atomic-peer-reply.sqlite bun test \
  /workspace/agent-node/src/inbox-message-policy.test.ts \
  /workspace/server/src/peer-reply-atomic.test.ts \
  /workspace/server/src/send-reply-agent-warning.test.ts \
  /workspace/server/src/send-reply-attachments.test.ts

echo "L1 build agent-node integration surface"
bun build /workspace/agent-node/src/cli.ts \
  --outfile /tmp/test698-agent-node.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty >/tmp/test698-build.log

echo "L2 structural denominator"
! rg -n 'REPLY_VIA_SEND_TASK|sendPeerReplyTaskWithTrace' /workspace/agent-node/src/cli.ts
rg -Fq 'scheduleWorkInboxDrain();' /workspace/agent-node/src/cli.ts
rg -Fq 'requires_response, network_id, meta_json' /workspace/server/src/tools.ts

echo "RESULT: PASS"
