#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
bun /fixture/probe.ts
