#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
cd /repo/agent-node
bun test src/runtime/opencode-copresence/v1-shared-capture.test.ts src/runtime/opencode-copresence/v1-checkpoint.test.ts
timeout 150s bun /fixture/probe.ts
