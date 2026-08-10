#!/usr/bin/env bash
set -uo pipefail

REPO="${REPO:-/app}"
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO/tests/lib/safe-rm.sh"

WORK="${WORK:-/tmp/test466}"
export HOME="$WORK/home"
export OPENAI_API_KEY="test466-not-a-real-secret"
export TEST466_SPAWN_DETACHED=1
export TEST466_ORPHAN_PID_FILE="$WORK/orphan.pid"
HUB_PORT="${HUB_PORT:-9466}"
HUB="http://127.0.0.1:$HUB_PORT"
ALIAS="test466-codex"
NODE_DIR="$WORK/project/.anet/nodes/$ALIAS"
MARKER="$NODE_DIR/copresence-identity.json"
CODEX_WRAPPER="$TEST_DIR/codex-marker-wrapper"
LOG="$WORK/run.log"
HUB_LOG="$WORK/hub.log"

PASS=0; FAIL=0; HUB_PID=""
ok() { echo "  PASS $*"; PASS=$((PASS+1)); }
bad() { echo "  FAIL $*"; FAIL=$((FAIL+1)); }
section() { printf '\n=== %s ===\n' "$*"; }

stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}

cleanup() {
  tmux kill-server 2>/dev/null || true
  stop_group "$HUB_PID"
  [[ -n "$HUB_PID" ]] && wait "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

safe_rm_rf "$WORK"
mkdir -p "$HOME" "$WORK/project" "$NODE_DIR"
tmux kill-server 2>/dev/null || true

echo "source_commit=${TEST466_SOURCE_COMMIT:-unknown}"
echo "codex_version=$(codex --version 2>&1 | head -1)"

section "0. real isolated Hub + node credential"
(cd "$REPO/server" && exec setsid env PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$HUB_LOG" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$HUB/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$HUB/health" >/dev/null 2>&1 && ok "real Hub healthy" || { bad "Hub failed"; exit 1; }
REG=$(curl -fsS -X POST "$HUB/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"test466admin","password":"test466_Strong_123!","email":"t466@example.test"}')
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(curl -fsS "$HUB/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
NTOK=$(curl -fsS -X POST "$HUB/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\"}" | jq -r '.token')
[[ "$NTOK" == ntok_* ]] && ok "network-scoped node token minted" || { bad "node token missing"; exit 1; }

cat >"$NODE_DIR/config.json" <<JSON
{"node_name":"$ALIAS","runtime":"codex-app-server","model":"gpt-5.5","hub":"$HUB","token":"$NTOK","network_id":"$NET","flags":{}}
JSON
chmod 600 "$NODE_DIR/config.json"

session_alive() { tmux has-session -t "=$1" 2>/dev/null; }
marker_pids() {
  local uuid="$1" p
  for p in /proc/[0-9]*; do
    tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -Fxq "ANET_NODE_MARKER=$uuid" && basename "$p"
  done
}

start_triplet() {
  rm -f "$TEST466_ORPHAN_PID_FILE" "$LOG"
  (cd "$WORK/project" && timeout 75 anet node start "$ALIAS" --copresence \
    --codex-bin "$CODEX_WRAPPER" --codex-home "$NODE_DIR/codex-home" --port 29466 \
    >"$LOG" 2>&1)
  local rc=$?
  [[ "$rc" -eq 0 ]] || { echo "start rc=$rc"; tail -80 "$LOG"; return 1; }
  for s in "$ALIAS" "$ALIAS-appsrv" "$ALIAS-桥"; do session_alive "$s" || return 1; done
  [[ -s "$MARKER" ]] || return 1
  [[ -s "$TEST466_ORPHAN_PID_FILE" ]] || return 1
}

stop_external() {
  (cd "$WORK/project" && anet node stop "$ALIAS" >>"$LOG" 2>&1)
}

assert_real_generation_gone() {
  local uuid="$1" label="$2" left
  left=$(marker_pids "$uuid" | tr '\n' ' ')
  [[ -z "$left" ]] && ok "$label: marker PID scan is zero" || bad "$label: marker PIDs survived: $left"
  [[ ! -e "$MARKER" ]] && ok "$label: marker file removed" || bad "$label: marker file remains"
  for s in "$ALIAS" "$ALIAS-appsrv" "$ALIAS-桥"; do
    if session_alive "$s"; then bad "$label: tmux session survived: $s"; else ok "$label: tmux absent: $s"; fi
  done
}

section "1. normal stop — real Codex app-server + bridge + TUI"
if start_triplet; then
  ok "real three-piece co-presence started"
else
  bad "real three-piece co-presence did not start"; exit 1
fi
UUID=$(jq -r '.marker' "$MARKER")
ORPHAN=$(cat "$TEST466_ORPHAN_PID_FILE")
kill -0 "$ORPHAN" 2>/dev/null && ok "detached marker descendant is genuinely alive" || bad "detached fixture absent"
if stop_external; then ok "normal external stop returned success"; else bad "normal external stop failed"; fi
assert_real_generation_gone "$UUID" "normal stop"
kill -0 "$ORPHAN" 2>/dev/null && bad "normal stop left detached descendant" || ok "normal stop reaped detached descendant"

section "2. lost app-server + hostile same-name replacement"
start_triplet || { bad "same-name setup failed"; exit 1; }
UUID=$(jq -r '.marker' "$MARKER")
tmux kill-session -t "=$ALIAS-appsrv"
for _ in $(seq 1 30); do ! session_alive "$ALIAS-appsrv" && break; sleep 0.1; done
FAKE_PID_FILE="$WORK/fake.pid"
tmux new-session -d -s "$ALIAS-appsrv" -e ANET_NODE_MARKER=not-the-real-marker \
  bash -c "echo \$\$ > '$FAKE_PID_FILE'; exec sleep 600"
for _ in $(seq 1 30); do [[ -s "$FAKE_PID_FILE" ]] && break; sleep 0.1; done
FAKE_PID=$(cat "$FAKE_PID_FILE")
kill -0 "$FAKE_PID" 2>/dev/null && ok "hostile same-name session is alive before stop" || bad "hostile fixture absent"
if stop_external; then ok "identity stop completed with same-name impostor present"; else bad "identity stop failed"; fi
REAL_LEFT=$(marker_pids "$UUID" | tr '\n' ' ')
[[ -z "$REAL_LEFT" ]] && ok "real marker generation was reaped" || bad "real marker PIDs survived: $REAL_LEFT"
kill -0 "$FAKE_PID" 2>/dev/null && ok "different-marker same-name process was NOT killed" || bad "different-marker process was killed by name"
session_alive "$ALIAS-appsrv" && ok "different-marker same-name tmux was NOT killed" || bad "different-marker tmux was killed by name"
[[ ! -e "$MARKER" ]] && ok "real generation marker removed" || bad "real marker remains"
tmux kill-session -t "=$ALIAS-appsrv" 2>/dev/null || true

section "3. bridge SIGKILL then exact identity stop"
start_triplet || { bad "bridge-kill setup failed"; exit 1; }
UUID=$(jq -r '.marker' "$MARKER")
BRIDGE_PANE=$(tmux display-message -p -t "=$ALIAS-桥" '#{pane_pid}')
kill -KILL "$BRIDGE_PANE"
for _ in $(seq 1 30); do ! session_alive "$ALIAS-桥" && break; sleep 0.1; done
if stop_external; then ok "stop succeeds after bridge SIGKILL"; else bad "stop failed after bridge SIGKILL"; fi
assert_real_generation_gone "$UUID" "bridge SIGKILL"

section "4. stop from inside marker-bearing TUI ancestry is refused"
start_triplet || { bad "self-stop setup failed"; exit 1; }
UUID=$(jq -r '.marker' "$MARKER")
SELF_RC="$WORK/self-stop.rc"; SELF_LOG="$WORK/self-stop.log"
tmux new-window -d -t "=$ALIAS" -n selfstop \
  "cd '$WORK/project'; anet node stop '$ALIAS' >'$SELF_LOG' 2>&1; echo \$? >'$SELF_RC'; exec sleep 600"
for _ in $(seq 1 80); do [[ -s "$SELF_RC" ]] && break; sleep 0.1; done
RC=$(cat "$SELF_RC" 2>/dev/null || echo missing)
[[ "$RC" == "2" ]] && ok "inside-tree stop returns exact refusal rc=2" || bad "inside-tree stop rc=$RC"
grep -q 'would kill your own shell' "$SELF_LOG" && ok "self-kill refusal is explicit" || bad "self-kill refusal message missing"
[[ -e "$MARKER" ]] && ok "self-kill refusal preserves marker" || bad "self-kill refusal removed marker"
session_alive "$ALIAS-appsrv" && ok "self-kill refusal leaves real app-server alive" || bad "self-kill refusal killed app-server"
stop_external || bad "external cleanup after self-stop failed"
assert_real_generation_gone "$UUID" "post self-refusal external stop"

section "5. corrupt marker fails closed without a name kill"
printf '{not-json\n' >"$MARKER"
chmod 600 "$MARKER"
tmux new-session -d -s "$ALIAS-appsrv" -e ANET_NODE_MARKER=foreign-corrupt-case bash -c 'exec sleep 600'
(cd "$WORK/project" && anet node stop "$ALIAS" >"$WORK/corrupt.log" 2>&1)
RC=$?
[[ "$RC" -ne 0 ]] && ok "corrupt marker returns non-zero" || bad "corrupt marker returned success"
[[ -e "$MARKER" ]] && ok "corrupt marker is preserved" || bad "corrupt marker was removed"
session_alive "$ALIAS-appsrv" && ok "corrupt marker did not authorize same-name kill" || bad "corrupt marker fell through to name kill"
tmux kill-session -t "=$ALIAS-appsrv" 2>/dev/null || true
rm -f "$MARKER"

section "6. incomplete identity proof fails closed without a name kill"
INCOMPLETE_PID_FILE="$WORK/incomplete.pid"
setsid env ANET_NODE_MARKER=incomplete-real \
  bash -c 'echo $$ > "$1"; env -u ANET_NODE_MARKER sleep 600 & wait' _ "$INCOMPLETE_PID_FILE" &
INCOMPLETE_LAUNCH=$!
for _ in $(seq 1 30); do [[ -s "$INCOMPLETE_PID_FILE" ]] && break; sleep 0.1; done
INCOMPLETE_PID=$(cat "$INCOMPLETE_PID_FILE")
BOOT=$(cat /proc/sys/kernel/random/boot_id)
cat >"$MARKER" <<JSON
{"marker":"incomplete-real","boot_id":"$BOOT","started_at_epoch_ms":$(date +%s000),"owner_uid":$(id -u),"sessions":{}}
JSON
chmod 600 "$MARKER"
tmux new-session -d -s "$ALIAS-appsrv" -e ANET_NODE_MARKER=foreign-incomplete-case bash -c 'exec sleep 600'
(cd "$WORK/project" && anet node stop "$ALIAS" >"$WORK/incomplete.log" 2>&1)
RC=$?
[[ "$RC" -ne 0 ]] && ok "incomplete identity proof returns non-zero" || bad "incomplete identity proof returned success"
[[ -e "$MARKER" ]] && ok "incomplete identity marker is preserved" || bad "incomplete marker was removed"
kill -0 "$INCOMPLETE_PID" 2>/dev/null && ok "mixed marker pgroup was not partially killed" || bad "incomplete identity killed its mixed group"
session_alive "$ALIAS-appsrv" && ok "incomplete identity did not authorize same-name kill" || bad "incomplete identity fell through to name kill"
tmux kill-session -t "=$ALIAS-appsrv" 2>/dev/null || true
kill -TERM -- "-$INCOMPLETE_PID" 2>/dev/null || true
wait "$INCOMPLETE_LAUNCH" 2>/dev/null || true
rm -f "$MARKER"

section "7. ordinary marker-missing node retains legacy stop"
ORD="test466-ordinary"
mkdir -p "$WORK/project/.anet/nodes/$ORD"
cat >"$WORK/project/.anet/nodes/$ORD/config.json" <<JSON
{"node_name":"$ORD","runtime":"claude-code-cli","hub":"$HUB","token":"$NTOK"}
JSON
tmux new-session -d -s "$ORD" bash -c 'exec sleep 600'
if (cd "$WORK/project" && anet node stop "$ORD" >>"$LOG" 2>&1); then ok "ordinary legacy stop returned success"; else bad "ordinary legacy stop failed"; fi
session_alive "$ORD" && bad "ordinary marker-missing tmux survived" || ok "ordinary marker-missing tmux still uses legacy cleanup"

section "8. non-vacuous identity mutations"
if "$TEST_DIR/mutations.sh"; then
  ok "four identity/name/rescan/fail-closed mutations turn red"
else
  bad "one or more identity mutations failed to turn red"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
