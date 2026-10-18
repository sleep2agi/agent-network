#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT scope=opt-in dispatch guidance; synthetic producer, no real model adoption"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test1284.js
COMMHUB_DB=/tmp/test1284-guidance.db bun test server/src/scheduled-outcome-guidance-http.test.ts
COMMHUB_DB=/tmp/test1284-outcome.db bun test server/src/scheduled-work-outcome-http.test.ts
COMMHUB_DB=/tmp/test1284-backoff.db bun test server/src/scheduled-backoff-http.test.ts
COMMHUB_DB=/tmp/test1284-wake.db bun test server/src/scheduled-requirement-wake-http.test.ts
COMMHUB_DB=/tmp/test1284-agent.db bun test server/src/schedule-agent-mcp-http.test.ts
COMMHUB_DB=/tmp/test1284-audience.db bun test server/src/tool-audience-http.test.ts -t "bytes per role"
echo "RESULT: PASS; dispatch guidance and explicit synthetic reply only, no production adoption"
