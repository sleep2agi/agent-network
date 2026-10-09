#!/usr/bin/env bash
set -euo pipefail
cd /work/agent-node
bun test src/runtime/start-daemon.test.ts src/runtime/child-workdir.test.ts src/runtime/adopt-daemon.test.ts
cd /work/server
COMMHUB_DB=/tmp/test819-start.db bun test src/start-node.test.ts
