#!/usr/bin/env bash
set -euo pipefail

echo "[layer 1] Feishu IPC compatibility + runtime provenance"
bun agent-network/tests/feishu-envelope-compat.test.ts

echo "[layer 2] Feishu provenance reaches the shared Codex TUI turn"
bun test agent-node/src/runtime/codex-app-server-bridge.test.ts

echo "RESULT: PASS (Codex TUI Feishu channel contract)"
