#!/usr/bin/env bash
# Board #673. Behavioral gate for processWithClaude.
#
# Real CommHub (isolated DB, not port 9200) plus the real cli.ts loop.
# The SDK query is a scripted upstream (sdk-stub-preload.ts), so no Claude
# binary and no vendor network are required. The reply is read back from
# the hub, not from a source grep. The capture file counts SDK query()
# calls and upstream HTTP attempts. /api/status is read after the node
# is idle again.
#
# continue-before-abort, continue-before-catch, and a /* */ around the
# abort branch leave the pinned text in place. m8 gates that if with
# false. abort-first moves the attempt threshold in claude-auth-retry.ts.
# retry-first lets the outer retry loop run before the auth stop, so a
# 403 is asked again. drop-login-dead still returns the login sentence
# but never sticks the idle hint. All seven change what the user is told
# or what the node reports.
set -uo pipefail

# Mutations rewrite cli.ts in the tree. A killed host run would leave
# that edit behind. Containers discard the writable layer.
if [[ ! -f /.dockerenv ]]; then
  echo "REFUSE: this suite edits cli.ts and must run in Docker" >&2
  exit 1
fi

REPO="${REPO:-/app}"
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRELOAD="$TEST_DIR/sdk-stub-preload.ts"
CLI="$REPO/agent-node/src/cli.ts"
HELPER="$REPO/agent-node/src/runtime/claude-auth-retry.ts"
source "$REPO/tests/lib/safe-rm.sh"

# Decimal, so 09200 is the production port and not a different string.
HUB_PORT="${HUB_PORT:-9730}"
if [[ ! "$HUB_PORT" =~ ^[0-9]+$ ]]; then
  echo "REFUSE: HUB_PORT must be a decimal port, got: $HUB_PORT" >&2
  exit 1
