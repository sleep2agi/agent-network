#!/usr/bin/env bash
set -uo pipefail
ROOT=/tmp/test225-stop
PROJECT="$ROOT/project"
mkdir -p "$PROJECT/.anet/nodes/a" "$PROJECT/.anet/nodes/b"
cd "$PROJECT"

write_config() {
  local alias=$1 socket=${2:-}
  python3 - "$alias" "$socket" <<'PY'
import json,os,sys
alias,sock=sys.argv[1:]
p={"node_id":"n_"+alias,"node_name":alias,"alias":alias,"runtime":"grok-build-acp","hub":"http://127.0.0.1:9","token":"ntok_test_"+alias,"channels":[],"env":{},"flags":{}}
if sock: p["grokLeaderSocket"]=sock
path=f".anet/nodes/{alias}/config.json"
with open(path,"w") as f: json.dump(p,f)
PY
}
write_config a
write_config b
FAKE="$ROOT/bin"; mkdir -p "$FAKE"
cat >"$FAKE/agent-node" <<'SH'
#!/bin/sh
trap '' TERM INT
while :; do sleep 1; done
SH
chmod +x "$FAKE/agent-node"
export PATH="$FAKE:$PATH"

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }
alive() { kill -0 "$1" 2>/dev/null; }
wait_dead() { local p=$1; for _ in $(seq 1 100); do alive "$p" || return 0; sleep .1; done; return 1; }

# The historical test225 shape: foreground start in the background, then stop
# immediately. Before #1027 this races before .pid exists, returns 0, and the
# wrapper survives indefinitely.
anet node start a >"$ROOT/a.log" 2>&1 & A=$!
STOP_A=$(anet node stop a 2>&1); RC_A=$?
[ "$RC_A" -eq 0 ] || fail "startup-race stop failed rc=$RC_A: $STOP_A"
wait_dead "$A" || fail "foreground start wrapper survived successful stop (pid=$A)"
pass "test225 foreground startup race converged"

# Concurrent alias ownership: stopping a must not touch b. A stale pidfile
# deliberately points at b to exercise PID-reuse/unrelated-process refusal.
anet node start b >"$ROOT/b.log" 2>&1 & B=$!
sleep .3
echo "$B" >.anet/nodes/a/.pid
anet node stop a >"$ROOT/stale.log" 2>&1 || fail "stale-pid stop failed"
alive "$B" || { cat "$ROOT/b.log"; ps -ef; fail "stale/reused pid killed the concurrent node"; }
pass "stale pid did not kill concurrent node"

# Authoritative socket residue is a typed failure and suppresses false success.
SOCK="$ROOT/leader.sock"
write_config a "$SOCK"
python3 - "$SOCK" <<'PY' &
import socket,sys,time,os
p=sys.argv[1]
try: os.unlink(p)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(); time.sleep(30)
PY
SOCKET_OWNER=$!
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep .05; done
OUT=$(anet node stop a 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "stop succeeded over surviving leader socket"
echo "$OUT" | grep -q 'STOP_TIMEOUT' || fail "missing typed timeout: $OUT"
alive "$SOCKET_OWNER" || fail "stop killed an unowned socket process"
pass "surviving leader socket yields typed failure without collateral kill"
kill "$SOCKET_OWNER" 2>/dev/null || true; wait "$SOCKET_OWNER" 2>/dev/null || true; rm -f "$SOCK"

# Kill escalation and restart: a TERM-resistant agent-node is reaped, then a
# fresh generation can start and stop without affecting b.
anet node start a >"$ROOT/a-resistant.log" 2>&1 & R=$!
sleep .3
anet node stop a >"$ROOT/escalate.log" 2>&1 || fail "kill escalation failed"
wait_dead "$R" || fail "TERM-resistant wrapper survived KILL escalation"
alive "$B" || fail "concurrent b died during a escalation"
pass "kill escalation is bounded and alias-owned"

anet node stop b >"$ROOT/b-stop.log" 2>&1 || fail "final b stop failed"
wait_dead "$B" || fail "b wrapper survived final stop"
echo "Summary: PASS"
