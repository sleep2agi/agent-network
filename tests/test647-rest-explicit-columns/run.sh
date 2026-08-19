#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test647-rest-explicit-columns.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test647 — REST explicit-column response contracts"
echo "source_commit=${TEST647_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_shape_test() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/rest-explicit-columns-http.test.ts
}

echo "L0: production Hub build"
bun build server/src/index.ts --target bun --outfile /tmp/test647-hub.js
test -s /tmp/test647-hub.js

echo "L1: exhaustive REST SELECT-star classification"
if grep -En '["`]SELECT ([A-Za-z]+\.)?\* FROM' server/src/server.ts server/src/auth.ts server/src/scheduled-tasks.ts; then
  echo "FAIL: REST-facing source still contains SELECT *"
  exit 1
fi
echo "PASS: REST-facing source has zero SELECT-star queries"

echo "L2: live HTTP shape + future-column sentinel"
run_shape_test /tmp/test647-green.db

cp server/src/server.ts /tmp/test647-server.ts
cp server/src/auth.ts /tmp/test647-auth.ts
cp server/src/scheduled-tasks.ts /tmp/test647-scheduled-tasks.ts

# 🔴 2026-08-19（#1096）：原来这里是裸的 `test "$X_rc" -ne 0`。
#    在 set -e 下，变异**存活**（rc=0）会让脚本当场终止，**一个字都不打** ——
#    日志停在上一行 echo 的标题上，读的人看不出是哪条变异活下来了、也看不出是不是脚本崩了。
#    实测：L3b 的变异存活，整个套件的输出就停在
#    「L3b witnessed-red: network membership SELECT-star leaks future column」这一行。
#    下面这个函数把「静默死亡」换成一句能定位的话。判据的宽严一点没变。
mutation_must_be_red() { # $1=变异名 $2=rc $3=那次运行的日志
  if [ "$2" -ne 0 ]; then return 0; fi
  echo "FAIL: mutation '$1' SURVIVED (rc=0) —— 这条变异没有被任何测试抓到，是**覆盖洞**，不是脚本错误" >&2
  echo "      变异后的运行日志尾部：" >&2
  tail -6 "$3" >&2 || true
  exit 1
}

echo "L3a witnessed-red: task list SELECT-star leaks future column"
sed -i 's/SELECT ${TASK_REST_SELECT} FROM tasks WHERE 1=1/SELECT * FROM tasks WHERE 1=1/' server/src/server.ts
grep -Fq 'SELECT * FROM tasks WHERE 1=1' server/src/server.ts
set +e
run_shape_test /tmp/test647-mut-task.db >/tmp/test647-mut-task.log 2>&1
task_rc=$?
set -e
mutation_must_be_red task-rest-select-star "$task_rc" /tmp/test647-mut-task.log
grep -Fq 'future_internal_only' /tmp/test647-mut-task.log
echo "MUTATION_RED: task-rest-select-star rc=$task_rc"
cp /tmp/test647-server.ts server/src/server.ts

echo "L3b witnessed-red: network membership SELECT-star leaks future column"
sed -i 's/SELECT ${sqlColumns(NETWORK_REST_COLUMNS, "n")}, nm.role as member_role/SELECT n.*, nm.role as member_role/' server/src/auth.ts
grep -Fq 'SELECT n.*, nm.role as member_role' server/src/auth.ts
set +e
run_shape_test /tmp/test647-mut-network.db >/tmp/test647-mut-network.log 2>&1
network_rc=$?
set -e
mutation_must_be_red network-rest-select-star "$network_rc" /tmp/test647-mut-network.log
grep -Fq 'future_internal_only' /tmp/test647-mut-network.log
echo "MUTATION_RED: network-rest-select-star rc=$network_rc"
cp /tmp/test647-auth.ts server/src/auth.ts

echo "L3c witnessed-red: scheduled-task SELECT-star leaks future column"
sed -i '0,/SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE 1=1/s//SELECT * FROM scheduled_tasks WHERE 1=1/' server/src/scheduled-tasks.ts
grep -Fq 'SELECT * FROM scheduled_tasks WHERE 1=1' server/src/scheduled-tasks.ts
set +e
run_shape_test /tmp/test647-mut-schedule.db >/tmp/test647-mut-schedule.log 2>&1
schedule_rc=$?
set -e
mutation_must_be_red schedule-rest-select-star "$schedule_rc" /tmp/test647-mut-schedule.log
grep -Fq 'future_internal_only' /tmp/test647-mut-schedule.log
echo "MUTATION_RED: schedule-rest-select-star rc=$schedule_rc"
cp /tmp/test647-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L4: restored source remains green"
run_shape_test /tmp/test647-restored.db

echo "RESULT: PASS"
