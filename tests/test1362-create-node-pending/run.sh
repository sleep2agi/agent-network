#!/usr/bin/env bash
set -euo pipefail

echo "# test1362 — create_node missed-doorbell compensation"
echo "source_commit=${TEST1362_SOURCE_COMMIT}"

cd /workspace

echo
echo "## agent-node build"
cd /workspace/agent-node
bun run build
cd /workspace

echo
echo "## agent-node runtime: reconnect pulls pending and deduplicates live SSE"
bun test agent-node/src/runtime/create-node-daemon.test.ts

echo
echo "## server handlers: pending-list scope and create_node audit wording"
COMMHUB_DB=/tmp/anet-test1362-stop.db bun test server/src/stop-delete-node.test.ts

echo
echo "## server create/ack regression"
COMMHUB_DB=/tmp/anet-test1362-create.db bun test server/src/create-node.test.ts server/src/ack-create-request.test.ts

echo
echo "## MCP registration inventory"
cd /workspace/server
bun /workspace/tests/test629-mcp-schema-policy/probe.ts

echo
echo "RESULT: PASS"
