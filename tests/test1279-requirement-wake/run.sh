#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT scope=opt-in SQLite scoped-requirement-wake"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test1279.js
COMMHUB_DB=/tmp/test1279-wake.db bun test server/src/scheduled-requirement-wake-http.test.ts
COMMHUB_DB=/tmp/test1279-backoff.db bun test server/src/scheduled-backoff-http.test.ts
COMMHUB_DB=/tmp/test1279-agent.db bun test server/src/schedule-agent-mcp-http.test.ts
COMMHUB_DB=/tmp/test1279-shape.db bun test server/src/rest-explicit-columns-http.test.ts
COMMHUB_DB=/tmp/test1279-audience.db bun test server/src/tool-audience-http.test.ts -t "bytes per role"
echo "RESULT: PASS; synthetic event/state only, no production policy adoption"
