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

echo "L3a witnessed-red: task list SELECT-star leaks future column"
sed -i 's/SELECT ${TASK_REST_SELECT} FROM tasks WHERE 1=1/SELECT * FROM tasks WHERE 1=1/' server/src/server.ts
grep -Fq 'SELECT * FROM tasks WHERE 1=1' server/src/server.ts
set +e
run_shape_test /tmp/test647-mut-task.db >/tmp/test647-mut-task.log 2>&1
task_rc=$?
set -e
test "$task_rc" -ne 0
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
test "$network_rc" -ne 0
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
test "$schedule_rc" -ne 0
grep -Fq 'future_internal_only' /tmp/test647-mut-schedule.log
echo "MUTATION_RED: schedule-rest-select-star rc=$schedule_rc"
cp /tmp/test647-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L4: restored source remains green"
run_shape_test /tmp/test647-restored.db

echo "RESULT: PASS"
