#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test623-feishu-scrub-health.txt"
ADAPTER=agent-network/src/im/feishu/adapter.ts
TEST=agent-network/src/im/feishu/adapter-lifecycle.test.ts
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

run_lifecycle() {
  bun test "$TEST"
}

expect_red() {
  local label=$1 marker=$2
  set +e
  run_lifecycle >/tmp/test623-red.log 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,220p' /tmp/test623-red.log
    exit 1
  fi
  grep -Fq "$marker" /tmp/test623-red.log
  echo "MUTATION_RED: $label rc=$rc"
}

echo "# test623 — Feishu token scrub + prior-ready health gate"
echo "source_commit=${TEST623_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 typecheck"
cd /workspace/agent-network
bun run typecheck
cd /workspace

echo "L1 real lifecycle behavior"
run_lifecycle

echo "L2 production bundle"
cd /workspace/agent-network
bun run build
cd /workspace
test -s agent-network/dist/src/im/feishu/adapter.js

cp "$ADAPTER" /tmp/test623-adapter.ts

echo "L3 witnessed-red: arbitrary access-token scrub is load-bearing"
sed -i '/\.replace(\/\\b(?:t|u)-/,/\.replace(\/\\bcli_/ {
  /\.replace(\/\\b(?:t|u)-/d
}' "$ADAPTER"
if grep -Fq '.replace(/\b(?:t|u)-' "$ADAPTER"; then
  echo "MUTATION_NOT_APPLIED: access-token-scrub"
  exit 1
fi
expect_red access-token-scrub 'initial onError scrubs arbitrary Lark access-token shapes'
cp /tmp/test623-adapter.ts "$ADAPTER"

echo "L4 witnessed-red: inbound errors must not bypass scrub"
sed -i 's/const msg = sanitizeFeishuWsError(err, appId, appSecret).message;/const msg = err instanceof Error ? err.message : String(err); \/\/ MUTATION/' "$ADAPTER"
grep -Fq 'MUTATION' "$ADAPTER"
expect_red inbound-error-scrub 'inbound handler errors use the same token scrub before health'
cp /tmp/test623-adapter.ts "$ADAPTER"

echo "L5 witnessed-red: reconnect cannot become ready before onReady"
sed -i 's/if (!ready || generation !== this.lifecycleGeneration || terminalDispatched) return;/if (generation !== this.lifecycleGeneration || terminalDispatched) return; \/\/ MUTATION/' "$ADAPTER"
grep -Fq 'MUTATION' "$ADAPTER"
expect_red reconnect-prior-ready 'spurious reconnect before first ready cannot mark health connected'
cp /tmp/test623-adapter.ts "$ADAPTER"

echo "L6 restored green"
run_lifecycle
echo "RESULT: PASS"
