#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test633-doctor-locale.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test633 — doctor locale diagnostic"
echo "source_commit=${TEST633_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

cd /workspace

run_tests() {
  bun test \
    agent-network/src/locale-diagnostic.test.ts \
    agent-network/src/locale-diagnostic-wiring.test.ts
}

echo "L0 helper semantics + production wiring"
run_tests

echo "L1 real CLI bundle"
bun build agent-network/bin/cli.ts \
  --outdir /tmp/test633-dist \
  --entry-naming cli.js \
  --target node \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite \
  --external '../../server/*'
test -s /tmp/test633-dist/cli.js

echo "L2 real doctor output under non-UTF-8 and UTF-8 locales"
WORK=$(mktemp -d /tmp/test633-home.XXXXXX)
trap 'safe_rm_rf "$WORK"' EXIT
mkdir -p "$WORK/cwd"

env -i PATH="$PATH" HOME="$WORK" LANG=C LC_ALL=C \
  node /tmp/test633-dist/cli.js doctor > /tmp/test633-c.log 2>&1
grep -Fq '⚠  System locale: LC_ALL=C is not UTF-8' /tmp/test633-c.log
grep -Fq 'export LANG=C.UTF-8 LC_ALL=C.UTF-8' /tmp/test633-c.log

env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  node /tmp/test633-dist/cli.js doctor > /tmp/test633-utf8.log 2>&1
if grep -Fq 'System locale' /tmp/test633-utf8.log; then
  echo "FAIL: UTF-8 locale produced a warning"
  exit 1
fi

echo "L3 witnessed-red: weaken UTF-8 detection to accept every locale"
cp agent-network/src/locale-diagnostic.ts /tmp/test633-locale.ts
sed -i 's/shouldWarn: !\/utf-?8\/i.test(value)/shouldWarn: !\/.\/i.test(value)/' agent-network/src/locale-diagnostic.ts
grep -Fq 'shouldWarn: !/./i.test(value)' agent-network/src/locale-diagnostic.ts
set +e
run_tests > /tmp/test633-detection-mutation.log 2>&1
detection_rc=$?
set -e
if [ "$detection_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: locale-detection"
  exit 1
fi
echo "MUTATION_RED: locale-detection rc=$detection_rc"
cp /tmp/test633-locale.ts agent-network/src/locale-diagnostic.ts

echo "L4 witnessed-red: bypass the diagnostic in doctor"
cp agent-network/bin/cli.ts /tmp/test633-cli.ts
sed -i 's/const locale = diagnoseLocale(process.env, process.platform);/const locale = { shouldWarn: false, effectiveVariable: null, effectiveValue: null };/' agent-network/bin/cli.ts
grep -Fq 'const locale = { shouldWarn: false' agent-network/bin/cli.ts
set +e
run_tests > /tmp/test633-wiring-mutation.log 2>&1
wiring_rc=$?
set -e
if [ "$wiring_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: doctor-wiring"
  exit 1
fi
echo "MUTATION_RED: doctor-wiring rc=$wiring_rc"
cp /tmp/test633-cli.ts agent-network/bin/cli.ts

echo "L5 restored green"
run_tests

echo "RESULT: PASS"
