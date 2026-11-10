#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test832-runtime.txt") 2>&1
echo "test832 runtime registry source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi
cd /opt/node_modules/@sleep2agi/agent-node
echo 'L0 unit: final registry, hard deadlines, process death, packaged observer, V2 startup'
bun test src/runtime/opencode-copresence/v2-readiness.test.ts src/runtime/opencode-copresence/v2-session.test.ts src/runtime/opencode-backend.test.ts src/runtime/opencode-acp/binary-v2.test.ts src/runtime/opencode-v1-spawn-snapshot.test.ts
echo 'L0 bundled package includes observer source'
npm run build
grep -Fq 'anet.commhub-readiness' dist/cli.js
echo 'L1+ authenticated native V2 / real isolated Hub / first-turn dispatch and receipt / sender spoof'
bash /test828-mcp/run.sh
run_case() {
  local label="$1"
  shift
  ARTIFACT_DIR="$ARTIFACT_DIR/$label" env "$@" timeout 150s bun /test828-mcp/harness.ts
}
echo 'L2 cold-start repetitions: generated product plugin, no discovery/model warmup'
run_case delay1200 TEST832_DELAY_MS=1200
run_case delay3500 TEST832_DELAY_MS=3500
echo 'L3 witnessed startup refusal: missing final tool, rejected MCP auth, slow handshake'
run_case missing TEST832_MISSING_TOOL=1 TEST832_TIMEOUT_MS=2200 TEST832_EXPECT_FAILURE=1
run_case rejected TEST832_REJECT_AUTH=1 TEST832_EXPECT_FAILURE=1
run_case timeout TEST832_DELAY_MS=5000 TEST832_TIMEOUT_MS=350 TEST832_EXPECT_FAILURE=1
echo 'PASS: runtime registry suite'
