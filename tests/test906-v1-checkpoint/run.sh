#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
test "$(opencode --version)" = "$OPENCODE_VERSION_UNDER_TEST"
echo "source: $SOURCE_COMMIT native: $OPENCODE_VERSION_UNDER_TEST"
cd /repo/agent-node
bun test src/runtime/opencode-copresence/v1-checkpoint.test.ts
export TEST906_ROOT
TEST906_ROOT="$(mktemp -d /tmp/test906-legacy.XXXXXXXX)"
timeout 120s bun /fixture-checkpoint/probe.ts --config "$TEST906_ROOT/node/config.json"
