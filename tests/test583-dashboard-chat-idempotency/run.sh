#!/bin/sh
set -eu

export COMMHUB_DB=/tmp/test583-chat-idempotency.db
rm -f "$COMMHUB_DB" "$COMMHUB_DB-wal" "$COMMHUB_DB-shm"
bun test src/task-idempotency.test.ts src/task-idempotency-mcp.test.ts
