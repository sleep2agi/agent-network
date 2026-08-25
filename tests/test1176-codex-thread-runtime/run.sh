#!/usr/bin/env bash
set -euo pipefail
echo "# source=${SOURCE_COMMIT}"
cd /workspace/server
bun test src/runtime-label.test.ts
cd /workspace/agent-node
bun test src/codex-tui-alignment.test.ts
echo "RESULT: PASS"
