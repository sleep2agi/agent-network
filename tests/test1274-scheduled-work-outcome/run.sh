#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT scope=explicit-successful-work-outcome SQLite-only"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test1274.js
COMMHUB_DB=/tmp/test1274-work.db bun test server/src/scheduled-work-outcome-http.test.ts
COMMHUB_DB=/tmp/test1274-terminal.db bun test server/src/scheduled-run-terminal.test.ts
COMMHUB_DB=/tmp/test1274-schedule.db bun test server/src/scheduled-tasks-http.test.ts
echo "RESULT: PASS; no automatic backoff, production deployment, original node or model operation"
