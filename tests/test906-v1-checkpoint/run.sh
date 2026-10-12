#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
test "$(opencode --version)" = "$OPENCODE_VERSION_UNDER_TEST"
echo "source: $SOURCE_COMMIT native: $OPENCODE_VERSION_UNDER_TEST"
cd /agent-node-src
bun test src/runtime/opencode-copresence/v1-checkpoint.test.ts
timeout 120s bun /fixture-checkpoint/probe.ts
