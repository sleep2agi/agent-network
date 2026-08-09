#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test612-visible-inbox-skip.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test612 — visible inbox skip diagnostics"
echo "source_commit=${TEST612_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_tests() {
  bun test \
    agent-node/src/inbox-skip-log.test.ts \
    agent-node/src/inbox-skip-log-wiring.test.ts
}

echo "L0 formatter and source wiring"
run_tests

echo "L1 full agent-node build"
cd /workspace/agent-node
bun run build
cd /workspace
test -s agent-node/dist/cli.js

echo "L2 witnessed-red: INFO is downgraded to DEBUG"
cp agent-node/src/cli.ts /tmp/test612-cli.ts
sed -i 's/log(formatInboxSkipLog({/debug(formatInboxSkipLog({/' agent-node/src/cli.ts
grep -Fq 'debug(formatInboxSkipLog({' agent-node/src/cli.ts
set +e
bun test agent-node/src/inbox-skip-log-wiring.test.ts >/tmp/test612-level.log 2>&1
level_rc=$?
set -e
if [ "$level_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: skip-info-level"
  exit 1
fi
grep -Fq 'toContain' /tmp/test612-level.log
echo "MUTATION_RED: skip-info-level rc=$level_rc"
cp /tmp/test612-cli.ts agent-node/src/cli.ts

echo "L3 witnessed-red: task identity is truncated"
cp agent-node/src/inbox-skip-log.ts /tmp/test612-log.ts
sed -i 's/${input.taskId}/${input.taskId.slice(0, 8)}/' agent-node/src/inbox-skip-log.ts
grep -Fq '${input.taskId.slice(0, 8)}' agent-node/src/inbox-skip-log.ts
set +e
bun test agent-node/src/inbox-skip-log.test.ts >/tmp/test612-task-id.log 2>&1
task_id_rc=$?
set -e
if [ "$task_id_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: full-task-id"
  exit 1
fi
grep -Fq 'toContain' /tmp/test612-task-id.log
echo "MUTATION_RED: full-task-id rc=$task_id_rc"
cp /tmp/test612-log.ts agent-node/src/inbox-skip-log.ts

echo "L4 restored green"
run_tests

echo "RESULT: PASS"
