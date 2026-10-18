#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1326-runtime.txt") 2>&1
echo "test1326 create admission source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi
cd /opt/node_modules/@sleep2agi/agent-node
bun test src/runtime/create-node-daemon.test.ts src/runtime/node-name-652.test.ts src/runtime/opencode-server-reuse.test.ts src/runtime/opencode-host-shared-generation.test.ts
bun /test1326/integration.ts
