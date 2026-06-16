#!/usr/bin/env bash
# Case 4 — RFC-010 §4.4: rename to an EXISTING alias must reject loud, no
# state mutation.
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-04"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 4 RFC-010 §4.4: rename to existing alias rejection"

# Create two nodes
anet node create node-g --runtime grok-build-acp > "$ART_DIR/create-g.log" 2>&1
anet node create node-h --runtime grok-build-acp > "$ART_DIR/create-h.log" 2>&1
NID_G=$(find_node_id "$WORK" node-g)
NID_H=$(find_node_id "$WORK" node-h)
[ -n "$NID_G" ] && [ -n "$NID_H" ] && record_check "both nodes created" PASS "g=$NID_G, h=$NID_H" || record_check "both nodes created" FAIL "g=$NID_G, h=$NID_H"

# Attempt: rename node-g → node-h (collision)
anet node rename node-g node-h --force > "$ART_DIR/rename-collision.log" 2>&1
RC=$?
LOG "collision rename rc=$RC: $(head -5 $ART_DIR/rename-collision.log | mask | tr '\n' ' ')"

# PASS: non-zero rc + loud error message + no state mutation
[ $RC -ne 0 ] && record_check "rc non-zero" PASS "rc=$RC (rejected)" || record_check "rc non-zero" FAIL "rc=0 (silently overwrote!)"
assert_contains "loud error message" "exists\|already\|conflict\|collision\|taken" "$(cat $ART_DIR/rename-collision.log)"

# State integrity: both dirs still present, IDs unchanged
[ -d "$WORK/.anet/nodes/node-g" ] && record_check "node-g dir intact" PASS "dir exists" || record_check "node-g dir intact" FAIL "node-g dir gone"
[ -d "$WORK/.anet/nodes/node-h" ] && record_check "node-h dir intact" PASS "dir exists" || record_check "node-h dir intact" FAIL "node-h dir gone"
NID_G2=$(find_node_id "$WORK" node-g)
NID_H2=$(find_node_id "$WORK" node-h)
assert_eq "node-g node_id unchanged" "$NID_G" "$NID_G2"
assert_eq "node-h node_id unchanged" "$NID_H" "$NID_H2"

stop_hub
case_verdict 4 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
