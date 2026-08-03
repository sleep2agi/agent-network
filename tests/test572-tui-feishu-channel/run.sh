#!/usr/bin/env bash
set -euo pipefail

echo "[layer 1] Feishu IPC compatibility + runtime provenance"
bun agent-network/tests/feishu-envelope-compat.test.ts

echo "[layer 2] Feishu bridge dispatch + reply-to-originating-conversation"
bun agent-network/tests/feishu-bridge-dispatch.test.ts

echo "[layer 3] Feishu provenance reaches the shared Codex TUI turn"
bun test agent-node/src/runtime/codex-app-server-bridge.test.ts

echo "[layer 4] Feishu provenance reaches the shared Grok TUI input"
bun test agent-node/src/runtime/grok-copresence/runtime.test.ts

echo "RESULT: PASS (Codex + Grok TUI Feishu channel contract)"
