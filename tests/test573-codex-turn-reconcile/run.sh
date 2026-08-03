#!/usr/bin/env bash
set -euo pipefail

test -f /workspace/agent-node/src/runtime/codex-app-server-bridge.ts
test -f /workspace/agent-node/src/runtime/codex-app-server/runtime.ts

bun test \
  /workspace/agent-node/src/runtime/codex-app-server-bridge.test.ts \
  /workspace/agent-node/src/runtime/codex-app-server/runtime.test.ts