fi
HUB_PORT=$((10#$HUB_PORT))
if [[ "$HUB_PORT" -eq 9200 ]]; then
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
LOGIN_HINT="Claude 登录已失效"

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
cp "$HELPER" "$WORK/retry.ts.orig"

restore_product() {
  [[ -f "$WORK/cli.ts.orig" ]] && cp "$WORK/cli.ts.orig" "$CLI"
  [[ -f "$WORK/retry.ts.orig" ]] && cp "$WORK/retry.ts.orig" "$HELPER"
}

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
  restore_product
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
# The poll outlives the 20s assertion so a late reply is judged by the
# clock, not reported as "no reply".
wait_result() {
  local tid="$1" row status result
  for _ in $(seq 1 46); do
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

capture_count() {
  local kind="$1"
  if [[ ! -s "$CAPTURE" ]]; then
    echo 0
    return
  fi
  jq -s --arg k "$kind" '[.[] | select(.kind == $k)] | length' "$CAPTURE"
}

write_session() {
  local body
  body=$(curl -fsS "$HUB_BASE/api/status?network_id=$NET_ID&alias=$ALIAS" \
    -H "Authorization: Bearer $UTOK" 2>/dev/null || true)
  if [[ -z "$body" ]]; then
    echo '{}' > "$WORK/status.json"
    return
  fi
  echo "$body" | jq -c --arg a "$ALIAS" '[.sessions[]? | select(.alias==$a)] | .[0] // {}' \
    > "$WORK/status.json" || echo '{}' > "$WORK/status.json"
}

# Auth must reach the idle report that publishes the hint. Other
# scenarios just have to leave "working". 40 * 0.25s.
wait_settled() {
  local scenario="$1" status task
  echo '{}' > "$WORK/status.json"
  for _ in $(seq 1 40); do
    write_session
    status=$(jq -r '.status // empty' "$WORK/status.json")
    task=$(jq -r '.task // empty' "$WORK/status.json")
    if [[ "$scenario" == "auth" ]]; then
      if [[ "$status" == "error" && "$task" == *"$LOGIN_HINT"* ]]; then
        return 0
      fi
    elif [[ -n "$status" && "$status" != "working" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

# Writes the hub reply to $WORK/reply.txt. The third arg is 1 to wait for
# the idle status (green scenarios) or 0 to stop as soon as the reply
# arrives (red witnesses). Returns 0, 10 (no register), 11 (task send
# failed), or 12 (no terminal reply).
run_turn() {
  local scenario="$1" text="$2" settle="${3:-1}"
  rm -f "$WORK/reply.txt" "$WORK/elapsed.ms" "$WORK/status.json"
  if ! start_node "$scenario"; then
    tail -40 "$NODE_LOG" >&2 || true
    stop_node || true
    return 10
  fi
  local tid result start_ns
  start_ns=$(date +%s%N)
  if ! tid=$(send_task "$text"); then
    stop_node || true
    return 11
  fi
  if result=$(wait_result "$tid"); then
    printf '%s' "$result" > "$WORK/reply.txt"
    printf '%s' $(( ($(date +%s%N) - start_ns) / 1000000 )) > "$WORK/elapsed.ms"
    if [[ "$settle" == "1" ]]; then
      wait_settled "$scenario" || true
    fi
    stop_node || true
    return 0
  fi
  printf '%s' $(( ($(date +%s%N) - start_ns) / 1000000 )) > "$WORK/elapsed.ms"
  stop_node || true
  return 12
}

assert_fast() {
  local label="$1" ms
  ms=$(cat "$WORK/elapsed.ms" 2>/dev/null || echo 0)
  if [[ "$ms" -gt 0 && "$ms" -lt 20000 ]]; then
    ok "$label reply in ${ms}ms"
  else
    bad "$label reply took ${ms}ms (want < 20000)"
  fi
}

assert_query_once() {
  local label="$1" n
  n=$(capture_count query)
  n=${n:-0}
  if [[ "$n" == "1" ]]; then
    ok "$label SDK query calls=1"
  else
    bad "$label SDK query calls=$n want 1"
    cat "$CAPTURE" >&2 || true
  fi
}

assert_auth_upstream() {
  local label="$1" n
  n=$(capture_count upstream)
  n=${n:-0}
  # Two 401s, then the abort returns. The third upstream is the request
  # the product must not let through. <=3 hid that.
  if [[ "$n" == "2" ]]; then
    ok "$label upstream requests=$n"
  else
    bad "$label upstream requests=$n want 2"
    cat "$CAPTURE" >&2 || true
  fi
}

assert_login_dead() {
  local status task raw
  raw=$(cat "$WORK/status.json" 2>/dev/null || echo '{}')
  status=$(printf '%s' "$raw" | jq -r '.status // empty')
  task=$(printf '%s' "$raw" | jq -r '.task // empty')
  if [[ "$status" == "error" && "$task" == *"$LOGIN_HINT"* ]]; then
    ok "auth idle status is login-dead"
  else
    bad "auth status missing login-dead hint: $raw"
  fi
}

assert_not_login_dead() {
  local label="$1" status task raw
  raw=$(cat "$WORK/status.json" 2>/dev/null || echo '{}')
  status=$(printf '%s' "$raw" | jq -r '.status // empty')
  task=$(printf '%s' "$raw" | jq -r '.task // empty')
  if [[ "$status" == "idle" && "$task" != *"$LOGIN_HINT"* && "$raw" != *"$LOGIN_HINT"* ]]; then
    ok "$label status is idle, not login-dead"
  else
    bad "$label status looked login-dead: $raw"
  fi
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
  assert_fast recover
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
  assert_query_once auth
  assert_auth_upstream auth
  assert_fast auth
  assert_login_dead
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
  assert_query_once region
  assert_fast region
  assert_not_login_dead region
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
  assert_query_once permission
  assert_fast permission
  assert_not_login_dead permission
else
  bad "permission turn failed rc=$?"
  tail -40 "$NODE_LOG" >&2 || true
fi

anchors_for() {
  local mode="$1"
  case "$mode" in
    m8)
      grep -F 'if (false && authDecision.action === "abort") {' "$CLI" >/dev/null \
        && grep -F 'authAbortedThisAttempt = true;' "$CLI" >/dev/null \
        && grep -F 'if (thrown.action === "stop") {' "$CLI" >/dev/null
      ;;
    abort-first)
      grep -F 'if (attempt >= 1) {' "$HELPER" >/dev/null \
        && ! grep -F 'if (attempt >= 2) {' "$HELPER" >/dev/null \
        && anchors_still_present
      ;;
    retry-first)
      grep -F 'if (thrown.action === "stop" && attempt >= CLAUDE_MAX_RETRIES) {' "$CLI" >/dev/null \
        && [[ "$(grep -cF 'if (thrown.action === "stop") {' "$CLI")" -eq 0 ]] \
        && grep -F 'if (authDecision.action === "abort") {' "$CLI" >/dev/null \
        && grep -F 'authAbortedThisAttempt = true;' "$CLI" >/dev/null
      ;;
    drop-login-dead)
      anchors_still_present \
        && grep -F 'aborting the attempt' "$CLI" >/dev/null \
        && [[ "$(grep -cF 'markClaudeLoginDead();' "$CLI")" -eq 1 ]] \
        && grep -F 'if (thrown.markLoginDead) markClaudeLoginDead();' "$CLI" >/dev/null
      ;;
    *)
      anchors_still_present
      ;;
  esac
}

witness_red() {
  local mode="$1" file="$2" scenario="$3" label="$4" settle="${5:-0}" rc=0 got
  note "RED $mode"
  restore_product
  if ! bun "$TEST_DIR/mutate.mjs" "$file" "$mode"; then
    bad "$mode did not apply"
    restore_product
    return
  fi
  if ! anchors_for "$mode"; then
    bad "$mode deleted the pinned text; this is not the bypass under test"
    restore_product
    return
  fi
  ok "$mode left the pinned decision in place"
  run_turn "$scenario" "board673 $mode $(date +%s%N)" "$settle" || rc=$?
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
  elif [[ "$label" == "login-dead" ]]; then
    local status task
    status=$(jq -r '.status // empty' "$WORK/status.json" 2>/dev/null || true)
    task=$(jq -r '.task // empty' "$WORK/status.json" 2>/dev/null || true)
    if [[ "$rc" -ne 0 || "$got" != *"$LOGIN_TEXT"* ]]; then
      bad "$mode did not finish the auth reply (rc=$rc): ${got:-<none>}"
    elif [[ "$status" == "error" && "$task" == *"$LOGIN_HINT"* ]]; then
      bad "$mode stayed green: status still login-dead"
    elif [[ "$status" == "idle" && "$task" != *"$LOGIN_HINT"* ]]; then
      ok "witnessed red — $mode did not stick the login-dead status (status=$status)"
    else
      bad "$mode status was not a clean miss: status=${status:-empty} task=${task:-empty}"
    fi
  elif [[ "$label" == "recover" ]]; then
    if [[ "$rc" -ne 0 || "$got" != *BOARD673_RECOVERED_OK* || "$got" == *"$LOGIN_TEXT"* ]]; then
      ok "witnessed red — $mode aborted the refresh retry (rc=$rc)"
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
  restore_product
}

witness_red continue-abort "$CLI" auth auth
witness_red continue-catch "$CLI" region region
witness_red comment-abort "$CLI" auth auth
witness_red m8 "$CLI" auth auth
witness_red abort-first "$HELPER" recover recover
witness_red retry-first "$CLI" region region
witness_red drop-login-dead "$CLI" auth login-dead 1

if ! cmp -s "$WORK/cli.ts.orig" "$CLI" || ! cmp -s "$WORK/retry.ts.orig" "$HELPER"; then
  bad "product sources were not restored"
  restore_product
else
  ok "cli.ts and claude-auth-retry.ts restored"
fi

printf "\n────────────────────────────────────────────\n"
printf "board673 processWithClaude auth — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]
