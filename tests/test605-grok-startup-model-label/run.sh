#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test605-grok-startup-model-label.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test605 — Grok startup model label"
echo "source_commit=${TEST605_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_banner_test() {
  bun test agent-node/src/runtime-effective-label.test.ts
}

run_acp_argv_test() {
  bun test agent-node/src/runtime/grok-build-acp/client.test.ts --test-name-pattern 'without inventing a model flag'
}

expect_red() {
  local label=$1
  shift
  set +e
  "$@" >/tmp/test605-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,200p' /tmp/test605-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 build real agent-node entrypoint"
cd agent-node
bun run build
test -s dist/cli.js
cd /workspace

echo "L1 real CLI banner + real ACP child argv"
run_banner_test
run_acp_argv_test

echo "L2 user-facing documentation"
grep -Fq 'model:   configured by Grok CLI' docs/grok-build-runtime.md
! grep -Fq 'model:   grok-build (default)' docs/grok-build-runtime.md
grep -Fq 'model id.' docs/grok-build-runtime.md

cp agent-node/src/cli.ts /tmp/test605-cli.ts
cp agent-node/src/runtime/grok-build-acp/client.ts /tmp/test605-client.ts

echo "L3 witnessed-red: runtime alias must not return as model id"
sed -i 's/? "configured by Grok CLI"/? "grok-build"/' agent-node/src/cli.ts
grep -Fq '? "grok-build"' agent-node/src/cli.ts
expect_red grok-runtime-alias-is-not-model run_banner_test
cp /tmp/test605-cli.ts agent-node/src/cli.ts

echo "L4 witnessed-red: ACP spawn must not acquire a model flag"
sed -i 's/\["agent", "stdio"\]/["agent", "stdio", "--model", "grok-build"]/' agent-node/src/runtime/grok-build-acp/client.ts
grep -Fq '["agent", "stdio", "--model", "grok-build"]' agent-node/src/runtime/grok-build-acp/client.ts
expect_red acp-argv-has-no-invented-model run_acp_argv_test
cp /tmp/test605-client.ts agent-node/src/runtime/grok-build-acp/client.ts

echo "L5 restored green"
run_banner_test
run_acp_argv_test

echo "RESULT: PASS"
