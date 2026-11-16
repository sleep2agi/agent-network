#!/bin/bash
set -euo pipefail
bun test agent-node/src/runtime/daemon-cli-launch.test.ts agent-node/src/runtime/daemon-windows-paths.test.ts agent-network/src/windows-runtime.test.ts
bun test agent-node/src/runtime/create-node-daemon.test.ts agent-network/src/daemon-anet-bin.test.ts
bun test agent-node/src/runtime/stop-daemon-windows.test.ts agent-node/src/runtime/stop-daemon.test.ts agent-node/src/runtime/stop-daemon-copresence.test.ts agent-network/src/windows-stop-identity.test.ts
