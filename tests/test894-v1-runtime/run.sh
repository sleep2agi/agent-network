#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p "${ARTIFACT_DIR:-/tmp/art}"
exec > >(tee "${ARTIFACT_DIR:-/tmp/art}/report-test894-v1-runtime.txt") 2>&1
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
echo "source: $SOURCE_COMMIT"
sha256sum /agent-node-src/src/runtime/opencode-copresence/runtime.ts /fixture/probe.ts
test "$(id -u)" != 0
test "$(opencode --version)" = 1.18.34
timeout 150s bun /fixture/probe.ts
set +e
TEST_WRONG_MODEL=1 timeout 150s bun /fixture/probe.ts >/tmp/v1-negative.txt 2>&1
code=$?
set -e
cat /tmp/v1-negative.txt
test "$code" = 1
grep -Fx 'PASS: real V1 reply and attached TUI' /tmp/v1-negative.txt
grep -Fx 'AssertionError: provider model mismatch' /tmp/v1-negative.txt
echo 'PASS: wrong-model exact negative control'
