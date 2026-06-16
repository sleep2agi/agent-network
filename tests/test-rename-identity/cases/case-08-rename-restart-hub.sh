#!/usr/bin/env bash
# Case 8 — rename → restart hub → identity persists + SSE Map rebuilt by
# node_id (PR-1 commitRename eventBus + node_id-keyed Map).
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-08"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 8: rename → restart hub → identity persists, SSE Map node_id-keyed"

anet node create n8a --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" n8a)
nohup anet node start n8a > "$ART_DIR/start.log" 2>&1 &
PA=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start.log" 2>/dev/null && break; sleep 1; done
kill -TERM "$PA" 2>/dev/null; sleep 2

# Rename n8a → n8b
anet node rename n8a n8b --force > "$ART_DIR/rename.log" 2>&1
record_check "rename ok" PASS "rc=$?"

# Restart hub (stop + start)
stop_hub
LOG "hub stopped; restarting..."
start_hub "$ART_DIR/hub2.log" || { record_check "hub restart" FAIL "hub did not come back"; exit 1; }
record_check "hub restarted clean" PASS "/health 200"

# Re-bootstrap (login again — admin record persists in SQLite)
TOKEN_RESP=$(curl -sf -X POST "$HUB/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e-bootstrap","password":"bootstrap-pass-123"}')
UTOK=$(echo "$TOKEN_RESP" | jq -r '.token // empty')
[ -n "$UTOK" ] && record_check "admin survives hub restart" PASS "re-login ok" || record_check "admin survives hub restart" FAIL "no token after restart"

# Start n8b, check it registers under new alias + same node_id
nohup anet node start n8b > "$ART_DIR/start-n8b.log" 2>&1 &
PB=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-n8b.log" 2>/dev/null && break; sleep 1; done

DB=$(db_path)
SESS=$(sqlite3 -json "$DB" "SELECT alias, node_id FROM sessions WHERE alias='n8b' LIMIT 1;" 2>/dev/null)
echo "$SESS" | grep -q "\"alias\":\"n8b\"" && record_check "sessions shows n8b post-restart" PASS "row exists" || record_check "sessions shows n8b post-restart" FAIL "no n8b row: $(echo $SESS | mask | head -c 120)"
if [ -n "$NID" ]; then
  echo "$SESS" | grep -q "\"node_id\":\"$NID\"" && record_check "node_id persists across hub restart" PASS "$NID" || record_check "node_id persists across hub restart" FAIL "expected $NID, sessions row=$(echo $SESS | mask | head -c 120)"
fi

# Send_task to n8b after hub restart — should route cleanly
NONCE="C8-$(date +%s%N)"
RESP=$(send_task_rest "n8b" "$NONCE post-hub-restart" "tester" "$UTOK")
echo "$RESP" | grep -q '"ok":true' && record_check "send_task to n8b after restart" PASS "" || record_check "send_task to n8b" FAIL "resp=$(echo $RESP | mask | head -c 150)"

kill -TERM "$PB" 2>/dev/null
stop_hub
case_verdict 8 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
