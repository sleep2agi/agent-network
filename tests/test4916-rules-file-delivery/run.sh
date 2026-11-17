#!/usr/bin/env bash
set -euo pipefail
bun test tests/test4916-rules-file-delivery/poll.test.ts agent-node/src/runtime/rules-file.test.ts
bun test agent-network/src/node-server*.test.ts agent-network/src/channel-inbox-wake.test.ts
for file in rules-file-transport rules-file-session-target node-request-retention report-status-handover-capabilities-http; do
  COMMHUB_DB="/tmp/4916-${file}.db" bun test "server/src/${file}.test.ts"
done
bun build agent-network/src/node-server.ts --target node --outfile /tmp/4916-node-server.js
bun build agent-node/src/cli.ts --target node --outfile /tmp/4916-agent-node.js
bun tests/test4916-rules-file-delivery/lost-doorbell.ts
bun tests/test4916-rules-file-delivery/lost-doorbell.ts --channel
