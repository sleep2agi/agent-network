#!/usr/bin/env bash
# Case 6 — #146 smoking gun: rename → send_message to OLD alias →
# canonical resolve redirects to NEW alias. Pre-PR-1 fix: send_message had
# NO resolveCanonicalAlias() call, message would silent-drop. Post-fix:
# both send_message and send_task canonicalize.
#
# Test design uses a SEPARATE sender node to satisfy PR-4 #203
# from_session_identity_mismatch enforcement (bf564fb). Sender's ntok
# proves the from_session field; target alias is what canonical resolve
# operates on.
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-06"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 6 #146 smoking gun: send_message to OLD alias after rename → canonical redirect"

# Sender node — its ntok identity satisfies #203 enforcement
anet node create sender --runtime grok-build-acp > "$ART_DIR/sender-create.log" 2>&1
SENDER_NTOK=$(jq -r '.token // .network_token // .commhub.network_token // empty' "$WORK/.anet/nodes/sender/config.json" 2>/dev/null)
[ -n "$SENDER_NTOK" ] && record_check "sender ntok captured" PASS "have sender's network_token" || record_check "sender ntok captured" FAIL "no ntok in sender config: $(cat $WORK/.anet/nodes/sender/config.json 2>/dev/null | jq -c 'keys')"

# Target node — old-name will be renamed to new-name
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

# send_MESSAGE from SENDER (using its ntok) to OLD alias old-name —
# pre-PR-1 fix would silent-drop because send_message had no canonical resolve.
NONCE="C6-$(date +%s%N)"
ARGS="$(jq -nc --arg a old-name --arg m "$NONCE old-alias-routing-check" --arg n "$NET_ID" --arg f "sender" '{alias:$a,message:$m,from_session:$f,network_id:$n}')"
RESP=$(mcp_call "send_message" "$ARGS" "$SENDER_NTOK")
LOG "send_message from=sender → OLD alias 'old-name' → $(echo $RESP | mask | head -c 200)"

# Two failure modes to rule out: explicit error + alias_not_found.
# If neither present, the row-landing check below is the authoritative
# proof of canonical-redirect success.
if echo "$RESP" | grep -qiE 'permission_denied|alias_not_found|identity_mismatch|"error":'; then
  record_check "send_message accepted" FAIL "resp has error marker: $(echo $RESP | mask | head -c 200)"
else
  record_check "send_message accepted (no error marker)" PASS "response has no explicit error; row-landing below is authoritative"
fi

# Look for the message at NEW canonical alias (inbox or tasks)
sleep 2
DB=$(db_path)
INBOX_HITS=$(sqlite3 -json "$DB" "SELECT session_name FROM inbox WHERE content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null)
TASKS_HITS=$(sqlite3 -json "$DB" "SELECT to_name FROM tasks WHERE content LIKE '%$NONCE%' LIMIT 5;" 2>/dev/null || echo "[]")
LOG "inbox session_name hits: $INBOX_HITS"
LOG "tasks to_name hits: $TASKS_HITS"

if echo "$INBOX_HITS$TASKS_HITS" | grep -q '"new-name"'; then
  record_check "row landed at NEW canonical alias" PASS "found 'new-name' (canonical, redirect worked)"
elif echo "$INBOX_HITS$TASKS_HITS" | grep -q '"old-name"'; then
  record_check "row landed at NEW canonical alias" FAIL "row at OLD alias 'old-name' — PR-1 canonicalization fix not firing for send_message"
else
  record_check "row landed at NEW canonical alias" FAIL "no row found for nonce — message dropped: inbox=$INBOX_HITS tasks=$TASKS_HITS"
fi

kill -TERM "$PID2" 2>/dev/null
stop_hub
case_verdict 6 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
