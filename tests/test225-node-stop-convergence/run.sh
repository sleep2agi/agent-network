#!/usr/bin/env bash
set -uo pipefail
[[ "${TEST225_STOP_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: TEST225_STOP_SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}
ROOT=/tmp/test225-stop
PROJECT="$ROOT/project"
mkdir -p "$PROJECT/.anet/nodes/a" "$PROJECT/.anet/nodes/b"
cd "$PROJECT"

write_config() {
  local alias=$1 socket=${2:-} attach=${3:-}
  python3 - "$alias" "$socket" "$attach" <<'PY'
import json,os,sys
alias,sock,attach=sys.argv[1:]
p={"node_id":"n_"+alias,"node_name":alias,"alias":alias,"runtime":"grok-build-acp","hub":"http://127.0.0.1:9","token":"ntok_test_"+alias,"channels":[],"env":{},"flags":{}}
if sock: p["grokLeaderSocket"]=sock
if attach: p["grokAttachSocket"]=attach
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
anet node stop a >"$ROOT/socket-retry.log" 2>&1 || fail "stop retry after socket cleanup failed"

ATTACH="$ROOT/attach.sock"
write_config a "" "$ATTACH"
python3 - "$ATTACH" <<'PY' &
import socket,sys,time,os
p=sys.argv[1]
try: os.unlink(p)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(); time.sleep(30)
PY
ATTACH_OWNER=$!
for _ in $(seq 1 50); do [ -S "$ATTACH" ] && break; sleep .05; done
OUT=$(anet node stop a 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "stop succeeded over surviving attach socket"
alive "$ATTACH_OWNER" || fail "stop killed unowned attach socket process"
kill "$ATTACH_OWNER" 2>/dev/null || true; wait "$ATTACH_OWNER" 2>/dev/null || true; rm -f "$ATTACH"
anet node stop a >"$ROOT/attach-retry.log" 2>&1 || fail "stop retry after attach cleanup failed"
write_config a
pass "leader and attach sockets are independently authoritative"

# Lock recovery is identity based: a dead holder may be reclaimed, while a
# corrupt receipt is never guessed away.
mkdir -p .anet/nodes/a/.lifecycle-lock
printf '%s\n' '{"schema":1,"pid":999999,"birth":"dead","operation":"crashed"}' >.anet/nodes/a/.lifecycle-lock/owner.json
anet node stop a >"$ROOT/dead-lock-1.log" 2>&1 & RECLAIM_1=$!
anet node stop a >"$ROOT/dead-lock-2.log" 2>&1 & RECLAIM_2=$!
wait "$RECLAIM_1" || { cat "$ROOT/dead-lock-1.log"; fail "first stale-lock reclaimer failed"; }
wait "$RECLAIM_2" || { cat "$ROOT/dead-lock-2.log"; fail "second stale-lock reclaimer deleted replacement or failed"; }
[ ! -d .anet/nodes/a/.lifecycle-lock ] || fail "public lifecycle lock survived dual reclamation"
mkdir -p .anet/nodes/a/.lifecycle-lock
printf '%s\n' '{corrupt' >.anet/nodes/a/.lifecycle-lock/owner.json
OUT=$(anet node stop a 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "corrupt lifecycle lock was silently stolen"
echo "$OUT" | grep -q NODE_LIFECYCLE_LOCK_CORRUPT || fail "corrupt lock lacked typed failure: $OUT"
rm -rf .anet/nodes/a/.lifecycle-lock
pass "lifecycle lock recovers dead identity and refuses corrupt receipt"

# Deterministic exit-window fixture: a zombie still answers kill(0), but one
# /proc stat snapshot identifies it as already gone. The parent must remain
# untouched and stop must not misreport birth-unavailable.
python3 - "$ROOT/zombie.pid" <<'PY' &
import os,sys,time
pid=os.fork()
if pid == 0: os._exit(0)
open(sys.argv[1],'w').write(str(pid))
time.sleep(20)
PY
ZOMBIE_PARENT=$!
for _ in $(seq 1 50); do [ -s "$ROOT/zombie.pid" ] && break; sleep .02; done
ZOMBIE=$(cat "$ROOT/zombie.pid")
ZBIRTH=$(awk '{print $22}' "/proc/$ZOMBIE/stat")
python3 - "$ZOMBIE" "$ZBIRTH" <<'PY'
import json,sys
p='.anet/nodes/a/.lifecycle-owner.json'
with open(p) as f: r=json.load(f)
r.update(state='starting',generation='zombie-exit-window',processes=[{'pid':int(sys.argv[1]),'birth':sys.argv[2],'role':'agent'}])
with open(p,'w') as f: json.dump(r,f)
PY
anet node stop a >"$ROOT/zombie-stop.log" 2>&1 || { cat "$ROOT/zombie-stop.log"; fail "atomic exit-window audit rejected an already-dead process"; }
alive "$ZOMBIE_PARENT" || fail "zombie fixture parent was collateral damage"
kill "$ZOMBIE_PARENT" 2>/dev/null || true; wait "$ZOMBIE_PARENT" 2>/dev/null || true
pass "single /proc snapshot treats exited process as gone without unverifiable race"

# Kill escalation and restart: a TERM-resistant agent-node is reaped, then a
# fresh generation can start and stop without affecting b.
anet node start a >"$ROOT/a-resistant.log" 2>&1 & R=$!
sleep .3
anet node stop a >"$ROOT/escalate.log" 2>&1 || fail "kill escalation failed"
wait_dead "$R" || fail "TERM-resistant wrapper survived KILL escalation"
alive "$B" || fail "concurrent b died during a escalation"
pass "kill escalation is bounded and alias-owned"

# Freeze the generation at stop intent. TERM resistance holds stop open long
# enough for a newer same-alias start to race; it must be rejected, while a
# fresh generation after completion must survive normally.
anet node start a >"$ROOT/a-old.log" 2>&1 & OLD=$!
sleep .3
alive "$OLD" || { cat "$ROOT/a-old.log"; fail "old generation did not start"; }
anet node stop a >"$ROOT/a-old-stop.log" 2>&1 & STOPPER=$!
for _ in $(seq 1 100); do grep -Eq '"state"[[:space:]]*:[[:space:]]*"stopping"' .anet/nodes/a/.lifecycle-owner.json 2>/dev/null && break; sleep .05; done
alive "$STOPPER" || { cat "$ROOT/a-old-stop.log"; fail "stop completed before late-start fault injection"; }
OUT=$(anet node start a 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "late newer start was admitted during stop intent"
echo "$OUT" | grep -q NODE_START_CANCELLED_BY_CONCURRENT_STOP || fail "late start lacked typed refusal: $OUT"
wait "$STOPPER" || { cat "$ROOT/a-old-stop.log"; fail "old generation stop failed"; }
wait_dead "$OLD" || fail "old generation survived"
anet node start a >"$ROOT/a-new.log" 2>&1 & NEW=$!
NEW_READY=0
for _ in $(seq 1 200); do
  if python3 - "$NEW" <<'PY' 2>/dev/null
import json,sys
r=json.load(open('.anet/nodes/a/.lifecycle-owner.json'))
assert r.get('wrapperPid') == int(sys.argv[1])
assert any(p.get('role') == 'agent' and p.get('birth') for p in r.get('processes', []))
PY
  then NEW_READY=1; break; fi
  sleep .05
done
[ "$NEW_READY" -eq 1 ] || { cat "$ROOT/a-new.log"; fail "new generation owner receipt did not reach agent-owned state"; }
alive "$NEW" || { cat "$ROOT/a-new.log"; fail "new generation after completed stop did not start"; }
pass "stop intent rejects late start and releases alias only after completion"

# Receipt identities are fail-closed. A missing birth refuses to signal; a
# mismatched birth proves PID reuse and leaves that unrelated process alone.
python3 - "$B" <<'PY'
import json,sys
p='.anet/nodes/a/.lifecycle-owner.json'; pid=int(sys.argv[1])
with open(p) as f: r=json.load(f)
r.update(state='starting',generation='fault-null',processes=[{'pid':pid,'role':'agent'}])
with open(p,'w') as f: json.dump(r,f)
PY
OUT=$(anet node stop a 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "missing receipt birth authorized stop"
alive "$B" || fail "missing birth killed unrelated pid"
python3 - "$B" <<'PY'
import json,sys
p='.anet/nodes/a/.lifecycle-owner.json'; pid=int(sys.argv[1])
with open(p) as f: r=json.load(f)
r.update(state='starting',generation='fault-reuse',processes=[{'pid':pid,'birth':'definitely-not-current','role':'agent'}])
with open(p,'w') as f: json.dump(r,f)
PY
anet node stop a >"$ROOT/reuse.log" 2>&1 || fail "PID-reuse receipt did not converge as original generation gone"
alive "$B" || fail "PID-reused unrelated process was killed"
pass "birth unavailable fails closed and PID reuse is never signalled"

# Ordinary RFC-030 ownership still includes all three tmux resources.
for session in a a-appsrv a-桥; do tmux new-session -d -s "$session" 'sleep 30'; done
anet node stop a >"$ROOT/tmux3.log" 2>&1 || fail "three-session teardown failed"
for session in a a-appsrv a-桥; do tmux has-session -t "=$session" 2>/dev/null && fail "tmux session survived: $session"; done
pass "all three tmux resources are audited"

# Portable boundaries: Windows uses CreationDate as its birth identity (the
# native execution remains test751's responsibility), and stop has no PM2
# name-based kill authority.
grep -q 'process.platform === "win32") return probeWindowsCreationDate(pid)' /app/agent-network/bin/cli.ts \
  || fail "Windows lifecycle birth is not CreationDate-backed"
if sed -n '/async function stopCommand()/,/^\/\/ ── project/p' /app/agent-network/bin/cli.ts | grep -Eqi 'pm2 (delete|kill|stop)'; then
  fail "node stop gained PM2 name-based kill authority"
fi
pass "Windows uses creation identity and PM2 remains outside alias kill authority"

# Restore and stop the real new generation; the fault receipts above must not
# have allowed any old stop to dynamically adopt it.
alive "$NEW" || fail "new generation was killed by an old/fault stop"
python3 - "$NEW" <<'PY'
import json,sys
p='.anet/nodes/a/.lifecycle-owner.json'; pid=int(sys.argv[1])
birth=open(f'/proc/{pid}/stat').read().split()[21]
with open(p) as f: r=json.load(f)
r.update(state='starting',generation='restored-new',wrapperPid=pid,wrapperBirth=birth,processes=[{'pid':pid,'birth':birth,'role':'wrapper'}])
with open(p,'w') as f: json.dump(r,f)
PY
anet node stop a >"$ROOT/a-new-stop.log" 2>&1 || fail "restored new generation stop failed"
wait_dead "$NEW" || fail "new generation survived its own stop"

# #1193 compatibility: the restart verb must pass through the same admission
# and produce a generation that an ordinary stop can converge.
anet node restart a >"$ROOT/restart.log" 2>&1 & RESTARTER=$!
for _ in $(seq 1 100); do grep -Eq '"role"[[:space:]]*:[[:space:]]*"agent"' .anet/nodes/a/.lifecycle-owner.json 2>/dev/null && break; sleep .05; done
alive "$RESTARTER" || { cat "$ROOT/restart.log"; fail "restart did not launch a live generation"; }
anet node stop a >"$ROOT/restart-stop.log" 2>&1 || fail "stop after restart failed"
wait_dead "$RESTARTER" || fail "restart wrapper survived stop"
pass "#1193 restart shares generation ownership and converges"

anet node stop b >"$ROOT/b-stop.log" 2>&1 || fail "final b stop failed"
wait_dead "$B" || fail "b wrapper survived final stop"
echo "Summary: PASS"
