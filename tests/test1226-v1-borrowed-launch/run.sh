#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
timeout 420s bun /fixture/probe.ts
timeout 60s bun test /repo/agent-node/src/runtime/opencode-v1-spawn-snapshot.test.ts /repo/agent-node/src/runtime/opencode-copresence/reply-ownership.test.ts /repo/agent-node/src/runtime/opencode-copresence/runtime.test.ts /repo/agent-node/src/runtime/opencode-copresence/v1-borrowed-cli.test.ts
timeout 60s bun test /repo/agent-node/src/runtime/opencode-start-completion.test.ts /repo/agent-node/src/runtime/opencode-copresence/launcher-health.test.ts
cmp /repo/agent-network/src/shared/opencode-borrowed-launch-health.ts /repo/agent-node/src/shared/opencode-borrowed-launch-health.ts
