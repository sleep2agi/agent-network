#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test236-dashboard-codex-goal.txt"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

run() {
  printf '\n$ %q' "$1" | tee -a "$REPORT"
  shift
  printf ' %q' "$@" | tee -a "$REPORT"
  printf '\n' | tee -a "$REPORT"
  "$@" 2>&1 | tee -a "$REPORT"
}

printf '%s\n' \
  '# test236 — Dashboard /goal reaches shared Codex TUI' \
  "source_commit=$SOURCE_COMMIT" \
  'scope=authenticated Dashboard routing, /loop compatibility, legacy /goal compatibility, production wiring, mutation red' \
  | tee -a "$REPORT"

run routing-unit bun test \
  /workspace/agent-node/src/goals/routing.test.ts \
  /workspace/agent-node/src/inbox-dispatch.test.ts

run production-wiring bash -ceu '
  cli=/workspace/agent-node/src/cli.ts
  grep -Fq "const interactiveDashboardTask = isInteractiveDashboardTask(msg);" "$cli"
  grep -Fq "shouldCreateScheduledGoal(persistenceSafeContent, RUNTIME, interactiveDashboardTask)" "$cli"
  grep -Fq "const result = appendDashboardCodexGoalNotice(" "$cli"
  grep -Fq "interactiveDashboardTask," "$cli"
'

run production-build bash -ceu '
  cd /workspace/agent-node
  bun build src/cli.ts --outfile /tmp/agent-node-cli.js --target node \
    --external @anthropic-ai/claude-agent-sdk \
    --external "@anthropic-ai/claude-agent-sdk-*" \
    --external @openai/codex-sdk \
    --external node-pty
  test -s /tmp/agent-node-cli.js
'

# Witnessed-red: remove the authenticated Dashboard Codex exception while
# leaving the test unchanged. The screenshot's interval-free `/goal` must be
# intercepted again, so the focused routing test has to fail.
cp /workspace/agent-node/src/goals/routing.ts /tmp/routing.original.ts
sed -i 's/return !(runtime === "codex-app-server" && interactiveDashboardTask);/return true;/' \
  /workspace/agent-node/src/goals/routing.ts
set +e
bun test /workspace/agent-node/src/goals/routing.test.ts > /tmp/mutation.out 2>&1
mutation_rc=$?
set -e
cat /tmp/mutation.out | tee -a "$REPORT"
cp /tmp/routing.original.ts /workspace/agent-node/src/goals/routing.ts
if test "$mutation_rc" -eq 0; then
  printf 'FAIL: deleting the Dashboard Codex /goal exception stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red Dashboard Codex /goal mutation rc=%s\n' "$mutation_rc" | tee -a "$REPORT"

run restored-green bun test /workspace/agent-node/src/goals/routing.test.ts

# Witnessed-red: keep the routing exception but remove the deterministic
# interval notice from the successful reply. The ambiguity regression must be
# observable even though the goal itself still reaches Codex.
sed -i 's/return `${replyText}\\n\\n${DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE}`;/return replyText;/' \
  /workspace/agent-node/src/goals/routing.ts
set +e
bun test /workspace/agent-node/src/goals/routing.test.ts > /tmp/notice-mutation.out 2>&1
notice_mutation_rc=$?
set -e
cat /tmp/notice-mutation.out | tee -a "$REPORT"
cp /tmp/routing.original.ts /workspace/agent-node/src/goals/routing.ts
if test "$notice_mutation_rc" -eq 0; then
  printf 'FAIL: deleting the interval ambiguity notice stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red interval notice mutation rc=%s\n' "$notice_mutation_rc" | tee -a "$REPORT"

run final-green bun test /workspace/agent-node/src/goals/routing.test.ts

printf '\nSummary: PASS (authenticated Dashboard /goal passes to Codex TUI; interval ambiguity is explicit; /loop and legacy paths preserved; production bundle builds; two mutations red)\n' \
  | tee -a "$REPORT"
