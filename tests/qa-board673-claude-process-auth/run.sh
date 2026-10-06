#!/usr/bin/env bash
# Board #673. Behavioral gate for processWithClaude.
#
# Real CommHub (isolated DB, not port 9200) plus the real cli.ts loop.
# The SDK query is a scripted upstream (sdk-stub-preload.ts), so no Claude
# binary and no vendor network are required. The reply is read back from
# the hub, not from a source grep.
#
# The #672 static guard still matches after each mutation below. That is
# the point: continue-before-abort, continue-before-catch, and a /* */
# around the abort branch leave the pinned text in place and still change
# what the user is told.
set -uo pipefail

REPO="${REPO:-/app}"
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRELOAD="$TEST_DIR/sdk-stub-preload.ts"
CLI="$REPO/agent-node/src/cli.ts"
source "$REPO/tests/lib/safe-rm.sh"

HUB_PORT="${HUB_PORT:-9730}"
if [[ "$HUB_PORT" == "9200" ]]; then
  echo "REFUSE: port 9200 is the production hub" >&2
  exit 1
fi
HUB_BASE="http://127.0.0.1:$HUB_PORT"
WORK="${WORK:-/tmp/qa-board673}"
export HOME="$WORK/home"
HUB_DB="$WORK/hub.db"
HUB_UPLOADS="$WORK/hub-uploads"
NODE_LOG="$WORK/node.log"
HUB_LOG="$WORK/hub.log"
CFG="$WORK/node-config.json"
CAPTURE="$WORK/capture.jsonl"
ALIAS="board673-agent"
ADMIN_USER="board673admin"
ADMIN_PW="Board673_TestPass_1234"
LOGIN_TEXT="执行出错: Claude 登录或 key 失效，请重新登录"

export BOARD673_CAPTURE_FILE="$CAPTURE"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  PASS %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  FAIL %s\n" "$*"; FAIL=$((FAIL+1)); }

printf "source_commit=%s\n" "${QA_BOARD673_SOURCE_COMMIT:-unknown}"
[[ "${QA_BOARD673_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: QA_BOARD673_SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

safe_rm_rf "$WORK"
mkdir -p "$HOME" "$HUB_UPLOADS"
cp "$CLI" "$WORK/cli.ts.orig"

HUB_PID=""; NODE_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    [[ ! -e "/proc/$pid" ]] && return 0
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    [[ ! -e "/proc/$pid" ]] && return 0
    sleep 0.1
  done
  echo "board673 REFUSE: process-group leader $pid survived cleanup" >&2
  return 1
}

stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_node || true
  local hub_pid="$HUB_PID"
  HUB_PID=""
  stop_group "$hub_pid" || true
  [[ -n "$hub_pid" ]] && wait "$hub_pid" 2>/dev/null || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$CLI"; fi
}
trap cleanup EXIT

note "0. boot hub"
( cd "$REPO/server" && exec setsid env PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$HUB_DB" COMMHUB_UPLOADS_ROOT="$HUB_UPLOADS" \
    bun run src/index.ts >"$HUB_LOG" 2>&1 ) &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
if curl -fsS "$HUB_BASE/health" >/dev/null 2>&1; then ok "hub /health 200 :$HUB_PORT"; else bad "hub did not start"; tail -30 "$HUB_LOG"; exit 1; fi

note "1. admin + network + ntok"
REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"board673@example.com\"}")
UTOK=$(echo "$REG" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != "null" ]] && ok "network_id present" || { bad "no network"; exit 1; }
NTOK=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$ALIAS\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] && ok "agent ntok minted" || { bad "ntok mint failed"; exit 1; }

cat > "$CFG" <<JSON
{ "runtime": "claude-agent-sdk", "model": "claude-sonnet-4-6",
  "hub": "$HUB_BASE", "token": "$NTOK", "network_id": "$NET_ID",
  "flags": { "dangerouslySkipPermissions": true } }
JSON
ok "node config written"

