#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
mkdir -p "${ARTIFACT_DIR:-/artifacts}"
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
exec > >(tee "$ARTIFACT_DIR/report-test827.txt") 2>&1
echo "test827 — real CLI / Hub / packaged agent-node / OpenCode V2 / TUI"
echo "source_commit=${SOURCE_COMMIT:-unset}; date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then
  test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
fi
cd /workspace/agent-network
bun test ./src/opencode-generation-create.test.ts ./src/opencode-free-tier.test.ts \
  ./src/opencode-copresence-cli.test.ts ./src/opencode-preset.test.ts
cd /opt/node_modules/@sleep2agi/agent-node
bun test ./src/runtime/opencode-copresence/v2-session.test.ts \
  ./src/runtime/opencode-acp/binary-v2.test.ts ./src/runtime/opencode-backend.test.ts \
  ./src/runtime/opencode-v1-spawn-snapshot.test.ts
timeout 240s bun /test827/harness.ts
