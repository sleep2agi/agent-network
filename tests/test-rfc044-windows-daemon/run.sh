#!/bin/bash
set -euo pipefail
bun test agent-node/src/runtime/daemon-cli-launch.test.ts agent-node/src/runtime/daemon-windows-paths.test.ts
bun test agent-node/src/runtime/create-node-daemon.test.ts agent-network/src/daemon-anet-bin.test.ts
