#!/usr/bin/env bash
set -euo pipefail

cd /app
echo "source_commit=${TEST1193_SOURCE_COMMIT}"
bun test agent-node/src/runtime/side-thread/*.test.ts
bun build --target=bun \
  agent-node/src/runtime/side-thread/domain.ts \
  agent-node/src/runtime/side-thread/operation-ledger.ts \
  agent-node/src/runtime/side-thread/fork-lease.ts \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.ts \
  --outdir /tmp/test1193-build >/tmp/test1193-build.log

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

# Witness red: bypassing the kernel executor claim must make the coordinated
# two-process fork race observe two mutating RPCs.
cp agent-node/src/runtime/side-thread/codex-app-server-adapter.ts /tmp/adapter.ts
sed -i 's/try { claim = await this\.opts\.forkLeaseStore\.claim(identity\.nodeId, input\.sourceThreadId); }/try { claim = { release: async () => {} }; }/' \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.ts
grep -F 'try { claim = { release: async () => {} }; }' \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.ts >/dev/null
if bun test agent-node/src/runtime/side-thread/fork-process-race.test.ts \
    >/tmp/fork-claim-mutation.log 2>&1; then
  echo "FAIL fork executor claim mutation survived"
  exit 1
fi
mv /tmp/adapter.ts agent-node/src/runtime/side-thread/codex-app-server-adapter.ts

echo "PASS test1193 side-thread domain/adapter contract + witnessed red"
