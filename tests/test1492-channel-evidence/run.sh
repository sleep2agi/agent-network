#!/usr/bin/env bash
set -eu
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
echo "source_commit=$SOURCE_COMMIT"
# No mounted HOME/auth/session files; runner uses --network none (loopback only).
# Layer 1: pure truth tables / transport faults. A red layer stops the run.
bun test agent-network/src/channel-delivery.test.ts server/src/channel-delivery-evidence.test.ts server/src/task-diagnostic.test.ts
# Layer 2: existing reply and channel metadata contracts.
bun test agent-network/src/channel-peer-reply.test.ts agent-network/src/node-server-channel-meta.test.ts
# Layer 3: real localhost MCP/HTTP and disposable SQLite; synthetic identities.
bun test server/src/channel-delivery-http.test.ts
# Layer 4: existing ownership/runtime evidence and REST diagnostic regressions.
COMMHUB_DB=/tmp/1492-consumption.db bun test server/src/task-consumption.test.ts
COMMHUB_DB=/tmp/1492-diagnostic.db bun test server/src/task-diagnostic-http.test.ts
# Layer 5: behavioral mutation controls in disposable /tmp source copies.
node tests/test1492-channel-evidence/mutants.mjs
