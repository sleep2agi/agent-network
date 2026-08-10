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

COMMHUB_DB=/tmp/test683.db bun test server/src/task-lifecycle-watcher.test.ts

echo "RESULT: PASS"
