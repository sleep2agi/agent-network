#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
echo "source: $SOURCE_COMMIT"
sha256sum /agent-node-src/src/runtime/opencode-acp/runtime.ts /fixture-acp/probe.ts
timeout 60s bun /fixture-acp/probe.ts
set +e
TEST_WRONG_SESSION=1 timeout 60s bun /fixture-acp/probe.ts >/tmp/acp-negative.txt 2>&1
code=$?
set -e
cat /tmp/acp-negative.txt
test "$code" = 1
grep -Fx 'PASS: actual ACP initialize and session/new with persisted identity' /tmp/acp-negative.txt
grep -Fx 'PASS: live child receives safe policy and isolated workspace (configuration only)' /tmp/acp-negative.txt
grep -F 'AssertionError: ACP session identity mismatch' /tmp/acp-negative.txt
grep -Fx 'PASS: native process exit and runtime-owned launch cleanup' /tmp/acp-negative.txt
echo 'PASS: wrong-session exact negative control'
