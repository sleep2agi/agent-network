#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test617-feishu-ws-readiness.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test617 — Feishu WS readiness and worker health"
echo "source_commit=${TEST617_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_lifecycle() {
  bun test agent-network/src/im/feishu/adapter-lifecycle.test.ts
}

echo "L0 environment + typecheck"
bun --version
cd /workspace/agent-network
bun run typecheck
cd /workspace

echo "L1 lifecycle matrix"
run_lifecycle

echo "L2 real worker bundle"
cd /workspace/agent-network
bun run build
cd /workspace
test -s agent-network/dist/src/im/feishu/worker.js

echo "L3 witnessed-red: SDK start promise must not impersonate readiness"
cp agent-network/src/im/feishu/adapter.ts /tmp/test617-adapter.ts
sed -i 's/^    await readyPromise;$/    return; \/\/ MUTATION: trust SDK start resolution/' \
  agent-network/src/im/feishu/adapter.ts
grep -Fq 'MUTATION: trust SDK start resolution' agent-network/src/im/feishu/adapter.ts
set +e
run_lifecycle >/tmp/test617-ready.log 2>&1
ready_rc=$?
set -e
if [ "$ready_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: ready-authority"
  exit 1
fi
grep -Fq 'missing onReady times out fail-closed' /tmp/test617-ready.log
echo "MUTATION_RED: ready-authority rc=$ready_rc"
cp /tmp/test617-adapter.ts agent-network/src/im/feishu/adapter.ts

echo "L4 witnessed-red: reconnecting must lower health"
sed -i '/onReconnecting: () => {/,/onReconnected: () => {/ {
  /this.health_ = { ...this.health_, connected: false };/d
}' agent-network/src/im/feishu/adapter.ts
if sed -n '/onReconnecting: () => {/,/onReconnected: () => {/p' \
  agent-network/src/im/feishu/adapter.ts | grep -Fq 'connected: false'; then
  echo "FAIL: reconnect mutation did not apply"
  exit 1
fi
set +e
run_lifecycle >/tmp/test617-reconnect.log 2>&1
reconnect_rc=$?
set -e
if [ "$reconnect_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: reconnect-health"
  exit 1
fi
grep -Fq 'reconnecting lowers health' /tmp/test617-reconnect.log
echo "MUTATION_RED: reconnect-health rc=$reconnect_rc"
cp /tmp/test617-adapter.ts agent-network/src/im/feishu/adapter.ts

echo "L5 witnessed-red: terminal worker failure must be non-zero"
cp agent-network/src/im/feishu/worker-lifecycle.ts /tmp/test617-worker-lifecycle.ts
sed -i 's/boundary.exit(1);/boundary.exit(0); \/\/ MUTATION/' \
  agent-network/src/im/feishu/worker-lifecycle.ts
grep -Fq 'boundary.exit(0); // MUTATION' agent-network/src/im/feishu/worker-lifecycle.ts
set +e
run_lifecycle >/tmp/test617-worker.log 2>&1
worker_rc=$?
set -e
if [ "$worker_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: worker-nonzero-exit"
  exit 1
fi
grep -Fq 'worker terminal owner logs safely and exits non-zero' /tmp/test617-worker.log
echo "MUTATION_RED: worker-nonzero-exit rc=$worker_rc"
cp /tmp/test617-worker-lifecycle.ts agent-network/src/im/feishu/worker-lifecycle.ts

echo "L6 restored green"
run_lifecycle

echo "RESULT: PASS"
