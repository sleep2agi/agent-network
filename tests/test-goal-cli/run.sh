#!/usr/bin/env bash
set -euo pipefail
# 绑了还要看得见（#1092）：报告里没有这一行，就没法把这次运行钉到某个提交上。
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

ROOT="/workspace"
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="$ARTIFACT_DIR/report-goal-cli.txt"
WORK="/tmp/anet-goal-cli"
ALIAS="goalbot"
GOAL_ID="abcdef12-3456-7890-abcd-ef1234567890"

mkdir -p "$ARTIFACT_DIR" "$WORK/.anet/nodes/$ALIAS"
: >"$REPORT"

log() {
  printf '%s\n' "$*" | tee -a "$REPORT"
}

log "# anet goal CLI smoke"
log "- date: $(date -Is)"
log "- workdir: $WORK"

cat >"$WORK/.anet/nodes/$ALIAS/config.json" <<JSON
{
  "node_id": "n_goalbot",
  "node_name": "$ALIAS",
  "runtime": "codex-sdk",
  "channels": [],
  "env": {},
  "flags": {}
}
JSON

cat >"$WORK/.anet/nodes/$ALIAS/goals.json" <<JSON
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$GOAL_ID",
      "text": "check preview smoke",
      "status": "active",
      "interval_ms": 60000,
      "next_wake_at": "2099-01-01T00:00:00.000Z",
      "runtime": "codex-sdk",
      "created_at": "2026-05-27T00:00:00.000Z",
      "updated_at": "2026-05-27T00:00:00.000Z",
      "progress_log": []
    }
  ]
}
JSON

cd "$WORK"

log
log "list before cancel"
bun "$ROOT/agent-network/bin/cli.ts" goal list "$ALIAS" | tee -a "$REPORT"

log
log "cancel"
bun "$ROOT/agent-network/bin/cli.ts" goal cancel "$ALIAS" "${GOAL_ID:0:8}" | tee -a "$REPORT"

log
log "list after cancel"
bun "$ROOT/agent-network/bin/cli.ts" goal list "$ALIAS" | tee -a "$REPORT"

grep -q "active" "$REPORT"
grep -q "cancelled" "$REPORT"
grep -q "check preview smoke" "$REPORT"

STATUS="$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('$WORK/.anet/nodes/$ALIAS/goals.json','utf8')); console.log(j.goals[0].status)")"
test "$STATUS" = "cancelled"

log
log "PASS: anet goal CLI smoke"
