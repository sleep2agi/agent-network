#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test634-windows-secret-guidance.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test634 — Windows secret shell guidance"
echo "source_commit=${TEST634_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

cd /workspace

run_tests() {
  bun test \
    agent-network/src/secret-shell-guidance.test.ts \
    agent-network/src/secret-shell-guidance-wiring.test.ts
}

echo "L0 platform semantics + both production call sites"
run_tests

echo "L1 real CLI bundle"
bun build agent-network/bin/cli.ts \
  --outdir /tmp/test634-dist \
  --entry-naming cli.js \
  --target node \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite \
  --external '../../server/*'
test -s /tmp/test634-dist/cli.js

echo "L2 witnessed-red: disable the Windows PowerShell branch"
cp agent-network/src/secret-shell-guidance.ts /tmp/test634-guidance.ts
sed -i 's/platform === "win32"/false/g' agent-network/src/secret-shell-guidance.ts
grep -Fq 'if (false)' agent-network/src/secret-shell-guidance.ts
set +e
run_tests > /tmp/test634-platform-mutation.log 2>&1
platform_rc=$?
set -e
if [ "$platform_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: windows-platform-branch"
  exit 1
fi
echo "MUTATION_RED: windows-platform-branch rc=$platform_rc"
cp /tmp/test634-guidance.ts agent-network/src/secret-shell-guidance.ts

echo "L3 witnessed-red: bypass platform-aware guidance in migrate"
cp agent-network/bin/cli.ts /tmp/test634-cli.ts
sed -i 's/assignmentLines.push(formatSecretAssignment(process.platform, refName, value));/assignmentLines.push(`export ${refName}=${value}`);/' agent-network/bin/cli.ts
grep -Fq 'assignmentLines.push(`export ${refName}=${value}`);' agent-network/bin/cli.ts
set +e
run_tests > /tmp/test634-wiring-mutation.log 2>&1
wiring_rc=$?
set -e
if [ "$wiring_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: migrate-wiring"
  exit 1
fi
echo "MUTATION_RED: migrate-wiring rc=$wiring_rc"
cp /tmp/test634-cli.ts agent-network/bin/cli.ts

echo "L4 restored green"
run_tests

echo "RESULT: PASS"
