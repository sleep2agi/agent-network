#!/usr/bin/env bash
set -euo pipefail

rm -rf /tmp/agent-node-under-test
cp -a /workspace/agent-node /tmp/agent-node-under-test
bun /workspace/tests/test575-opencode-reply-ownership/mutate.mjs \
  /tmp/agent-node-under-test/src/runtime/opencode-copresence/runtime.ts
cd /tmp/agent-node-under-test
bun test src/runtime/opencode-copresence/runtime.test.ts \
  -t "refuses a reply owned by a human turn that won the idle-to-submit race"
