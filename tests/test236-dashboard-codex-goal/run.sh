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

# 🔴 变异必须真的改动文件，否则算【锚点过期】而不是产品缺陷。
#    为什么不预先 grep 锚点：锚点里含 `\\n` 这类转义，在 grep -F / sed / shell 引号
#    三层里的含义不同，判据本身就会成为 bug 源。**直接量「文件改没改」不需要任何转义。**
#    背景（2026-08-19 实测 origin/main）：3 条锚点里 2 条 0 命中 ——
#    一次改名把 Codex/INTERVAL 换成了 Native/SCHEDULE，本文件的字面量没跟上。
#    sed 打不中时是 **no-op** ⇒ 产品没被改坏 ⇒ 测试绿 ⇒ 下面那句
#    `FAIL: ... stayed green` 照样会打，套件确实红了 —— **但那句红话指错了层**：
#    它把人指向产品，而该改的是这个文件。这个函数把它变成一句指对层的红话。
mutate() { # $1=目标文件 $2=sed 表达式（原样透传，不经二次解析）
  cp "$1" /tmp/pre-mutation.snapshot
  sed -i "$2" "$1"
  if cmp -s /tmp/pre-mutation.snapshot "$1"; then
    printf 'FAIL: 变异未改动 %s —— 【测试锚点过期】，不是产品缺陷\n' "$1" | tee -a "$REPORT"
    printf '  sed: %s\n' "$2" | tee -a "$REPORT"
    exit 1
  fi
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
  grep -Fq "const preparedReply = prepareDashboardNativeSlashReply(" "$cli"
  grep -Fq "if (!preparedReply.shouldDeliver)" "$cli"
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
mutate /workspace/agent-node/src/goals/routing.ts 's/return !interactiveDashboardTask;/return true;/'
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
mutate /workspace/agent-node/src/goals/routing.ts 's/return `${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\\n\\n${replyText}`;/return replyText;/'
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

# Witnessed-red: evaluate low-value status against the raw model text instead
# of the notice-prefixed text. A model reply of "收到" would then suppress the
# required interval warning.
mutate /workspace/agent-node/src/goals/routing.ts 's/!isLowValueReply(text)/!isLowValueReply(replyText)/'
set +e
bun test /workspace/agent-node/src/goals/routing.test.ts > /tmp/order-mutation.out 2>&1
order_mutation_rc=$?
set -e
cat /tmp/order-mutation.out | tee -a "$REPORT"
cp /tmp/routing.original.ts /workspace/agent-node/src/goals/routing.ts
if test "$order_mutation_rc" -eq 0; then
  printf 'FAIL: moving notice composition after low-value filtering stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red notice/filter ordering mutation rc=%s\n' "$order_mutation_rc" | tee -a "$REPORT"

run order-restored-green bun test /workspace/agent-node/src/goals/routing.test.ts

printf '\nSummary: PASS (authenticated Dashboard /goal passes to Codex TUI; interval ambiguity survives reply filtering/cap; /loop and legacy paths preserved; production bundle builds; three mutations red)\n' \
  | tee -a "$REPORT"
