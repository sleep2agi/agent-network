#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
bun test /repo/agent-node/src/runtime/opencode-acp/child-env.test.ts /repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint.test.ts
bun /fixture/probe.ts
