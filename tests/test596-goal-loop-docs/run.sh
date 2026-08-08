#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test596-goal-loop-docs.txt"
ZH=/workspace/docs-site/docs/guide/goals-and-loops.md
EN=/workspace/docs-site/docs/en/guide/goals-and-loops.md
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

run() {
  printf '\n$ %q' "$1" | tee -a "$REPORT"
  shift
  printf ' %q' "$@" | tee -a "$REPORT"
  printf '\n' | tee -a "$REPORT"
  "$@" 2>&1 | tee -a "$REPORT"
}

docs_contract() {
  grep -Fq '周期调度统一使用 `/aloop`' "$ZH" || return 1
  grep -Fq 'Agent Network scheduling uses `/aloop`' "$EN" || return 1
  grep -Fq '认证 Dashboard Chat → 任意 agent-node runtime' "$ZH" || return 1
  grep -Fq 'Authenticated Dashboard Chat → any agent-node runtime' "$EN" || return 1
  grep -Fq '原样进入该 runtime/TUI' "$ZH" || return 1
  grep -Fq 'Passed unchanged to that runtime/TUI' "$EN" || return 1
  grep -Fq '兼容期内仍创建 ANet 周期任务' "$ZH" || return 1
  grep -Fq 'Compatibility path: still creates an ANet recurring task' "$EN" || return 1
  grep -Fq '`/agoal` 是同一调度入口' "$ZH" || return 1
  grep -Fq '`/agoal` is a namespaced alias' "$EN" || return 1
  grep -Fq '最多 15 秒' "$ZH" || return 1
  grep -Fq 'up to 15 seconds' "$EN" || return 1
  grep -Fq '默认约每 30 秒' "$ZH" || return 1
  grep -Fq 'about every 30 seconds by default' "$EN" || return 1
  grep -Fq '连续失败默认达到 5 次' "$ZH" || return 1
  grep -Fq 'five consecutive failures by default' "$EN" || return 1
  grep -Fq 'anet goal wake-log' "$ZH" || return 1
  grep -Fq 'anet goal wake-log' "$EN" || return 1
  grep -Fq '`create_my_loop`' "$ZH" || return 1
  grep -Fq '`create_my_loop`' "$EN" || return 1
  grep -Fq '不会热重载' "$ZH" || return 1
  grep -Fq 'does not hot-reload' "$EN" || return 1
  grep -Fq '独立 `claude-code-cli`' "$ZH" || return 1
  grep -Fq 'standalone `claude-code-cli`' "$EN" || return 1
}

printf '%s\n' \
  '# test596 — native Dashboard slash and ANet scheduler documentation' \
  "source_commit=$SOURCE_COMMIT" \
  'scope=/goal+/loop native pass-through, /aloop+/agoal scheduler, compatibility warning, bilingual docs, VitePress render, mutation red' \
  | tee -a "$REPORT"

run goal-runtime-unit bun test \
  /workspace/agent-node/src/goals/parser.test.ts \
  /workspace/agent-node/src/goals/routing.test.ts \
  /workspace/agent-node/src/goals/scheduler.test.ts \
  /workspace/agent-node/src/goals/schedule.test.ts \
  /workspace/agent-node/src/goals/completion-detect.test.ts \
  /workspace/agent-node/src/goals/failure-counter.test.ts \
  /workspace/agent-node/src/goals/store.test.ts \
  /workspace/agent-node/src/goals/self-loop-tools.test.ts

run wake-log-unit bun test /workspace/agent-network/tests/goal-wake-log-render.test.ts

run source-contract bash -ceu '
  parser=/workspace/agent-node/src/goals/parser.ts
  routing=/workspace/agent-node/src/goals/routing.ts
  node_cli=/workspace/agent-node/src/cli.ts
  anet_cli=/workspace/agent-network/bin/cli.ts
  grep -Fq "const ANET_SCHEDULE_COMMAND_RE = /^\\s*\\/(?:agoal|aloop)\\b/i;" "$routing"
  grep -Fq "return !interactiveDashboardTask;" "$routing"
  grep -Fq "const GOAL_TICK_MS = Math.max(10_000" "$node_cli"
  grep -Fq "setInterval(() => runGoalSchedulerTick()" "$node_cli"
  grep -Fq "const POLL_DEADLINE_MS = 15_000;" "$anet_cli"
  grep -Fq 'const slashCmd = `/aloop ${everyRaw} ${taskText}`;' "$anet_cli"
  grep -Fq "wake-log <node> <goal-id>" "$anet_cli"
  grep -Fq "MIN_INTERVAL_MS = 60_000" "$parser"
'

run docs-contract docs_contract

# Witnessed-red: if all-runtime Dashboard pass-through disappears from the
# Chinese page, the same documentation gate must fail.
cp "$ZH" /tmp/goals-and-loops.zh.original
sed -i 's/认证 Dashboard Chat → 任意 agent-node runtime/认证 Dashboard Chat → 未声明 runtime/g' "$ZH"
set +e
docs_contract >/tmp/docs-mutation.out 2>&1
mutation_rc=$?
set -e
cat /tmp/docs-mutation.out | tee -a "$REPORT"
cp /tmp/goals-and-loops.zh.original "$ZH"
if test "$mutation_rc" -eq 0; then
  printf 'FAIL: deleting the all-runtime Dashboard pass-through statement stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red all-runtime Dashboard pass-through docs mutation rc=%s\n' "$mutation_rc" | tee -a "$REPORT"

run docs-contract-restored docs_contract
run vitepress-build bash -ceu 'cd /workspace/docs-site && bun run build'
test -s /workspace/docs-site/docs/.vitepress/dist/guide/goals-and-loops.html
test -s /workspace/docs-site/docs/.vitepress/dist/en/guide/goals-and-loops.html

printf '\nSummary: PASS (Dashboard native /goal+/loop, ANet /aloop+/agoal scheduling, compatibility migration, bilingual docs, rendered site, and mutation gate verified)\n' \
  | tee -a "$REPORT"
