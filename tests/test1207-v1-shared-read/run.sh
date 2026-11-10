#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
cd /repo/agent-node
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
bun test src/runtime/opencode-copresence/v1-shared-read.test.ts
timeout 90s bun /fixture/probe.ts
if [[ "$OPENCODE_VERSION_UNDER_TEST" == "1.18.34" ]]; then
  bun test src/runtime/opencode-v1-spawn-snapshot.test.ts src/runtime/opencode-copresence/runtime.test.ts
fi
