#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test828-mcp.txt") 2>&1
echo "test828 MCP identity source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then
  test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
fi
timeout 150s bun /test828-mcp/harness.ts
mkdir -p "$ARTIFACT_DIR/negative"
if TEST828_SWAP_TOKEN=1 ARTIFACT_DIR="$ARTIFACT_DIR/negative" timeout 150s bun /test828-mcp/harness.ts > "$ARTIFACT_DIR/negative/run.log" 2>&1; then
  echo 'FAIL: wrong-node credential escaped the identity assertion'; exit 1
else
  rc=$?
fi
test "$rc" = 1
grep -Fq 'FAIL: sender alias is token-bound' "$ARTIFACT_DIR/negative/run.log"
echo 'PASS: wrong-node credential witnessed red at sender identity assertion (exit 1)'
