#!/usr/bin/env bash
# test-req-abandoned-column — 任务状态「废弃」(abandoned)。
#
#   L1  requirements-abandoned-http.test.ts:设 / 改回(动态两头都记)、关闭态不逾期 / 不提醒 / 不算开着、
#       旧客户端(没声明 X-Anet-Accept-Columns: abandoned)看到 done、回传 done 不改掉废弃、MCP 看到真值;
#       以及会被这次改动波及的已有套件(列表 / 统计 / 到期提醒 / 旧库 CHECK 重建)照旧绿。
#   L3  witnessed red:每个变异都要让 L1 里点名的那条测试红。
#       - abandoned-counted-open:逾期判据把废弃当成开着的卡
#       - projection-removed:旧客户端也拿到 abandoned(desktop ≤ 0.2.220 会把它当 pool)
#       - checklist-projection-removed / events-projection-removed:勾子任务的响应、动态流水不投影
#
# PostgreSQL 那一半由 test2123-hub-postgres-ladder 原样再跑 requirements-abandoned-http.test.ts。
# 全部一次性:HOME=$(mktemp -d)、临时 SQLite、端口 0(从不碰 9200)。
set -euo pipefail
cd /work/server
echo "source_commit=${SOURCE_COMMIT:-unknown}"

run_tests() {
  local h; h="$(mktemp -d)"
  HOME="$h" COMMHUB_DB="$h/hub.db" bun test "$@"
}

echo "== L1"
for f in src/requirements-abandoned-http.test.ts src/requirements-priority-lowest.test.ts src/requirements-http.test.ts \
         src/requirements-stats-http.test.ts src/requirement-due-reminders-http.test.ts src/requirements-list-slim-http.test.ts \
         src/requirement-events-http.test.ts src/tool-audience-http.test.ts; do
  run_tests "$f"
done

expect_red() {
  local label=$1 file=$2 test_name=$3 out rc=0
  out="$(run_tests "$file" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "MUTATION_FALSE_GREEN: $label"; exit 1; fi
  if ! printf '%s\n' "$out" | grep -Fq "(fail) $test_name"; then
    echo "MUTATION_RED_FOR_THE_WRONG_REASON: $label (wanted a failure in: $test_name)"
    printf '%s\n' "$out" | grep -E '^\((pass|fail)\)|^error:' | head -20
    exit 1
  fi
  echo "MUTATION_RED: $label"
}

echo "== L3 witnessed red"
cp src/requirement-due-reminders.ts /tmp/due.ts
bun /work/tests/mutate.ts src/requirement-due-reminders.ts \
  "return \`(due_on IS NOT NULL AND column_name NOT IN ('done', 'abandoned') AND ((length(due_on) = 10 AND due_on < ?" \
  "return \`(due_on IS NOT NULL AND column_name <> 'done' AND ((length(due_on) = 10 AND due_on < ?"
expect_red abandoned-counted-open src/requirements-abandoned-http.test.ts \
  'abandoned column > closed like done: not overdue, no due reminder, not counted as open in stats; restoring reopens it'
cp /tmp/due.ts src/requirement-due-reminders.ts

cp src/requirements.ts /tmp/requirements.ts
bun /work/tests/mutate.ts src/requirements.ts \
  'return column === "abandoned" && !aware ? "done" : column;' \
  'return column;'
expect_red projection-removed src/requirements-abandoned-http.test.ts \
  'abandoned column > old clients (no declaration) see abandoned as done; their writes cannot un-abandon it by echo'
cp /tmp/requirements.ts src/requirements.ts

cp src/requirements.ts /tmp/requirements.ts
bun /work/tests/mutate.ts src/requirements.ts \
  'return Response.json({ ok: true, requirement: toPublicFor(ctx, updated) });' \
  'return Response.json({ ok: true, requirement: { ...toPublicFor(ctx, updated), column: updated.column_name } });'
expect_red checklist-projection-removed src/requirements-abandoned-http.test.ts \
  'abandoned column > checklist toggle response is projected for undeclared callers'
cp /tmp/requirements.ts src/requirements.ts

cp src/requirements.ts /tmp/requirements.ts
bun /work/tests/mutate.ts src/requirements.ts \
  'const ev = projectEvent(eventPublic(row), aware);' \
  'const ev = projectEvent(eventPublic(row), true);'
expect_red events-projection-removed src/requirements-abandoned-http.test.ts \
  'abandoned column > events and last_event: undeclared callers see the projected column; done ↔ abandoned disappears for them'
cp /tmp/requirements.ts src/requirements.ts

# 复原后再绿一次:变异没有留在树里。
run_tests src/requirements-abandoned-http.test.ts
echo "PASS test-req-abandoned-column"
