#!/usr/bin/env bash
set -euo pipefail

mutation="${1:?mutation name required}"
rm -rf /tmp/agent-node-under-test
cp -a /workspace/agent-node /tmp/agent-node-under-test
bun /workspace/tests/test575-opencode-reply-ownership/mutate.mjs \
  "$mutation" \
  /tmp/agent-node-under-test/src/runtime/opencode-copresence/runtime.ts
cd /tmp/agent-node-under-test
case "$mutation" in
  drop-reply-ownership)
    test_name="refuses a reply owned by a human turn that won the idle-to-submit race"
    ;;
  drop-idle-stability)
    test_name="waits past OpenCode's status-idle to Runner-cleanup gap before the next network turn"
    ;;
  *)
    echo "unknown mutation: $mutation" >&2
    exit 2
    ;;
esac
bun test src/runtime/opencode-copresence/runtime.test.ts -t "$test_name"
