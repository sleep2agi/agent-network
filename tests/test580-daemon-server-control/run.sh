#!/usr/bin/env bash
set -euo pipefail
export TZ=Asia/Shanghai
cd /app/server
export COMMHUB_DB=/tmp/test580-hub.db
rm -f "$COMMHUB_DB" "$COMMHUB_DB-wal" "$COMMHUB_DB-shm"
bun test src/daemon-control.test.ts src/daemon-control-tools.test.ts
cd /app/agent-node
bun test src/runtime/host-control-daemon.test.ts
