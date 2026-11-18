#!/usr/bin/env bash
set -euo pipefail
bun test agent-node/src/runtime/daemon-opencode-free-provider.test.ts agent-network/src/daemon-provider-store.test.ts
# The preceding atomic primitives must pass before transport/integration tests.
bun test server/src/daemon-provider-snapshots.test.ts
bun tests/test3636-daemon-opencode-free/native.ts
