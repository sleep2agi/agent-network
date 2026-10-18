#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
opencode attach --help
timeout 360s bun /fixture/probe.ts
