#!/usr/bin/env bash
set -euo pipefail

mutation="${1:?mutation name required}"
rm -rf /tmp/agent-node-under-test
mkdir -p /tmp/agent-node-under-test
cp -a /workspace/agent-node/src /workspace/agent-node/package.json /tmp/agent-node-under-test/
ln -s /workspace/agent-node/node_modules /tmp/agent-node-under-test/node_modules
bun /harness/mutate.mjs "$mutation" /tmp/agent-node-under-test

bun test \
  /tmp/agent-node-under-test/src/runtime/codex-app-server-bridge.test.ts \
  /tmp/agent-node-under-test/src/runtime/codex-app-server/runtime.test.ts
