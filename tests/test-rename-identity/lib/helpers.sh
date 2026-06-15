# Shared bash helpers for PR-5 14-case rename matrix.
# Source via: . /harness/lib/helpers.sh
#
# Provides:
#   - LOG / mask
#   - PASS/FAIL accumulators + record_case_result
#   - start_hub / stop_hub / hub_pid / hub_alive
#   - bootstrap_admin (registers e2e-bootstrap → exports UTOK NTOK NET_ID USER_ID)
#   - mcp_call <tool> <args_json> [token]
#   - send_task_rest <alias> <task_text> [from_name] [token]
#   - send_message_rest <alias> <msg> [from_name] [token]
#   - sqlite_inbox_for_alias <alias>
#   - find_node_id <work_dir> <alias>
#
# All curl + sqlite output goes through mask() before echo.

HUB="${HUB_URL:-http://127.0.0.1:9200}"
DB_PATHS=(~/.commhub/commhub.db /root/.commhub/commhub.db /home/anet/.commhub/commhub.db)

LOG(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "${ART_DIR:-/artifacts}/run.log"; }
mask(){ sed -E 's/(utok_|ntok_|sk-|tp-|xai-|sk-ant-)[A-Za-z0-9_-]+/\1•••MASKED•••/g'; }

# --- pass/fail accumulators (use in each case) ---
_PASS_COUNT=0
_FAIL_COUNT=0
_FINDINGS=()
record_check(){
  local label="$1" verdict="$2" evidence="$3"
  if [ "$verdict" = "PASS" ]; then
    _PASS_COUNT=$((_PASS_COUNT+1))
    LOG "✅ $label — $evidence"
  else
    _FAIL_COUNT=$((_FAIL_COUNT+1))
    _FINDINGS+=("$label: $evidence")
    LOG "❌ $label — $evidence"
  fi
}
case_verdict(){
  local case_id="$1"
  if [ "$_FAIL_COUNT" -eq 0 ]; then
    echo "PASS|$case_id|$_PASS_COUNT/$_PASS_COUNT checks"
  else
    local detail=""
    for f in "${_FINDINGS[@]}"; do detail+="$f; "; done
    echo "FAIL|$case_id|$_FAIL_COUNT fails: $detail"
  fi
}

# --- hub lifecycle (raw bun, so we can stop/restart cleanly per case) ---
start_hub(){
  local logfile="${1:-${ART_DIR:-/artifacts}/hub.log}"
  ( cd /app/server && nohup bun run src/index.ts > "$logfile" 2>&1 & )
  for i in $(seq 1 80); do
    if curl -sf --max-time 1 "$HUB/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  LOG "start_hub: TIMEOUT, last log tail:"; tail -10 "$logfile" | mask
  return 1
}

stop_hub(){
  for p in $(pgrep -f 'src/index.ts' 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
  for i in $(seq 1 20); do
    curl -sf --max-time 1 "$HUB/health" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  for p in $(pgrep -f 'src/index.ts' 2>/dev/null); do kill -KILL "$p" 2>/dev/null; done
  sleep 0.5
}

hub_alive(){ curl -sf --max-time 1 "$HUB/health" >/dev/null 2>&1; }

# --- bootstrap admin user + network (exports UTOK NTOK NET_ID USER_ID) ---
bootstrap_admin(){
  local user="${1:-e2e-bootstrap}" pass="${2:-bootstrap-pass-123}"
  local resp
  resp=$(curl -sf -X POST "$HUB/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$user" --arg p "$pass" '{username:$u,password:$p}')") || true
  if [ -z "$resp" ] || ! echo "$resp" | grep -q '"token"'; then
    resp=$(curl -sf -X POST "$HUB/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg u "$user" --arg p "$pass" '{username:$u,password:$p}')")
  fi
  export UTOK=$(echo "$resp" | jq -r '.token // ""')
  export NTOK=$(echo "$resp" | jq -r '.network_token // ""')
  export NET_ID=$(echo "$resp" | jq -r '.network_id // ""')
  export USER_ID=$(echo "$resp" | jq -r '.user.user_id // ""')
  [ -n "$UTOK" ] && [ -n "$NET_ID" ] || { LOG "bootstrap_admin FAILED: resp=$(echo $resp | mask | head -c 200)"; return 1; }
  mkdir -p ~/.anet
  cat > ~/.anet/config.json <<JSON
{ "hub":"$HUB","token":"$UTOK","network_token":"$NTOK","user_id":"$USER_ID","username":"$user","network_id":"$NET_ID","network_name":"default" }
JSON
}

# --- MCP tool call ---
mcp_call(){
  local tool="$1" args="$2" tok="${3:-$UTOK}"
  curl -sf -X POST "$HUB/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $tok" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"pr5","version":"1.0"}}}' >/dev/null 2>&1
  curl -s -X POST "$HUB/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $tok" \
    -d "$(jq -nc --arg name "$tool" --argjson args "$args" \
            '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$name,arguments:$args}}')"
}

# --- REST send_task (POST /api/task) ---
send_task_rest(){
  local alias="$1" task="$2" from="${3:-tester}" tok="${4:-$UTOK}"
  curl -s -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg a "$alias" --arg t "$task" --arg n "$NET_ID" --arg f "$from" \
            '{alias:$a,task:$t,priority:"normal",network_id:$n,from:$f}')"
}

# --- find sqlite db path (varies by user) ---
db_path(){
  for cand in "${DB_PATHS[@]}"; do [ -f "$cand" ] && echo "$cand" && return; done
  find ~ /tmp /app -name commhub.db -size +0 2>/dev/null | head -1
}

# --- inbox query helpers ---
sqlite_inbox_for_alias(){
  local alias="$1" db; db=$(db_path)
  [ -n "$db" ] || { echo "[]"; return; }
  sqlite3 -json "$db" "SELECT session_name, COALESCE(from_alias,'') as from_alias, substr(content,1,80) as content FROM inbox WHERE session_name = '$alias' LIMIT 20;" 2>/dev/null
}
sqlite_inbox_grep(){
  local nonce="$1" db; db=$(db_path)
  [ -n "$db" ] || { echo "[]"; return; }
  sqlite3 -json "$db" "SELECT session_name, COALESCE(from_alias,'') as from_alias, substr(content,1,80) as content FROM inbox WHERE content LIKE '%$nonce%' LIMIT 20;" 2>/dev/null
}

# --- find node_id for a created node by reading config.json ---
find_node_id(){
  local work="$1" alias="$2"
  jq -r '.node_id // empty' "$work/.anet/nodes/$alias/config.json" 2>/dev/null
}

# --- assert helpers ---
assert_eq(){
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    record_check "$label" PASS "expected=$expected, actual=$actual"
  else
    record_check "$label" FAIL "expected=$expected, actual=$actual"
  fi
}
assert_contains(){
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    record_check "$label" PASS "found '$needle' in output"
  else
    record_check "$label" FAIL "no '$needle' in: $(echo $haystack | mask | head -c 200)"
  fi
}
assert_not_contains(){
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    record_check "$label" FAIL "unexpected '$needle' in: $(echo $haystack | mask | head -c 200)"
  else
    record_check "$label" PASS "absent: '$needle'"
  fi
}
