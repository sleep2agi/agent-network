#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test690-scheduled-run-terminal.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test690 — scheduled run terminal lifecycle"
echo "source_commit=${TEST690_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  rm -f "${db_path:?}" "${db_path:?}-wal" "${db_path:?}-shm"
  COMMHUB_DB="$db_path" bun test server/src/scheduled-run-terminal.test.ts
}

echo "L0 build"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test690.js
test -s /tmp/commhub-test690.js

echo "L1 real SQLite lifecycle"
run_real /tmp/test690-green.db

echo "L1b scheduler regression matrix"
COMMHUB_DB=/tmp/test690-scheduler-regression.db bun test server/src/scheduled-tasks-http.test.ts

echo "L2 witnessed-red: terminal synchronization hook is load-bearing"
cp server/src/db.ts /tmp/test690-db.ts
sed -i '0,/  const task = db.get<ScheduledTaskLifecycleRow>/{s/  const task = db.get<ScheduledTaskLifecycleRow>/  return { matched: false };\n  const task = db.get<ScheduledTaskLifecycleRow>/}' server/src/db.ts
if cmp -s server/src/db.ts /tmp/test690-db.ts; then
  echo "MUTATION_NOOP: syncScheduledRunForTask anchor"
  exit 1
fi
set +e
run_real /tmp/test690-mut-sync.db >/tmp/test690-mut-sync.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: terminal synchronization"
  sed -n '1,240p' /tmp/test690-mut-sync.log
  exit 1
fi
echo "MUTATION_RED: terminal-sync rc=$rc"
cp /tmp/test690-db.ts server/src/db.ts

echo "L3 witnessed-red: exact task binding is load-bearing"
cp server/src/db.ts /tmp/test690-db.ts
sed -i 's/WHERE task_id = ?1 AND network_id = ?2/WHERE network_id = ?2/' server/src/db.ts
sed -i 's/WHERE run_id = ?4 AND task_id = ?5 AND network_id = ?6 AND schedule_id = ?7/WHERE run_id = ?4 AND network_id = ?6 AND schedule_id = ?7/' server/src/db.ts
if cmp -s server/src/db.ts /tmp/test690-db.ts; then
  echo "MUTATION_NOOP: exact task binding anchor"
  exit 1
fi
set +e
run_real /tmp/test690-mut-binding.db >/tmp/test690-mut-binding.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: exact task binding"
  sed -n '1,240p' /tmp/test690-mut-binding.log
  exit 1
fi
echo "MUTATION_RED: exact-task-binding rc=$rc"
cp /tmp/test690-db.ts server/src/db.ts

echo "L4 witnessed-red: exact network binding is load-bearing"
cp server/src/db.ts /tmp/test690-db.ts
sed -i 's/WHERE task_id = ?1 AND network_id = ?2/WHERE task_id = ?1 AND ?2 IS NOT NULL/' server/src/db.ts
sed -i 's/AND task_id = ?5 AND network_id = ?6 AND schedule_id = ?7/AND task_id = ?5 AND ?6 IS NOT NULL AND schedule_id = ?7/' server/src/db.ts
if cmp -s server/src/db.ts /tmp/test690-db.ts; then
  echo "MUTATION_NOOP: exact network binding anchor"
  exit 1
fi
set +e
run_real /tmp/test690-mut-network.db >/tmp/test690-mut-network.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: exact network binding"
  sed -n '1,240p' /tmp/test690-mut-network.log
  exit 1
fi
echo "MUTATION_RED: exact-network-binding rc=$rc"
cp /tmp/test690-db.ts server/src/db.ts

echo "L5 restored green"
run_real /tmp/test690-restored.db
echo "RESULT: PASS"
