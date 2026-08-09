#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test604-scheduled-task-edit.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test604 — scheduled task editing"
echo "source_commit=${TEST604_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/scheduled-tasks-http.test.ts
}

expect_red() {
  local label=$1 db_path=$2
  set +e
  run_real "$db_path" >/tmp/test604-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,240p' /tmp/test604-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 build"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-schedule-edit.js
test -s /tmp/commhub-schedule-edit.js

echo "L1 real Hub + SQLite full edit contract"
run_real /tmp/test604-green.db
cp server/src/scheduled-tasks.ts /tmp/test604-scheduled-tasks.ts

echo "L2 witnessed-red: cancelled schedules cannot be resurrected"
perl -0pi -e 's/(implicit resurrection path \(including by supplying status=active\)\.\n    )if \(row\.status === "cancelled"\)/${1}if (false \&\& row.status === "cancelled")/' server/src/scheduled-tasks.ts
grep -Fq 'if (false && row.status === "cancelled")' server/src/scheduled-tasks.ts
expect_red cancelled-is-terminal /tmp/test604-mut-cancelled.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L3 witnessed-red: metadata edit preserves cadence"
sed -i 's/const schedulingChanged = body.schedule !== undefined || body.timezone !== undefined;/const schedulingChanged = true;/' server/src/scheduled-tasks.ts
grep -Fq 'const schedulingChanged = true;' server/src/scheduled-tasks.ts
expect_red metadata-edit-preserves-next-run /tmp/test604-mut-cadence.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L4 witnessed-red: edit target remains network scoped"
sed -i '0,/WHERE node_id = ?1 AND network_id = ?2/s//WHERE node_id = ?1 AND (?2 IS NOT NULL OR network_id = ?2)/' server/src/scheduled-tasks.ts
grep -Fq 'WHERE node_id = ?1 AND (?2 IS NOT NULL OR network_id = ?2)' server/src/scheduled-tasks.ts
expect_red edit-target-network-isolation /tmp/test604-mut-target.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L5 witnessed-red: edit misfire policy remains fail-closed"
sed -i 's/const misfirePolicy = parseMisfirePolicy(body.misfire_policy, row.misfire_policy);/const misfirePolicy = row.misfire_policy;/' server/src/scheduled-tasks.ts
grep -Fq 'const misfirePolicy = row.misfire_policy;' server/src/scheduled-tasks.ts
expect_red edit-misfire-validation /tmp/test604-mut-misfire.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L6 witnessed-red: schedule edit uses DST-safe next occurrence"
sed -i 's/? nextOccurrence(parsed.spec, parsed.timezone, new Date())/? new Date(Date.now() + 60000)/' server/src/scheduled-tasks.ts
grep -Fq '? new Date(Date.now() + 60000)' server/src/scheduled-tasks.ts
expect_red edit-dst-recompute /tmp/test604-mut-dst.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L7 witnessed-red: exact revision is load-bearing"
sed -i 's/if (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision)/if (false \&\& (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision))/' server/src/scheduled-tasks.ts
grep -Fq 'if (false && (!Number.isSafeInteger' server/src/scheduled-tasks.ts
expect_red optimistic-revision /tmp/test604-mut-revision.db
cp /tmp/test604-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L8 restored green"
run_real /tmp/test604-restored.db
echo "RESULT: PASS"
