#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
echo "TEST-ONLY source=$SOURCE_COMMIT scope=opt-in SQLite interval-backoff"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test1278.js
COMMHUB_DB=/tmp/test1278-backoff.db bun test server/src/scheduled-backoff-http.test.ts
COMMHUB_DB=/tmp/test1278-outcome.db bun test server/src/scheduled-work-outcome-http.test.ts
COMMHUB_DB=/tmp/test1278-shape.db bun test server/src/rest-explicit-columns-http.test.ts
COMMHUB_DB=/tmp/test1278-agent.db bun test server/src/schedule-agent-mcp-http.test.ts
COMMHUB_DB=/tmp/test1278-edit.db bun test server/src/scheduled-tasks-http.test.ts
COMMHUB_DB=/tmp/test1278-terminal.db bun test server/src/scheduled-run-terminal.test.ts
COMMHUB_DB=/tmp/test1278-audience.db bun test server/src/tool-audience-http.test.ts -t "bytes per role"
echo "RESULT: PASS; source-only, no live frequency adoption or domain-event watcher"
