#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test602-scheduled-misfire.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test602 — scheduled-task misfire policy"
echo "source_commit=${TEST602_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/scheduled-tasks-http.test.ts
}

echo "L0 build + additive schema"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-misfire.js
test -s /tmp/commhub-misfire.js
grep -Fq 'misfire_policy' server/src/db.ts

echo "L1-L5 real Hub + SQLite behavior"
run_real /tmp/test602-green.db

echo "L6 witnessed-red: skip policy is load-bearing"
cp server/src/scheduled-tasks.ts /tmp/test602-scheduled-tasks.ts
sed -i 's/current.misfire_policy === "skip"/false \&\& current.misfire_policy === "skip"/' server/src/scheduled-tasks.ts
grep -Fq 'false && current.misfire_policy === "skip"' server/src/scheduled-tasks.ts
set +e
run_real /tmp/test602-mut-skip.db >/tmp/test602-red.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: misfire skip gate"
  sed -n '1,240p' /tmp/test602-red.log
  exit 1
fi
echo "MUTATION_RED: misfire-skip-gate rc=$rc"
cp /tmp/test602-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L7 restored green"
run_real /tmp/test602-restored.db
echo "RESULT: PASS"
