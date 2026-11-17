#!/usr/bin/env bash
set -euo pipefail
bun test agent-node/src/runtime/create-node-daemon.test.ts agent-node/src/runtime/create-node-daemon-private-wiring.test.ts agent-node/src/runtime/clone-node.test.ts agent-node/src/runtime/daemon-cli-launch.test.ts agent-node/src/runtime/daemon-windows-paths.test.ts
for scenario in different-hub missing invalid-json; do
  RFC044_CLOUD_CONFIG_CASE="$scenario" bun tests/test-rfc044-windows-daemon/smoke.ts
done
