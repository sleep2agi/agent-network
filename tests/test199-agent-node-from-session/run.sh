#!/usr/bin/env bash

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：scripts/qa.sh 缺 ARG 时
# **不传且不报错**，断言写在这里才会让缺失显形。
[[ "${TEST199_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST199_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST199_SOURCE_COMMIT"

set -euo pipefail

cd /repo/agent-node

echo "# test199-agent-node-from-session"
echo
echo "Run agent-node MCP proxy unit coverage in Docker."
echo "This verifies runtime-side CommHub MCP calls inject the current alias"
echo "as from_session for send_task/send_message/send_reply-style outbound calls."
echo

bun test src/commhub-mcp.test.ts
bun build src/cli.ts --outdir /tmp/agent-node-build --entry-naming cli.js --target node --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' --external @openai/codex-sdk

echo
echo "PASS: agent-node runtime injects current alias into CommHub MCP outbound calls."
