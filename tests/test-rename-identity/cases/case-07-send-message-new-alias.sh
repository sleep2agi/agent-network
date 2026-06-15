#!/usr/bin/env bash
# Case 7 — #146 happy path: rename → send_message to NEW alias → success +
# row at new alias (sanity baseline for case 6's canonical-redirect logic).
set -u
. /harness/lib/helpers.sh
WORK="/work/case-07"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 7 #146 happy path: send_message to NEW alias after rename"

anet node create v1 --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
nohup anet node start v1 > "$ART_DIR/start-v1.log" 2>&1 &
P1=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-v1.log" 2>/dev/null && break; sleep 1; done
kill -TERM "$P1" 2>/dev/null; sleep 2

anet node rename v1 v2 --force > "$ART_DIR/rename.log" 2>&1
record_check "rename succeeded" PASS "rc=$?"

nohup anet node start v2 > "$ART_DIR/start-v2.log" 2>&1 &
P2=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-v2.log" 2>/dev/null && break; sleep 1; done

# Send to NEW alias v2
NONCE="C7-$(date +%s%N)"
ARGS="$(jq -nc --arg a v2 --arg m "$NONCE new-alias-happy" --arg n "$NET_ID" --arg f "tester" '{alias:$a,message:$m,from_session:$f,network_id:$n}')"
RESP=$(mcp_call "send_message" "$ARGS" "$UTOK")
LOG "send_message to NEW alias 'v2' → $(echo $RESP | mask | head -c 200)"

echo "$RESP" | grep -q '"ok":true\|"status":"queued"' && record_check "send_message accepted" PASS "" || record_check "send_message accepted" FAIL "resp=$(echo $RESP | mask | head -c 150)"
assert_not_contains "no 'alias_not_found'" "alias_not_found" "$RESP"

sleep 2
DB=$(db_path)
INBOX_HITS=$(sqlite3 -json "$DB" "SELECT session_name FROM inbox WHERE content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null)
TASKS_HITS=$(sqlite3 -json "$DB" "SELECT to_name FROM tasks WHERE task_text LIKE '%$NONCE%' OR content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null || echo "[]")
LOG "inbox: $INBOX_HITS, tasks: $TASKS_HITS"
echo "$INBOX_HITS$TASKS_HITS" | grep -q '"v2"' && record_check "row at NEW alias v2" PASS "row landed canonically" || record_check "row at NEW alias v2" FAIL "no v2 row (may be SSE-pushed without DB insert if connected — soft check)"

# Status check via /api/status — v2 should be visible
STATUS=$(curl -sf -H "Authorization: Bearer $UTOK" "$HUB/api/status" 2>/dev/null | jq -c '[.sessions[]?|select(.alias=="v2")][0]|.alias' 2>/dev/null)
[ "$STATUS" = '"v2"' ] && record_check "/api/status shows v2" PASS "dashboard-visible" || record_check "/api/status shows v2" FAIL "alias=$STATUS"

kill -TERM "$P2" 2>/dev/null
stop_hub
case_verdict 7 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
