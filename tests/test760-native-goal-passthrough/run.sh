#!/usr/bin/env bash
set -euo pipefail

REPORT=/artifacts/report-test760-native-goal-passthrough.txt
mkdir -p /artifacts
exec > >(tee "$REPORT") 2>&1

echo "# test760 — native /goal and /loop pass-through"
bun test agent-node/src/goals/routing.test.ts agent-node/src/inbox-dispatch.test.ts

grep -Fq 'return ANET_SCHEDULE_COMMAND_RE.test(content || "");' agent-node/src/goals/routing.ts
if grep -Eq 'LEGACY_SCHEDULE_COMMAND_RE.*test' agent-node/src/goals/routing.ts; then
  echo "FAIL: legacy /goal or /loop can still select the scheduler"
  exit 1
fi

bun build agent-node/src/cli.ts --outfile /tmp/agent-node-cli.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk \
  --external node-pty
test -s /tmp/agent-node-cli.js
echo "RESULT: PASS"
