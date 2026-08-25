#!/usr/bin/env bash
set -euo pipefail

cd /app
echo "source_commit=${TEST1193_SOURCE_COMMIT}"
bun test agent-node/src/runtime/side-thread/domain.test.ts \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.test.ts

# Witness red: if the exact pinned-version gate is weakened, the capability
# matrix test must fail. Work only on the container copy.
cp agent-node/src/runtime/side-thread/codex-app-server-adapter.ts /tmp/adapter.ts
sed -i 's/this\.opts\.runtimeVersion !== "0\.148\.0"/false/' \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.ts
if bun test agent-node/src/runtime/side-thread/codex-app-server-adapter.test.ts \
    >/tmp/mutation.log 2>&1; then
  echo "FAIL version fail-closed mutation survived"
  exit 1
fi
mv /tmp/adapter.ts agent-node/src/runtime/side-thread/codex-app-server-adapter.ts

echo "PASS test1193 side-thread domain/adapter contract + witnessed red"
