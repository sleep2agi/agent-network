#!/usr/bin/env bash
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
