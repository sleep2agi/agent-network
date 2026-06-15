#!/usr/bin/env bash
# Case 6 — #146 smoking gun: rename → send_message to OLD alias →
# canonical resolve redirects to NEW alias. Pre-PR-1 fix: send_message had
# NO resolveCanonicalAlias() call, message would silent-drop. Post-fix:
# both send_message and send_task canonicalize.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-06"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 6 #146 smoking gun: send_message to OLD alias after rename → canonical redirect"

anet node create old-name --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
OLD_NID=$(find_node_id "$WORK" old-name)
nohup anet node start old-name > "$ART_DIR/start-old.log" 2>&1 &
PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-old.log" 2>/dev/null && break; sleep 1; done
kill -TERM "$PID" 2>/dev/null; sleep 2

# Rename old-name → new-name
anet node rename old-name new-name --force > "$ART_DIR/rename.log" 2>&1
record_check "rename succeeded" PASS "rc=$?"

# Start new-name
nohup anet node start new-name > "$ART_DIR/start-new.log" 2>&1 &
PID2=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-new.log" 2>/dev/null && break; sleep 1; done

# Now: send_MESSAGE (not send_task) to OLD alias — pre-#146-fix this would silent-drop
NONCE="C6-$(date +%s%N)"
ARGS="$(jq -nc --arg a old-name --arg m "$NONCE old-alias-routing-check" --arg n "$NET_ID" --arg f "tester" '{alias:$a,message:$m,from_session:$f,network_id:$n}')"
RESP=$(mcp_call "send_message" "$ARGS" "$UTOK")
LOG "send_message to OLD alias 'old-name' → $(echo $RESP | mask | head -c 200)"

# Pass: response has ok:true (routing accepted) — and tasks/inbox shows it under NEW alias
echo "$RESP" | grep -q '"ok":true\|"status":"queued"\|"renamed_from"\|"redirected"' && record_check "send_message accepted (canonical resolve fired)" PASS "" || record_check "send_message accepted" FAIL "resp=$(echo $RESP | mask | head -c 200)"

# Look for the message in tasks/inbox under NEW canonical alias
sleep 2
DB=$(db_path)
INBOX_HITS=$(sqlite3 -json "$DB" "SELECT session_name FROM inbox WHERE content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null)
TASKS_HITS=$(sqlite3 -json "$DB" "SELECT to_name FROM tasks WHERE task_text LIKE '%$NONCE%' OR content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null || echo "[]")
LOG "inbox session_name hits: $INBOX_HITS"
LOG "tasks to_name hits: $TASKS_HITS"

# Either inbox.session_name OR tasks.to_name should be "new-name" (canonical), NEVER "old-name"
if echo "$INBOX_HITS$TASKS_HITS" | grep -q '"new-name"'; then
  record_check "row landed at NEW canonical alias" PASS "found 'new-name' (canonical)"
elif echo "$INBOX_HITS$TASKS_HITS" | grep -q '"old-name"'; then
  record_check "row landed at NEW canonical alias" FAIL "row at OLD alias 'old-name' — PR-1 canonicalization fix not firing for send_message"
else
  record_check "row landed at NEW canonical alias" FAIL "no row found for nonce — message dropped: inbox=$INBOX_HITS tasks=$TASKS_HITS"
fi

# Cleanup
kill -TERM "$PID2" 2>/dev/null
stop_hub
case_verdict 6 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
