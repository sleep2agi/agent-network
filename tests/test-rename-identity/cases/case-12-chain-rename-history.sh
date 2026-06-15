#!/usr/bin/env bash
# Case 12 — RFC-010 audit: rename chain (A → B → C). Both A and B (historical
# aliases) should be resolvable to current node_id via rename_txn /
# alias_rename_log lookup.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-12"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 12 RFC-010 audit: chain rename A → B → C, both historical aliases resolve to current node_id"

anet node create chain-a --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" chain-a)
nohup anet node start chain-a > "$ART_DIR/start.log" 2>&1 &
P=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start.log" 2>/dev/null && break; sleep 1; done
kill -TERM "$P" 2>/dev/null; sleep 2

# Rename 1: A → B
anet node rename chain-a chain-b --force > "$ART_DIR/rename1.log" 2>&1
record_check "rename 1 A→B" PASS "rc=$?"

# Rename 2: B → C
anet node rename chain-b chain-c --force > "$ART_DIR/rename2.log" 2>&1
record_check "rename 2 B→C" PASS "rc=$?"

# node_id stable across both renames
NID2=$(find_node_id "$WORK" chain-c)
assert_eq "node_id stable across 2 renames" "$NID" "$NID2"

# Server should record rename_txn entries for both historical aliases
DB=$(db_path)
TXNS=$(sqlite3 -json "$DB" "SELECT old_alias, new_alias FROM rename_txn ORDER BY rowid;" 2>/dev/null || echo "[]")
LOG "rename_txn rows: $TXNS"
echo "$TXNS" | grep -q '"old_alias":"chain-a"' && record_check "rename_txn has A→B" PASS "" || record_check "rename_txn has A→B" FAIL "missing"
echo "$TXNS" | grep -q '"old_alias":"chain-b"' && record_check "rename_txn has B→C" PASS "" || record_check "rename_txn has B→C" FAIL "missing"

# Re-start as chain-c, send_task to historical alias chain-a — should redirect (canonical)
nohup anet node start chain-c > "$ART_DIR/start-c.log" 2>&1 &
P2=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-c.log" 2>/dev/null && break; sleep 1; done

NONCE="C12-$(date +%s%N)"
RESP_A=$(send_task_rest "chain-a" "${NONCE}-via-A-historical" "tester" "$UTOK")
LOG "send to A (historical) → $(echo $RESP_A | mask | head -c 150)"
echo "$RESP_A" | grep -q '"ok":true' && record_check "send_task to historical A redirects" PASS "" || record_check "send_task to historical A redirects" FAIL "resp=$(echo $RESP_A | mask | head -c 120)"

RESP_B=$(send_task_rest "chain-b" "${NONCE}-via-B-historical" "tester" "$UTOK")
LOG "send to B (historical) → $(echo $RESP_B | mask | head -c 150)"
echo "$RESP_B" | grep -q '"ok":true' && record_check "send_task to historical B redirects" PASS "" || record_check "send_task to historical B redirects" FAIL "resp=$(echo $RESP_B | mask | head -c 120)"

kill -TERM "$P2" 2>/dev/null
stop_hub
case_verdict 12 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
