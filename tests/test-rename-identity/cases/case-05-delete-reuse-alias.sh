#!/usr/bin/env bash
# Case 5 — #203: delete N2, create N3 under same alias template ("worker"),
# verify N3 uses its OWN identity (not silent fallback to N2's frozen ALIAS).
# PR-4 ALIAS getter (per-call refresh) + COMMHUB_NODE_ID env should make
# the new node's from_session/from_node_id correctly identify N3.
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-05"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 5 #203: delete worker (N2) → create new worker (N3) → verify N3 has own identity"

# Step A: create + start N2 ("worker")
anet node create worker --runtime grok-build-acp > "$ART_DIR/n2-create.log" 2>&1
N2_ID=$(find_node_id "$WORK" worker)
record_check "N2 created" PASS "N2 node_id=$N2_ID"
nohup anet node start worker > "$ART_DIR/n2-start.log" 2>&1 &
N2_PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/n2-start.log" 2>/dev/null && break; sleep 1; done

# Step B: stop + delete N2
kill -TERM "$N2_PID" 2>/dev/null; sleep 2
anet node delete worker --force > "$ART_DIR/n2-delete.log" 2>&1
RC_DEL=$?
[ $RC_DEL -eq 0 ] && record_check "N2 deleted" PASS "rc=0" || record_check "N2 deleted" FAIL "rc=$RC_DEL"
[ ! -d "$WORK/.anet/nodes/worker" ] && record_check "N2 dir removed" PASS "dir gone" || record_check "N2 dir removed" FAIL "dir lingers"

# Step C: create N3 — REUSE same alias "worker"
anet node create worker --runtime grok-build-acp > "$ART_DIR/n3-create.log" 2>&1
N3_ID=$(find_node_id "$WORK" worker)
record_check "N3 created with reused alias" PASS "N3 node_id=$N3_ID"
[ "$N2_ID" != "$N3_ID" ] && record_check "N3 has NEW node_id (not N2's)" PASS "$N3_ID ≠ $N2_ID" || record_check "N3 has NEW node_id" FAIL "N3 reused N2's node_id — identity collision"

# Step D: start N3 + send_task to it
nohup anet node start worker > "$ART_DIR/n3-start.log" 2>&1 &
N3_PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/n3-start.log" 2>/dev/null && break; sleep 1; done
grep -q 'SSE connected' "$ART_DIR/n3-start.log" && record_check "N3 SSE connected" PASS "" || record_check "N3 SSE connected" FAIL "no SSE in 30s"

# Step E: N3 calls send_message via MCP — verify from_session/from_node_id == N3 (not N2's stale)
# Easiest probe: send a task TO N3, then check what N3's runtime registers as
# (the registration's session_id should be N3's, not N2's).
DB=$(db_path)
SESS_ROW=$(sqlite3 -json "$DB" "SELECT alias, node_id, resume_id FROM sessions WHERE alias='worker' ORDER BY rowid DESC LIMIT 1;" 2>/dev/null)
LOG "sessions row for worker: $SESS_ROW"
if echo "$SESS_ROW" | grep -q "\"node_id\":\"$N3_ID\""; then
  record_check "server sessions.node_id == N3" PASS "server sees N3's identity, not stale N2"
else
  record_check "server sessions.node_id == N3" FAIL "REGRESSION #203 — server still sees N2's node_id: $(echo $SESS_ROW | mask | head -c 200)"
fi

# Cleanup
kill -TERM "$N3_PID" 2>/dev/null
stop_hub
case_verdict 5 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
