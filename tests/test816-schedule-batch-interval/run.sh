#!/usr/bin/env bash
set -euo pipefail
cd /work/server
COMMHUB_DB=/tmp/test816-schedules.db bun test src/schedule-agent-mcp-http.test.ts
COMMHUB_DB=/tmp/test816-audience.db bun test src/tool-audience-http.test.ts
