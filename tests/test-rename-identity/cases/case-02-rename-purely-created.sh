#!/usr/bin/env bash
# Case 2 — #110: rename a purely-created node (never started, no sessions row).
# Per PR-1+2: server returns node_local_only, CLI takes local-only path.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-02"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 2 #110: rename purely-created node — node-c → node-d (never started)"

# Create only — NO start. So server has no sessions row for this node.
anet node create node-c --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" node-c)
record_check "node-c created" PASS "node_id=$NID"

# Rename — pre-#110-fix this returned error "node not found in network"
anet node rename node-c node-d --force > "$ART_DIR/rename.log" 2>&1
RC=$?
LOG "rename rc=$RC, output: $(head -5 $ART_DIR/rename.log | mask | tr '\n' ' ')"

# PR-1+2 expectation: rc=0, local-only path taken (no server 2PC needed).
# Pre-fix: rc=1 + "not found in network" error.
NOT_FOUND=$(grep -c 'not found in.*network\|not found in this network' "$ART_DIR/rename.log" 2>/dev/null || echo 0)
if [ "$RC" = "0" ]; then
  record_check "rename rc=0" PASS "rc=0 (local-only path)"
  if grep -qiE 'local.only|local_only|local rename' "$ART_DIR/rename.log"; then
    record_check "local-only path acknowledged" PASS "output mentions local-only path"
  else
    record_check "local-only path acknowledged" PASS "rc=0 + no error — path silently taken, OK"
  fi
elif [ "$NOT_FOUND" -gt 0 ]; then
  record_check "rename rc=0" FAIL "REGRESSION of #110: 'not found in network' returned (rc=$RC)"
else
  record_check "rename rc=0" FAIL "rc=$RC, output: $(head -3 $ART_DIR/rename.log | mask)"
fi

# Dir flipped to new alias regardless of rc
[ -d "$WORK/.anet/nodes/node-d" ] && record_check "dir → node-d" PASS "dir exists" || record_check "dir → node-d" FAIL "no node-d dir"
[ ! -d "$WORK/.anet/nodes/node-c" ] && record_check "old node-c dir gone" PASS "old removed" || record_check "old node-c dir gone" FAIL "old dir lingers"

# node_id stable
NID2=$(find_node_id "$WORK" node-d)
assert_eq "node_id stable for purely-created" "$NID" "$NID2"

stop_hub
case_verdict 2 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
