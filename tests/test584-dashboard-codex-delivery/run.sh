#!/usr/bin/env bash
set -euo pipefail

echo "TEST584 source=${TEST584_SOURCE_COMMIT:-unknown}"

echo "L1 source/build gates"
test -f agent-node/src/inbox-dispatch.ts
test -f server/src/task-auth-origin.ts
bun build agent-node/src/cli.ts \
  --outdir /tmp/test584-dist \
  --entry-naming cli.js \
  --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk
test -s /tmp/test584-dist/cli.js

echo "L2 agent bridge + dispatch"
bun test \
  agent-node/src/inbox-dispatch.test.ts \
  agent-node/src/runtime/codex-app-server-bridge.test.ts \
  agent-node/src/runtime/codex-app-server/runtime.test.ts

echo "L3 Hub auth boundary + rolling idempotency"
export NODE_ENV=test
export COMMHUB_DB=/tmp/test584-hub.db
bun test \
  server/src/task-auth-origin.test.ts \
  server/src/task-idempotency.test.ts \
  server/src/task-idempotency-mcp.test.ts

echo "L4 real private HTTP Hub user/node origin"
export COMMHUB_DB=/tmp/test584-http.db
bun test server/src/task-auth-origin-http.test.ts

expect_red() {
  local label=$1
  shift
  set +e
  "$@" >/tmp/test584-mutation.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    cat /tmp/test584-mutation.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L5 witnessed-red security/correctness mutations"
cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  'if (meta.auth_origin === "user") return true;' \
  'if (meta.auth_origin === "user" || meta.auth_origin === "node") return true;'
expect_red node-origin-cannot-steer bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  'if (concurrent) {' \
  'if (false) {'
expect_red no-head-of-line-serialization bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /harness/mutate.ts agent-node/src/runtime/codex-app-server-bridge.ts \
  '        expectedTurnId,' \
  '        /* expectedTurnId deliberately removed */'
expect_red exact-expected-turn-id bun test agent-node/src/runtime/codex-app-server-bridge.test.ts
cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts

cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /harness/mutate.ts agent-node/src/runtime/codex-app-server-bridge.ts \
  '        this.emitSteeredTask(steered, task, steered.terminal);' \
  '        /* reply attribution deliberately removed */'
expect_red accepted-steer-must-reply bun test agent-node/src/runtime/codex-app-server-bridge.test.ts
cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts

echo "RESULT: PASS"
