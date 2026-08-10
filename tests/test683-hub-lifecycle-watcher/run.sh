#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test683-hub-lifecycle-watcher.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test683 — Hub lifecycle watcher"
echo "source_commit=${TEST683_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_suite() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/task-lifecycle-watcher.test.ts
}

expect_red() {
  local label=$1 db_path=$2
  set +e
  run_suite "$db_path" >/tmp/test683-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,220p' /tmp/test683-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

mutate_once() {
  local file=$1 anchor=$2 replacement=$3
  bun -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [file, anchor, replacement] = process.argv.slice(1);
    const before = readFileSync(file, "utf8");
    const count = before.split(anchor).length - 1;
    if (count !== 1) throw new Error(`mutation anchor count=${count}: ${anchor}`);
    const after = before.replace(anchor, replacement);
    if (after === before) throw new Error(`mutation made no byte change: ${anchor}`);
    writeFileSync(file, after);
  ' "$file" "$anchor" "$replacement"
}

echo "L0 production build"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-test683.js
test -s /tmp/commhub-test683.js

echo "L0 legacy task_events migration"
bun - <<'BUN'
  import { Database } from "bun:sqlite";
  const db = new Database("/tmp/test683-legacy.db");
  db.exec(`CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    network_id TEXT
  );`);
  db.exec(`INSERT INTO task_events (task_id, to_status) VALUES ('legacy-event', 'delivered')`);
  db.close();
BUN
COMMHUB_DB=/tmp/test683-legacy.db bun -e '
  const { db } = await import("./server/src/db.js");
  const columns = db.all("PRAGMA table_info(task_events)").map((row) => row.name);
  if (!columns.includes("event_type") || !columns.includes("event_key")) {
    throw new Error(`legacy migration missing columns: ${columns.join(",")}`);
  }
  const old = db.get("SELECT task_id, event_type, event_key FROM task_events WHERE task_id = ?1", "legacy-event");
  if (!old || old.event_type !== null || old.event_key !== null) throw new Error("legacy row was rewritten");
  const indexes = db.all("PRAGMA index_list(task_events)").map((row) => row.name);
  if (!indexes.includes("idx_task_events_task_key")) throw new Error("legacy migration missing idempotency index");
'

echo "L1-L5 real Hub + SQLite lifecycle watcher"
run_suite /tmp/test683-green.db

cp server/src/db.ts /tmp/test683-db.ts
cp server/src/rest-projections.ts /tmp/test683-rest-projections.ts
cp server/src/server.ts /tmp/test683-server.ts
cp server/src/task-lifecycle-watcher.ts /tmp/test683-watcher.ts

echo "L6 mutation: remove write-once conflict gate"
mutate_once server/src/task-lifecycle-watcher.ts \
  '       ON CONFLICT(task_id, event_key) DO NOTHING' \
  ''
expect_red write-once-task-threshold /tmp/test683-mut-write-once.db
cp /tmp/test683-watcher.ts server/src/task-lifecycle-watcher.ts

echo "L7 mutation: move the first threshold past the exact 30s boundary"
mutate_once server/src/task-lifecycle-watcher.ts \
  'export const DELIVERED_STALE_THRESHOLDS = [30, 60] as const;' \
  'export const DELIVERED_STALE_THRESHOLDS = [31, 60] as const;'
expect_red exact-30-second-threshold /tmp/test683-mut-threshold.db
cp /tmp/test683-watcher.ts server/src/task-lifecycle-watcher.ts

echo "L8 mutation: allow acked tasks into the stale watcher"
mutate_once server/src/task-lifecycle-watcher.ts \
  "WHERE status = 'delivered'" \
  "WHERE status IN ('delivered', 'acked')"
expect_red delivered-status-only /tmp/test683-mut-status.db
cp /tmp/test683-watcher.ts server/src/task-lifecycle-watcher.ts

echo "L9 mutation: drop task network propagation"
mutate_once server/src/task-lifecycle-watcher.ts \
  "SELECT task_id, 'delivered', 'delivered', ?1, ?1, 'patrol', ?2, network_id" \
  "SELECT task_id, 'delivered', 'delivered', ?1, ?1, 'patrol', ?2, NULL"
expect_red network-propagation /tmp/test683-mut-network.db
cp /tmp/test683-watcher.ts server/src/task-lifecycle-watcher.ts

echo "L10 mutation: remove event_type from the public projection"
mutate_once server/src/rest-projections.ts \
  '"id", "task_id", "from_status", "to_status", "event_type", "actor", "detail",' \
  '"id", "task_id", "from_status", "to_status", "actor", "detail",'
expect_red public-event-type /tmp/test683-mut-event-type.db
cp /tmp/test683-rest-projections.ts server/src/rest-projections.ts

echo "L11 mutation: leak the internal event_key through REST"
mutate_once server/src/rest-projections.ts \
  '"id", "task_id", "from_status", "to_status", "event_type", "actor", "detail",' \
  '"id", "task_id", "from_status", "to_status", "event_type", "event_key", "actor", "detail",'
expect_red internal-key-private /tmp/test683-mut-private.db
cp /tmp/test683-rest-projections.ts server/src/rest-projections.ts

echo "L12 mutation: break the standard ack event name"
mutate_once server/src/db.ts \
  'case "acked": return "task.ack";' \
  'case "acked": return "task.started";'
expect_red standard-event-name /tmp/test683-mut-name.db
cp /tmp/test683-db.ts server/src/db.ts

echo "L13 mutation: remove the live startHub patrol timer"
mutate_once server/src/server.ts \
  'const deliveredStalePatrolTimer = setInterval(patrolDeliveredStaleTasks, deliveredStalePatrolMs);' \
  'const deliveredStalePatrolTimer = ({ unref() {} } as any);'
expect_red start-hub-live-wiring /tmp/test683-mut-wiring.db
cp /tmp/test683-server.ts server/src/server.ts

echo "L14 restored green"
run_suite /tmp/test683-restored.db

echo "RESULT: PASS"
