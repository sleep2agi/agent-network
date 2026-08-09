#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test601-hub-scheduled-tasks.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test601 — Hub scheduled tasks"
echo "source_commit=${TEST601_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/scheduled-tasks-http.test.ts
}

expect_red() {
  local label=$1 db_path=$2
  set +e
  run_real "$db_path" >/tmp/test601-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,220p' /tmp/test601-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 build + additive schema"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-scheduler.js
test -s /tmp/commhub-scheduler.js
grep -Fq 'CREATE TABLE IF NOT EXISTS scheduled_tasks' server/src/db.ts
grep -Fq 'UNIQUE(schedule_id, scheduled_for)' server/src/db.ts

echo "L1-L5 real Hub + SQLite: time, auth, dispatch, recurrence, rename, history"
run_real /tmp/test601-green.db

cp server/src/scheduled-tasks.ts /tmp/test601-scheduled-tasks.ts

echo "L6 witnessed-red: node token cannot create persistent schedules"
sed -i 's/if (ctx.isNodeToken) return jsonError("user_token_required", 403);/if (false \&\& ctx.isNodeToken) return jsonError("user_token_required", 403);/' server/src/scheduled-tasks.ts
grep -Fq 'if (false && ctx.isNodeToken)' server/src/scheduled-tasks.ts
expect_red node-token-write-gate /tmp/test601-mut-node.db
cp /tmp/test601-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L7 witnessed-red: cross-process occurrence claim is load-bearing"
cp server/src/db.ts /tmp/test601-db.ts
perl -0pi -e 's/completed_at     TEXT,\n    UNIQUE\(schedule_id, scheduled_for\)/completed_at     TEXT/' server/src/db.ts
if grep -Fq 'UNIQUE(schedule_id, scheduled_for)' server/src/db.ts; then
  echo "MUTATION_NOT_APPLIED: occurrence unique claim"
  exit 1
fi
expect_red cross-process-occurrence-claim /tmp/test601-mut-claim.db
cp /tmp/test601-db.ts server/src/db.ts

echo "L8 witnessed-red: overlap check is load-bearing"
sed -i '0,/if (open) {/s//if (false \&\& open) {/' server/src/scheduled-tasks.ts
grep -Fq 'if (false && open)' server/src/scheduled-tasks.ts
expect_red no-overlapping-occurrences /tmp/test601-mut-overlap.db
cp /tmp/test601-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L9 witnessed-red: optimistic revision rejects stale devices"
sed -i 's/if (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision)/if (false \&\& (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision))/' server/src/scheduled-tasks.ts
grep -Fq 'if (false && (!Number.isSafeInteger' server/src/scheduled-tasks.ts
expect_red optimistic-revision /tmp/test601-mut-revision.db
cp /tmp/test601-scheduled-tasks.ts server/src/scheduled-tasks.ts

echo "L10 restored green"
run_real /tmp/test601-restored.db
echo "RESULT: PASS"
