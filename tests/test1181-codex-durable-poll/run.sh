#!/bin/sh
set -eu

cd /workspace

echo "L1 environment + pure durable compensator"
bun test agent-node/src/runtime/commhub-poll-compensator.test.ts

echo "L2 fault/reconnect + existing single-flight/steer ownership"
bun test \
  agent-node/src/runtime/inbox-drain-lane.test.ts \
  agent-node/src/runtime/codex-app-server-bridge.test.ts \
  agent-node/src/runtime/codex-app-server/runtime.test.ts

echo "L2 witnessed-red mutations"
./witnessed-red.sh

echo "L3 production bundle"
cd agent-node
bun run build
