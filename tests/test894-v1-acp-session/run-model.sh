#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
echo "source: $SOURCE_COMMIT"
sha256sum /fixture-acp/probe-model.ts /fixture-acp/provider-proxy.py
timeout 90s bun /fixture-acp/probe-model.ts
TEST_UNAVAILABLE_MODEL=1 timeout 90s bun /fixture-acp/probe-model.ts
set +e
TEST_WRONG_MODEL=1 timeout 90s bun /fixture-acp/probe-model.ts >/tmp/model-negative.txt 2>&1
code=$?
set -e
cat /tmp/model-negative.txt
test "$code" = 1
grep -Fx 'PASS: real ACP consumes fixture-only model response' /tmp/model-negative.txt
grep -F 'AssertionError: safe ACP provider model mismatch' /tmp/model-negative.txt
grep -Fx 'PASS: ACP, fixture process, ephemeral certificate and launch cleanup' /tmp/model-negative.txt
echo 'PASS: safe ACP exact wrong-model negative control'
