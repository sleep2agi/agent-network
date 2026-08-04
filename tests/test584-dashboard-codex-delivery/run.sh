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
  agent-node/src/inbox-dispatch-wiring.test.ts \
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
  'return meta.auth_origin === "user";' \
  'return meta.auth_origin === "user" || meta.auth_origin === "node";'
expect_red node-origin-cannot-steer bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/cli.ts /tmp/agent-node-cli.ts
bun /harness/mutate.ts agent-node/src/cli.ts \
  '    const dispatch = codexInboxDispatcher.submit(messages, processInboxMessage);' \
  '    const dispatch = await dispatchInboxBatch(messages, processInboxMessage) as any;'
expect_red later-sse-kick-cannot-wait-for-active-turn bun test agent-node/src/inbox-dispatch-wiring.test.ts
cp /tmp/agent-node-cli.ts agent-node/src/cli.ts

cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  'activeKeys.has(key) || queuedKeys.has(key)' \
  'false'
expect_red same-tick-row-claim-is-unique bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  'activeKeys.size < opts.maxConcurrent' \
  'true'
expect_red detached-admission-cap-is-real bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  '          opts.onSettled?.();' \
  '          /* next Hub inbox window wake removed */'
expect_red settled-row-must-wake-next-hub-window bun test agent-node/src/inbox-dispatch.test.ts
cp /tmp/inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

cp agent-node/src/inbox-dispatch.ts /tmp/inbox-dispatch.ts
bun /harness/mutate.ts agent-node/src/inbox-dispatch.ts \
  '  return runtime !== "codex-app-server" || inflightRows === 0;' \
  '  return true;'
expect_red pending-reply-drain-cannot-race-active-row bun test agent-node/src/inbox-dispatch.test.ts
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

cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /harness/mutate.ts agent-node/src/runtime/codex-app-server-bridge.ts \
  'if (input.steerIfExternalTurn && this.externalActiveTurnSteerable) {' \
  'if (input.steerIfExternalTurn) {'
expect_red reconnect-network-turn-stays-fifo bun test agent-node/src/runtime/codex-app-server-bridge.test.ts
cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts

cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /harness/mutate.ts agent-node/src/runtime/codex-app-server-bridge.ts \
  '!/^\s*\[Agent Network(?:\/|\])/u.test(firstUserText)' \
  '!/^\[Agent Network(?:\/|\])/u.test(firstUserText)'
expect_red leading-whitespace-network-prefix-stays-fifo bun test agent-node/src/runtime/codex-app-server-bridge.test.ts
cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts

cp server/src/tools.ts /tmp/server-tools.ts
bun /harness/mutate.ts server/src/tools.ts \
  'normalizeMetaJson(stampTaskAuthOrigin(meta, authOrigin))' \
  'normalizeMetaJson(meta)'
export COMMHUB_DB=/tmp/test584-mutation-mcp.db
expect_red mcp-node-cannot-forge-user-origin bun test server/src/task-idempotency-mcp.test.ts
cp /tmp/server-tools.ts server/src/tools.ts

cp server/src/server.ts /tmp/server-server.ts
bun /harness/mutate.ts server/src/server.ts \
  'normalizeMetaJson(stampTaskAuthOrigin(mergedMeta, authOrigin))' \
  'normalizeMetaJson(mergedMeta)'
export COMMHUB_DB=/tmp/test584-mutation-rest.db
expect_red rest-node-cannot-forge-user-origin bun test server/src/task-auth-origin-http.test.ts
cp /tmp/server-server.ts server/src/server.ts

echo "RESULT: PASS"
