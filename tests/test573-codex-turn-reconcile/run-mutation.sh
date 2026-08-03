#!/usr/bin/env bash
set -euo pipefail

mutation="${1:?mutation name required}"
rm -rf /tmp/agent-node-under-test
cp -a /workspace/agent-node /tmp/agent-node-under-test
bun /harness/mutate.mjs "$mutation" /tmp/agent-node-under-test

bun test \
  /tmp/agent-node-under-test/src/runtime/codex-app-server-bridge.test.ts \
  /tmp/agent-node-under-test/src/runtime/codex-app-server/runtime.test.ts
