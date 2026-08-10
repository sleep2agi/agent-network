#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/test185}"
PORT="${PORT:-9185}"
BASE="http://127.0.0.1:$PORT"
ALIAS="external-schedule-node"
ADMIN="external_schedule_admin"
PASSWORD="External-Schedule-Strong-1!"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

test "${TEST185_SOURCE_COMMIT:-unknown}" != unknown
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/node"
export HOME="$WORK/home"

HUB_PID=""
NODE_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
cleanup() {
  stop_group "$NODE_PID" || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok 'real Hub booted'

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test185@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
NTOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || fail 'node token mint'
ok 'network-scoped node token minted'

CFG="$WORK/node/config.json"
MANIFEST="$WORK/node/external-schedules.json"
cat >"$CFG" <<JSON
{"alias":"$ALIAS","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET"}
JSON
cat >"$MANIFEST" <<'JSON'
{"external_schedules":[{"id":"pstation-smoke","name":"P station smoke","kind":"playwright","frequency":"*/5 * * * *","last_run_at":"2026-08-10T01:02:03Z","last_status":"success","last_error":null,"next_run_at":"2026-08-10T01:07:03Z","log_path":"/var/private/pstation-smoke.log","enabled":true}]}
JSON

start_node() {
  NODE_PID=""
  (cd "$WORK" && exec setsid env ANTHROPIC_API_KEY=test185-not-used HOME="$HOME" \
    bun "$REPO/agent-node/src/cli.ts" --alias "$ALIAS" --config "$CFG" >"$WORK/node.log" 2>&1) &
  NODE_PID=$!
}
stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}
status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)'
}
wait_snapshot() {
  local predicate="$1"
  for _ in $(seq 1 80); do
    local row
    row=$(status_row || true)
    if [[ -n "$row" ]] && jq -e "$predicate" >/dev/null 2>&1 <<<"$row"; then printf '%s\n' "$row"; return 0; fi
    sleep 0.25
  done
  return 1
}

start_node
ROW=$(wait_snapshot '.external_schedules.schedules[0].id == "pstation-smoke"') || { tail -100 "$WORK/node.log"; fail 'real heartbeat did not surface manifest'; }
jq -e '.external_schedules.schedules[0].log_ref == "pstation-smoke.log"' >/dev/null <<<"$ROW" || fail 'basename log_ref missing'
if grep -q '/var/private' <<<"$ROW"; then fail 'host path leaked through REST'; fi
ok 'real agent heartbeat surfaces bounded snapshot without host path'

stop_node
rm -f "$MANIFEST"
start_node
ROW=$(wait_snapshot '.external_schedules.schedules == [] and (.external_schedules.error == null)') || fail 'missing manifest did not become explicit empty observation'
ok 'new agent reports explicit empty list for missing manifest'

stop_node
printf '%s\n' '{"external_schedules":[{"id":"x","name":"x","kind":"custom","frequency":"5m","command":"cat /etc/passwd"}]}' >"$MANIFEST"
start_node
ROW=$(wait_snapshot '.external_schedules.error == "invalid_manifest" and .external_schedules.schedules == []') || fail 'invalid manifest was not fail-closed telemetry'
if grep -q 'cat /etc/passwd' <<<"$ROW"; then fail 'unknown manifest field leaked'; fi
ok 'malformed/unknown manifest fields fail closed without leaking content'

stop_node
cp "$REPO/agent-node/src/cli.ts" "$WORK/cli.ts.orig"
node "$REPO/tests/test185-external-schedules/mutate-heartbeat.mjs" "$REPO/agent-node/src/cli.ts"
rm -f "$MANIFEST"
start_node
set +e
wait_snapshot '.external_schedules.schedules == [] and (.external_schedules.error == null)' >"$WORK/mutation-row.json"
MUT_RC=$?
set -e
stop_node
cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"
[[ "$MUT_RC" -ne 0 ]] || fail 'delete-heartbeat-wiring mutation stayed green'
ok 'witnessed-red: deleting heartbeat wiring removes the observable snapshot'

(cd "$REPO/agent-node" && bun test src/external-schedules.test.ts)
ok 'manifest parser unit gates pass'
(cd "$REPO/server" && bun test src/rest-explicit-columns-http.test.ts)
ok 'REST projection gate passes'

printf 'source_commit=%s\n' "$TEST185_SOURCE_COMMIT"
printf 'RESULT: PASS (%s checks)\n' "$PASS"