start_node() {
  local scenario="$1"
  rm -f "$CAPTURE"
  : > "$NODE_LOG"
  ( cd "$WORK" && exec setsid env \
      COMMHUB_URL="$HUB_BASE" COMMHUB_TOKEN="$NTOK" ANET_NETWORK_ID="$NET_ID" \
      MODEL="claude-sonnet-4-6" ANTHROPIC_API_KEY="sk-ant-test-invalid" \
      CLAUDE_MAX_RETRIES=0 \
      BOARD673_SCENARIO="$scenario" BOARD673_CAPTURE_FILE="$CAPTURE" \
      REPO="$REPO" HOME="$HOME" \
      bun --preload "$PRELOAD" "$CLI" \
        --alias "$ALIAS" --config "$CFG" >>"$NODE_LOG" 2>&1 ) &
  NODE_PID=$!
  for _ in $(seq 1 60); do
    if curl -fsS "$HUB_BASE/api/status?network_id=$NET_ID" -H "Authorization: Bearer $UTOK" 2>/dev/null \
      | jq -e --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

send_task() {
  local text="$1" resp mid
  resp=$(curl -sS -X POST "$HUB_BASE/api/task" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' \
    -d "{\"alias\":\"$ALIAS\",\"task\":\"$text\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\",\"from\":\"$ADMIN_USER\"}")
  mid=$(echo "$resp" | jq -r '.message_id // empty')
  if [[ -z "$mid" || "$mid" == "null" ]]; then
    echo "task send failed: $resp" >&2
    return 1
  fi
  printf '%s' "$mid"
}

# Prints the task result. Empty and rc 1 on timeout.
wait_result() {
  local tid="$1" row status result
  for _ in $(seq 1 30); do
    row=$(curl -fsS "$HUB_BASE/api/tasks?task_id=$tid&network_id=$NET_ID" -H "Authorization: Bearer $UTOK" 2>/dev/null || true)
    status=$(echo "$row" | jq -r '.tasks[0].status // empty' 2>/dev/null || true)
    result=$(echo "$row" | jq -r '.tasks[0].result // empty' 2>/dev/null || true)
    if [[ -n "$result" && "$result" != "null" && ( "$status" == "replied" || "$status" == "failed" ) ]]; then
      printf '%s' "$result"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Writes the hub reply to $WORK/reply.txt. Returns 0, 10 (no register),
# 11 (task send failed), or 12 (no terminal reply).
run_turn() {
  local scenario="$1" text="$2"
  rm -f "$WORK/reply.txt"
  if ! start_node "$scenario"; then
    tail -40 "$NODE_LOG" >&2 || true
    stop_node || true
    return 10
  fi
  local tid result
  if ! tid=$(send_task "$text"); then
    stop_node || true
    return 11
  fi
  if result=$(wait_result "$tid"); then
    printf '%s' "$result" > "$WORK/reply.txt"
    stop_node || true
    return 0
  fi
  stop_node || true
  return 12
}

anchors_still_present() {
  grep -F 'if (authDecision.action === "abort") {' "$CLI" >/dev/null \
    && grep -F 'authAbortedThisAttempt = true;' "$CLI" >/dev/null \
    && grep -F 'if (thrown.action === "stop") {' "$CLI" >/dev/null
}

read_reply() { cat "$WORK/reply.txt" 2>/dev/null || true; }

note "2. GREEN recover — attempt 1 is not an abort"
if run_turn recover "board673 recover $(date +%s%N)"; then
  RECOVER=$(read_reply)
  if [[ "$RECOVER" == *BOARD673_RECOVERED_OK* && "$RECOVER" != *"$LOGIN_TEXT"* ]]; then
    ok "attempt 1 still returns the recovered text"
  else
    bad "recover reply was: ${RECOVER:-<none>}"
  fi
else
  bad "recover turn failed rc=$?"
  tail -30 "$NODE_LOG" >&2 || true
fi

note "3. GREEN auth — second 401 aborts inside processWithClaude"
if run_turn auth "board673 auth $(date +%s%N)"; then
  AUTH=$(read_reply)
  if [[ "$AUTH" == *"$LOGIN_TEXT"* && "$AUTH" != *BOARD673_SHOULD_HAVE_ABORTED* ]]; then
    ok "hub reply is the login sentence"
  else
    bad "auth reply was: ${AUTH:-<none>}"
    tail -40 "$NODE_LOG" >&2 || true
  fi
else
  bad "auth turn failed rc=$?"
  tail -40 "$NODE_LOG" >&2 || true
fi
if [[ -f "$NODE_LOG" ]] && grep -F 'aborting the attempt' "$NODE_LOG" >/dev/null; then
  ok "abort branch ran"
else
  bad "abort log line missing"
fi

note "4. GREEN region 403 — reason stays, refresh-key sentence does not"
if run_turn region "board673 region $(date +%s%N)"; then
  REGION=$(read_reply)
  if [[ "$REGION" == *"Request not allowed"* \
     && "$REGION" == *"vendor API auth failed"* \
     && "$REGION" != *"refresh API key"* \
     && "$REGION" != *"Claude Code returned an error result"* \
     && "$REGION" != *"请重新登录"* ]]; then
    ok "region reply keeps the vendor reason"
  else
    bad "region reply was: ${REGION:-<none>}"
    tail -40 "$NODE_LOG" >&2 || true
  fi
else
  bad "region turn failed rc=$?"
  tail -40 "$NODE_LOG" >&2 || true
fi

note "5. GREEN permission 403 — reason stays, refresh-key sentence does not"
if run_turn permission "board673 permission $(date +%s%N)"; then
  PERM=$(read_reply)
  if [[ "$PERM" == *"does not have permission"* \
     && "$PERM" == *"vendor API auth failed"* \
     && "$PERM" != *"refresh API key"* \
     && "$PERM" != *"Claude Code returned an error result"* \
     && "$PERM" != *"请重新登录"* ]]; then
    ok "permission reply keeps the vendor reason"
  else
    bad "permission reply was: ${PERM:-<none>}"
    tail -40 "$NODE_LOG" >&2 || true
  fi
else
  bad "permission turn failed rc=$?"
  tail -40 "$NODE_LOG" >&2 || true
fi

witness_red() {
  local mode="$1" scenario="$2" label="$3" rc=0 got
  note "RED $mode"
  cp "$WORK/cli.ts.orig" "$CLI"
  if ! bun "$TEST_DIR/mutate.mjs" "$CLI" "$mode"; then
    bad "$mode did not apply"
    cp "$WORK/cli.ts.orig" "$CLI"
    return
  fi
  if ! anchors_still_present; then
    bad "$mode deleted the pinned text; this is not the bypass under test"
    cp "$WORK/cli.ts.orig" "$CLI"
    return
  fi
  ok "$mode left the static anchors in place"
  run_turn "$scenario" "board673 $mode $(date +%s%N)" || rc=$?
  got=$(read_reply)
  if [[ "$rc" -eq 10 || "$rc" -eq 11 ]]; then
    bad "$mode node never took the task (rc=$rc) — not a behavior miss"
    tail -30 "$NODE_LOG" >&2 || true
  elif [[ "$label" == "auth" ]]; then
    if [[ "$rc" -ne 0 || "$got" != *"$LOGIN_TEXT"* ]]; then
      ok "witnessed red — $mode did not deliver the login sentence (rc=$rc)"
    else
      bad "$mode stayed green: $got"
    fi
  else
    if [[ "$rc" -ne 0 || "$got" != *"vendor API auth failed"* || "$got" == *"Claude Code returned an error result"* || "$got" == *BOARD673_LEAKED* ]]; then
      ok "witnessed red — $mode did not deliver the vendor sentence (rc=$rc)"
    else
      bad "$mode stayed green: $got"
    fi
  fi
  cp "$WORK/cli.ts.orig" "$CLI"
}

witness_red continue-abort auth auth
witness_red continue-catch region region
witness_red comment-abort auth auth

if ! cmp -s "$WORK/cli.ts.orig" "$CLI"; then
  bad "cli.ts was not restored"
  cp "$WORK/cli.ts.orig" "$CLI"
else
  ok "cli.ts restored"
fi

printf "\n────────────────────────────────────────────\n"
printf "board673 processWithClaude auth — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]
