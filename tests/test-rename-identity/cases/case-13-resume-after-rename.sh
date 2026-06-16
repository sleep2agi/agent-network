#!/usr/bin/env bash
# Case 13 — SDK马 add: rename → restart node → session resume → #213
# resume-hint must correctly fetch old-alias-period outbound tasks via
# `from_node_id` query (PR-1 added `from_node_id` column + list_tasks
# accepts from_node_id param + PR-4 changed fetchUnresolvedOutbound from
# alias to node_id lookup).
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-13"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 13 SDK马: rename → restart node → #213 hint resolves OLD-alias outbound via node_id"

anet node create r-old --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" r-old)
LOG "r-old node_id=$NID"

# Start r-old, let it run a bit so SSE+register settle
nohup anet node start r-old > "$ART_DIR/start-old.log" 2>&1 &
P=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-old.log" 2>/dev/null && break; sleep 1; done

# Issue an outbound task FROM r-old (sender perspective) — fake by injecting
# directly via MCP send_task with from_session=r-old
NONCE="C13-$(date +%s%N)"
ARGS="$(jq -nc --arg a r-old --arg t "$NONCE outbound-during-old-alias" --arg n "$NET_ID" --arg f "r-old" '{alias:$a,task:$t,from_session:$f,network_id:$n}')"
mcp_call "send_task" "$ARGS" "$UTOK" > "$ART_DIR/outbound-old.json" 2>&1
LOG "outbound sent from r-old: $(head -c 150 $ART_DIR/outbound-old.json | mask)"
sleep 1

# Check tasks table has the from_node_id column populated
DB=$(db_path)
COLS=$(sqlite3 "$DB" "PRAGMA table_info(tasks);" 2>/dev/null | tr '\n' '|')
LOG "tasks columns: $COLS"
echo "$COLS" | grep -q 'from_node_id' && record_check "tasks.from_node_id column exists" PASS "schema includes PR-1 column" || record_check "tasks.from_node_id column exists" FAIL "schema missing from_node_id (PR-1 schema migration not applied?)"

# Verify the outbound has from_node_id populated
FNID=$(sqlite3 "$DB" "SELECT COALESCE(from_node_id,'') FROM tasks WHERE content LIKE '%$NONCE%' LIMIT 1;" 2>/dev/null)
LOG "outbound from_node_id col value = '$FNID'"
if [ -n "$FNID" ]; then
  record_check "outbound has from_node_id populated" PASS "from_node_id=$FNID"
else
  record_check "outbound has from_node_id populated" FAIL "from_node_id empty — PR-1+4 wire not landing"
fi

# Stop, rename, restart
kill -TERM "$P" 2>/dev/null; sleep 2
anet node rename r-old r-new --force > "$ART_DIR/rename.log" 2>&1
record_check "rename ok" PASS "rc=$?"

NID2=$(find_node_id "$WORK" r-new)
assert_eq "node_id stable" "$NID" "$NID2"

# Restart as r-new
nohup anet node start r-new > "$ART_DIR/start-new.log" 2>&1 &
P2=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-new.log" 2>/dev/null && break; sleep 1; done

# list_tasks via MCP with from_node_id (NOT from_name) — should return the
# old-alias outbound (the one we sent while alias was r-old)
ARGS_LT="$(jq -nc --arg nid "$NID" '{from_node_id:$nid,limit:20}')"
LT_RESP=$(mcp_call "list_tasks" "$ARGS_LT" "$UTOK")
LOG "list_tasks from_node_id=$NID → $(echo $LT_RESP | mask | head -c 250)"
echo "$LT_RESP" | grep -q "$NONCE" && record_check "list_tasks(from_node_id) finds old-alias outbound" PASS "#213 hint correct via node_id" || record_check "list_tasks(from_node_id) finds old-alias outbound" FAIL "not found in: $(echo $LT_RESP | mask | head -c 200)"

kill -TERM "$P2" 2>/dev/null
stop_hub
case_verdict 13 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
