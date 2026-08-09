#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test624-task-cursor-pagination.txt"
SOURCE=server/src/server.ts
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

run_real() {
  COMMHUB_DB="$1" bun test server/src/tasks-pagination-http.test.ts
}

expect_red() {
  local label=$1 marker=$2
  set +e
  run_real "/tmp/test624-$label.db" >/tmp/test624-red.log 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,220p' /tmp/test624-red.log
    exit 1
  fi
  grep -Fq "$marker" /tmp/test624-red.log
  echo "MUTATION_RED: $label rc=$rc"
}

echo "# test624 — /api/tasks cursor pagination"
echo "source_commit=${TEST624_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 build"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-task-page.js
test -s /tmp/commhub-task-page.js

echo "L1 real Hub + SQLite pagination"
run_real /tmp/test624-green.db
cp "$SOURCE" /tmp/test624-server.ts

echo "L2 witnessed-red: before predicate is load-bearing"
sed -i 's/} else if (before) {/} else if (false \&\& before) {/' "$SOURCE"
grep -Fq 'else if (false && before)' "$SOURCE"
expect_red before-filter 'before is exclusive and remains network-scoped'
cp /tmp/test624-server.ts "$SOURCE"

echo "L3 witnessed-red: exact cursor row must stay excluded"
sed -i 's/sql += ` AND created_at < ?${params.length + 1}`;/sql += ` AND created_at <= ?${params.length + 1}`;/' "$SOURCE"
grep -Fq 'sql += ` AND created_at <= ?${params.length + 1}`;' "$SOURCE"
expect_red exclusive-cursor 'before is exclusive and remains network-scoped'
cp /tmp/test624-server.ts "$SOURCE"

echo "L4 witnessed-red: compound cursor tie-break is load-bearing"
sed -i 's/AND task_id < ?${taskIdParam}/AND task_id > ?${taskIdParam}/' "$SOURCE"
grep -Fq 'AND task_id > ?${taskIdParam}' "$SOURCE"
expect_red same-second-cursor 'before_task_id preserves rows that share the cursor second'
cp /tmp/test624-server.ts "$SOURCE"

echo "L5 witnessed-red: malformed cursor rejection is load-bearing"
sed -i 's/if (rawBefore !== null \&\& before === null)/if (false \&\& rawBefore !== null \&\& before === null)/' "$SOURCE"
grep -Fq 'if (false && rawBefore' "$SOURCE"
expect_red invalid-cursor 'empty, malformed, and rolled-over cursors fail closed'
cp /tmp/test624-server.ts "$SOURCE"

echo "L6 witnessed-red: compound cursor validation is load-bearing"
sed -i 's/if (rawBeforeTaskId !== null \&\& (before === null || beforeTaskId === null))/if (false \&\& rawBeforeTaskId !== null \&\& (before === null || beforeTaskId === null))/' "$SOURCE"
grep -Fq 'if (false && rawBeforeTaskId' "$SOURCE"
expect_red compound-validation 'before_task_id requires a valid timestamp cursor and task id'
cp /tmp/test624-server.ts "$SOURCE"

echo "L7 restored green"
run_real /tmp/test624-restored.db
echo "RESULT: PASS"
