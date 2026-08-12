#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  "[test696] source=${SOURCE_COMMIT}" \
  "[test696] authenticated Dashboard provenance + low-value reply filtering"

bun test \
  /workspace/agent-node/src/goals/routing.test.ts \
  /workspace/agent-node/src/inbox-dispatch.test.ts

cli=/workspace/agent-node/src/cli.ts
grep -Fq 'const interactiveDashboardTask = isInteractiveDashboardTask(msg);' "$cli"
grep -Fq '{ messageType: msgType, interactiveDashboardTask },' "$cli"

cd /workspace/agent-node
bun build src/cli.ts --outfile /tmp/agent-node-cli.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk \
  --external node-pty
test -s /tmp/agent-node-cli.js

printf '%s\n' '[test696] PASS'
