#!/usr/bin/env bash
set -euo pipefail

echo "[layer 1] Feishu IPC compatibility + runtime provenance"
bun agent-network/tests/feishu-envelope-compat.test.ts

echo "[layer 2] Feishu bridge dispatch + reply-to-originating-conversation"
bun agent-network/tests/feishu-bridge-dispatch.test.ts

echo "[layer 3] Feishu provenance reaches the shared Codex TUI turn"
bun test agent-node/src/runtime/codex-app-server-bridge.test.ts

echo "[layer 4] Feishu provenance reaches the shared OpenCode TUI turn"
bun test agent-node/src/runtime/opencode-copresence/runtime.test.ts

echo "RESULT: PASS (Codex + OpenCode TUI Feishu channel contract)"
