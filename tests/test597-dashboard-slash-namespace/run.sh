#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test597-dashboard-slash-namespace.txt"
MUTATE=/workspace/tests/test597-dashboard-slash-namespace/mutate.ts
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test597 — Dashboard native slash / Agent Network scheduler namespace"
echo "source_commit=${TEST597_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

expect_red() {
  local label=$1
  shift
  set +e
  "$@" >/tmp/test597-mutation.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,200p' /tmp/test597-mutation.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 source and build"
test -f agent-node/src/goals/routing.ts
test -f server/src/dashboard-slash-routing-http.test.ts
bun build agent-node/src/cli.ts --outfile /tmp/test597-agent-node.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk \
  --external node-pty
test -s /tmp/test597-agent-node.js
(cd agent-network && bun run typecheck)

echo "L1 parser, routing, dispatch, and self-management"
bun test \
  agent-node/src/goals/parser.test.ts \
  agent-node/src/goals/routing.test.ts \
  agent-node/src/inbox-dispatch.test.ts \
  agent-node/src/goals/self-loop-tools.test.ts

echo "L2 real Hub binary + real SQLite authentication boundary"
export NODE_ENV=test
export COMMHUB_DB=/tmp/test597-hub.db
bun test server/src/dashboard-slash-routing-http.test.ts

echo "L3 real bridge websocket + shared-thread reply"
bun test agent-node/src/runtime/codex-app-server-bridge.test.ts \
  --test-name-pattern 'authenticated Dashboard native /goal'

echo "L4 real CLI wire"
bun test tests/test597-dashboard-slash-namespace/cli-wire.test.ts

echo "L5 production wiring"
grep -Fq 'const interactiveDashboardTask = isInteractiveDashboardTask(msg);' agent-node/src/cli.ts
grep -Fq 'shouldCreateScheduledGoal(persistenceSafeContent, RUNTIME, interactiveDashboardTask)' agent-node/src/cli.ts
grep -Fq 'const preparedReply = prepareDashboardNativeSlashReply(' agent-node/src/cli.ts
grep -Fq 'const slashCmd = `/aloop ${everyRaw} ${taskText}`;' agent-network/bin/cli.ts

echo "L6 witnessed-red mutations"
cp agent-node/src/goals/routing.ts /tmp/test597-routing.ts
bun "$MUTATE" agent-node/src/goals/routing.ts \
  '  return !interactiveDashboardTask;' \
  '  return true;'
expect_red dashboard-native-slash-must-not-enter-scheduler \
  bun test agent-node/src/goals/routing.test.ts
cp /tmp/test597-routing.ts agent-node/src/goals/routing.ts

bun "$MUTATE" agent-node/src/goals/routing.ts \
  '  if (ANET_SCHEDULE_COMMAND_RE.test(content || "")) return true;' \
  '  if (ANET_SCHEDULE_COMMAND_RE.test(content || "")) return false;'
expect_red namespaced-command-must-enter-scheduler \
  bun test agent-node/src/goals/routing.test.ts
cp /tmp/test597-routing.ts agent-node/src/goals/routing.ts

bun "$MUTATE" agent-node/src/goals/routing.ts \
  '  return `${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\n\n${replyText}`;' \
  '  return replyText;'
expect_red dashboard-interval-migration-notice-is-visible \
  bun test agent-node/src/goals/routing.test.ts
cp /tmp/test597-routing.ts agent-node/src/goals/routing.ts

bun "$MUTATE" agent-node/src/goals/routing.ts \
  'const ANET_SCHEDULE_COMMAND_RE = /^\s*\/(?:agoal|aloop)\b/i;' \
  'const ANET_SCHEDULE_COMMAND_RE = /^\s*\/(?:agoal|aloop)/i;'
expect_red near-match-must-not-route \
  bun test agent-node/src/goals/routing.test.ts
cp /tmp/test597-routing.ts agent-node/src/goals/routing.ts

cp agent-network/bin/cli.ts /tmp/test597-network-cli.ts
bun "$MUTATE" agent-network/bin/cli.ts \
  '  const slashCmd = `/aloop ${everyRaw} ${taskText}`;' \
  '  const slashCmd = `/loop ${everyRaw} ${taskText}`;'
expect_red cli-must-emit-namespaced-command \
  bun test tests/test597-dashboard-slash-namespace/cli-wire.test.ts
cp /tmp/test597-network-cli.ts agent-network/bin/cli.ts

cp agent-node/src/inbox-dispatch.ts /tmp/test597-inbox-dispatch.ts
bun "$MUTATE" agent-node/src/inbox-dispatch.ts \
  '  return meta.auth_origin === "user";' \
  '  return meta.auth_origin === "user" || meta.auth_origin === "node";'
export COMMHUB_DB=/tmp/test597-auth-mutation.db
expect_red node-token-cannot-forge-dashboard-pass-through \
  bun test server/src/dashboard-slash-routing-http.test.ts
cp /tmp/test597-inbox-dispatch.ts agent-node/src/inbox-dispatch.ts

echo "L7 restored green"
export COMMHUB_DB=/tmp/test597-restored.db
bun test \
  agent-node/src/goals/routing.test.ts \
  server/src/dashboard-slash-routing-http.test.ts \
  tests/test597-dashboard-slash-namespace/cli-wire.test.ts

echo "RESULT: PASS"
