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
  grep -Fq '新的周期任务统一使用 `/loop`' "$ZH"
  grep -Fq 'Use `/loop` for every new recurring task' "$EN"
  grep -Fq '认证 Dashboard Chat → 共享 Codex TUI' "$ZH"
  grep -Fq 'Authenticated Dashboard Chat → shared Codex TUI' "$EN"
  grep -Fq '作为一次性目标执行' "$ZH"
  grep -Fq 'as a one-time goal' "$EN"
  grep -Fq '`/goal` 的旧兼容别名' "$ZH"
  grep -Fq 'Legacy alias for `/loop`' "$EN"
  grep -Fq '最多 15 秒' "$ZH"
  grep -Fq 'up to 15 seconds' "$EN"
  grep -Fq '默认约每 30 秒' "$ZH"
  grep -Fq 'about every 30 seconds by default' "$EN"
  grep -Fq '连续失败默认达到 5 次' "$ZH"
  grep -Fq 'five consecutive failures by default' "$EN"
  grep -Fq 'anet goal wake-log' "$ZH"
  grep -Fq 'anet goal wake-log' "$EN"
  grep -Fq '`create_my_loop`' "$ZH"
  grep -Fq '`create_my_loop`' "$EN"
  grep -Fq '不会热重载' "$ZH"
  grep -Fq 'does not hot-reload' "$EN"
  grep -Fq '独立的 `claude-code-cli`' "$ZH"
  grep -Fq 'standalone `claude-code-cli`' "$EN"
}

printf '%s\n' \
  '# test596 — current anet /goal and /loop documentation' \
  "source_commit=$SOURCE_COMMIT" \
  'scope=parser, routing split, scheduler/store/self-management, CLI wake log, bilingual docs contract, VitePress render, mutation red' \
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
  grep -Fq "if (/^\\s*\\/loop\\b/i.test(content || \"\")) return true;" "$routing"
  grep -Fq "runtime === \"codex-app-server\" && interactiveDashboardTask" "$routing"
  grep -Fq "const GOAL_TICK_MS = Math.max(10_000" "$node_cli"
  grep -Fq "setInterval(() => runGoalSchedulerTick()" "$node_cli"
  grep -Fq "const POLL_DEADLINE_MS = 15_000;" "$anet_cli"
  grep -Fq "const everyRaw = everyIdx >= 0 ? args[everyIdx + 1] : \"5m\";" "$anet_cli"
  grep -Fq "wake-log <node> <goal-id>" "$anet_cli"
  grep -Fq "MIN_INTERVAL_MS = 60_000" "$parser"
'

run docs-contract docs_contract

# Witnessed-red: if the one-time Dashboard/Codex distinction disappears from
# the Chinese page, the same documentation gate must fail.
cp "$ZH" /tmp/goals-and-loops.zh.original
sed -i '/作为一次性目标执行/d' "$ZH"
set +e
docs_contract >/tmp/docs-mutation.out 2>&1
mutation_rc=$?
set -e
cat /tmp/docs-mutation.out | tee -a "$REPORT"
cp /tmp/goals-and-loops.zh.original "$ZH"
if test "$mutation_rc" -eq 0; then
  printf 'FAIL: deleting the Dashboard/Codex one-time-goal statement stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red Dashboard/Codex docs mutation rc=%s\n' "$mutation_rc" | tee -a "$REPORT"

run docs-contract-restored docs_contract
run vitepress-build bash -ceu 'cd /workspace/docs-site && bun run build'
test -s /workspace/docs-site/docs/.vitepress/dist/guide/goals-and-loops.html
test -s /workspace/docs-site/docs/.vitepress/dist/en/guide/goals-and-loops.html

printf '\nSummary: PASS (current /goal-/loop split, scheduler behavior, local management, self-management tools, bilingual docs, rendered site, and mutation gate verified)\n' \
  | tee -a "$REPORT"
