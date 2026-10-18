#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
timeout 420s bun /fixture/probe.ts

timeout 60s bun test /repo/agent-node/src/runtime/opencode-v1-spawn-snapshot.test.ts /repo/agent-node/src/runtime/opencode-copresence/reply-ownership.test.ts /repo/agent-node/src/runtime/opencode-copresence/runtime.test.ts

# Run the existing three abort-ownership mutations against a private writable
# source copy. Keep production sources and the baseline assertions untouched.
mkdir -p /tmp/mutation651/agent-node
cp -R /repo/agent-node/src /tmp/mutation651/agent-node/src
ln -s /repo/agent-node/node_modules /tmp/mutation651/agent-node/node_modules
ln -s /repo/agent-network /tmp/mutation651/agent-network
sed 's|cd /agent-node-src|cd /tmp/mutation651/agent-node|' /fixture/timeout-mutation.sh > /tmp/mutation651/run.sh
TEST651_SOURCE_COMMIT="$SOURCE_COMMIT" REPORT=/tmp/mutation651/report.txt timeout 60s bash /tmp/mutation651/run.sh
