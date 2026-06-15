#!/usr/bin/env bash
# Case 1 — rename idle (never-started) node — actually this is purely-created.
# Wait — per spec: "rename idle stopped node" = node was started then stopped.
# After rename + restart, new alias works + server routing hits.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-01"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 1: rename idle (stopped after first start) — node-a → node-b"

# Create + start node-a (grok-build-acp, fake-grok, no auth needed)
anet node create node-a --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" node-a)
[ -n "$NID" ] || { record_check "node_id-generated" FAIL "no node_id in config"; }
record_check "node-a created" PASS "node_id=$NID, alias=node-a"

# Start node-a, wait for SSE connected, then stop it (idle baseline)
nohup anet node start node-a > "$ART_DIR/start-a.log" 2>&1 &
NA_PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-a.log" 2>/dev/null && break; sleep 1; done
grep -q 'SSE connected' "$ART_DIR/start-a.log" && record_check "node-a first-start SSE up" PASS "SSE connected seen" || record_check "node-a first-start SSE up" FAIL "no SSE connected in 30s"
kill -TERM "$NA_PID" 2>/dev/null; sleep 2

# Rename node-a → node-b (node is stopped — idle path)
anet node rename node-a node-b --force > "$ART_DIR/rename.log" 2>&1
RC_R=$?
LOG "rename rc=$RC_R, output: $(head -3 $ART_DIR/rename.log | mask | tr '\n' ' ')"
[ $RC_R -eq 0 ] && record_check "rename rc=0" PASS "rc=0" || record_check "rename rc=0" FAIL "rc=$RC_R"

# Dir flipped to new alias
[ -d "$WORK/.anet/nodes/node-b" ] && record_check "dir flipped to node-b" PASS "dir exists" || record_check "dir flipped to node-b" FAIL "no node-b dir"
[ ! -d "$WORK/.anet/nodes/node-a" ] && record_check "old node-a dir removed" PASS "old dir gone" || record_check "old node-a dir removed" FAIL "old dir lingers"

# node_id stable across rename
NID2=$(find_node_id "$WORK" node-b)
assert_eq "node_id stable across rename" "$NID" "$NID2"

# Restart with new alias — should register + SSE connect
nohup anet node start node-b > "$ART_DIR/start-b.log" 2>&1 &
NB_PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-b.log" 2>/dev/null && break; sleep 1; done
grep -q 'SSE connected' "$ART_DIR/start-b.log" && record_check "node-b post-rename SSE up" PASS "SSE connected seen" || record_check "node-b post-rename SSE up" FAIL "no SSE connected in 30s"

# Send_task to NEW alias node-b — assert routing (observable contract),
# not inbox-row (implementation detail — SSE-connected nodes get push, no
# inbox insert). Per 通信龙 裁定 7f89b60d.
NONCE="C1-$(date +%s%N)"
RESP=$(send_task_rest "node-b" "$NONCE rename-routing-check" "tester" "$UTOK")
LOG "send_task → $(echo $RESP | mask | head -c 150)"
echo "$RESP" | grep -q '"ok":true' && record_check "send_task accepted (HTTP 200 + ok:true)" PASS "routing accepted at new alias" || record_check "send_task accepted" FAIL "resp=$(echo $RESP | mask | head -c 150)"
TASK_ID=$(echo "$RESP" | jq -r '.task_id // empty' 2>/dev/null)
[ -n "$TASK_ID" ] && record_check "task_id assigned" PASS "task_id=${TASK_ID:0:12}…" || record_check "task_id assigned" FAIL "no task_id in resp"
# Tasks table row for the new alias (canonical routing target)
sleep 1
DB=$(db_path)
if [ -n "$DB" ] && [ -n "$TASK_ID" ]; then
  TASK_ROW=$(sqlite3 -json "$DB" "SELECT to_name, COALESCE(to_node_id,'') as to_node_id, status FROM tasks WHERE task_id='$TASK_ID' LIMIT 1;" 2>/dev/null)
  LOG "tasks row: $(echo $TASK_ROW | mask | head -c 200)"
  echo "$TASK_ROW" | grep -q '"to_name":"node-b"' && record_check "tasks row to_name=node-b (canonical)" PASS "task routed at new alias" || record_check "tasks row to_name=node-b (canonical)" FAIL "row=$(echo $TASK_ROW | mask | head -c 150)"
fi
# Server response also returns the rejection if alias not found — proven by
# absence of "alias_not_found"
assert_not_contains "no 'alias_not_found' in send_task response" "alias_not_found" "$RESP"

# Cleanup
kill -TERM "$NB_PID" 2>/dev/null
stop_hub

# Emit verdict file
case_verdict 1 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
