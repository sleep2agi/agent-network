#!/usr/bin/env bash
set -euo pipefail

MODE=${TEST231_MODE:-green}
case "$MODE" in
  red|green) ;;
  *) echo "FAIL: TEST231_MODE must be red or green" >&2; exit 2 ;;
esac

REAL_GROK=${TEST231_REAL_GROK_BIN:-/host-grok/grok-0.2.93}
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test231-grok-socket-sandbox-${MODE}.txt"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
chmod 600 "$REPORT"
chown 1000:1000 "$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

log "# test231 — Grok socket allocator versus real workspace sandbox"
log "date=$(date -Is)"
log "mode=$MODE"
log "grok_binary_sha256=$(sha256sum "$REAL_GROK" | awk '{print $1}')"
[[ "$($REAL_GROK --version)" =~ ^grok\ 0\.2\.93\ \(f00f96316d\) ]] \
  || fail "real binary is not pinned Grok 0.2.93"

mkdir -p /workspace/project /home/tester/.grok /run/user/1000/g
chown -R 1000:1000 /workspace/project /home/tester /run/user/1000
chmod 700 /workspace/project /home/tester /home/tester/.grok /run/user/1000 /run/user/1000/g

# This is the isolated GROK_HOME used by the real co-presence runtime. The
# red allocator puts its socket outside this sandbox-admitted state home; the
# green allocator puts it below stateHome/run.
STATE_KEY=$(node -e 'const {createHash}=require("crypto"); process.stdout.write(`node-${createHash("sha256").update("n_test231").digest("hex").slice(0,24)}`)')
STATE_HOME="/home/tester/.anet-grok/$STATE_KEY"
mkdir -p "$STATE_HOME"
chown -R 1000:1000 /home/tester/.anet-grok
chmod 700 /home/tester/.anet-grok "$STATE_HOME"

set +e
bun test /workspace/agent-network/src/grok-copresence-profile.test.ts \
  >/tmp/test231-unit.log 2>&1
UNIT_RC=$?
set -e
cat /tmp/test231-unit.log >>"$REPORT"
if [ "$MODE" = red ]; then
  [ "$UNIT_RC" -ne 0 ] || fail "new state-home allocator contract did not turn red on old production"
  grep -Fq '/home/preview/.anet-grok/node-' /tmp/test231-unit.log \
    || fail "unit red did not identify the state-home contract"
  pass "new allocator contract rejects the old XDG-first implementation"
else
  [ "$UNIT_RC" -eq 0 ] || fail "state-home allocator unit tests failed"
  pass "state-home allocator unit tests"
fi

bun /test231/socket-path.ts >/tmp/test231-paths.json
LEADER_SOCKET=$(node -e 'process.stdout.write(require("/tmp/test231-paths.json").leaderSocket)')
ATTACH_SOCKET=$(node -e 'process.stdout.write(require("/tmp/test231-paths.json").attachSocket)')
log "leader_socket=$LEADER_SOCKET"
log "attach_socket=$ATTACH_SOCKET"

RUNTIME_DIR=$(dirname "$LEADER_SOCKET")
mkdir -p "$RUNTIME_DIR"
chown -R 1000:1000 "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

SESSION_ID=23123123-1231-4231-8231-231231231231
COMMAND=(
  setpriv --reuid=1000 --regid=1000 --clear-groups
  env -i
  HOME=/home/tester GROK_HOME="$STATE_HOME"
  PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8
  XDG_RUNTIME_DIR=/run/user/1000
  "$REAL_GROK"
  --leader --leader-socket "$LEADER_SOCKET"
  --cwd /workspace/project --session-id "$SESSION_ID"
  --permission-mode bypassPermissions --always-approve --sandbox workspace
  --no-auto-update --disable-web-search --no-subagents --no-memory
  --deny Bash --deny Write --deny WebFetch
)

set +e
python3 /test231/pty-run.py \
  --timeout 8 --output /tmp/test231-combined.log --watch-socket "$LEADER_SOCKET" \
  -- "${COMMAND[@]}"
GROK_RC=$?
set -e
cat /tmp/test231-combined.log >>"$REPORT"

if [ "$MODE" = red ]; then
  [[ "$LEADER_SOCKET" == /run/user/1000/g/* ]] \
    || fail "red allocator did not select the safe-looking XDG directory"
  [ "$GROK_RC" -ne 0 ] || fail "XDG socket unexpectedly started Grok"
  grep -Fq 'Lock error: IO error: Permission denied' /tmp/test231-combined.log \
    || fail "red side did not produce the specific sandbox/socket Lock error"
  grep -Fq 'TEST231_SOCKET_SEEN=0' /tmp/test231-combined.log \
    || fail "red side unexpectedly created a leader socket"
  pass "real Grok workspace sandbox rejects XDG socket with the exact Lock error"
else
  [[ "$LEADER_SOCKET" =~ ^/home/tester/\.anet-grok/node-[0-9a-f]{24}/run/leader\.sock$ ]] \
    || fail "green allocator did not select the owner-bound state home"
  [ "$GROK_RC" -eq 124 ] || fail "state-home Grok did not remain live through the bounded probe"
  ! grep -Fq 'Lock error:' /tmp/test231-combined.log \
    || fail "state-home socket still produced a Lock error"
  grep -Fq 'TEST231_SOCKET_SEEN=1' /tmp/test231-combined.log \
    || fail "state-home probe did not create the real leader socket"
  pass "real Grok workspace sandbox starts with the owner-bound state-home socket"
fi

log "Summary: PASS (mode=$MODE; Docker-only; real pinned Grok + workspace sandbox)"
