#!/usr/bin/env bash
# #602 —— Codex TUI 共存节点:手工 `anet node stop` 之后 `anet node start` 能不能再起来。
#
# 线程从没有过一次对话时,TUI 开的线程只是个「待定」候选:桥把它写进 config 的
# codexPendingThread,并绑定在当代的身份标记(ANET_NODE_MARKER)上。`anet node stop`
# 按标记收掉整代、删掉标记文件 —— 而 codexPendingThread 仍指向那个刚被删掉的标记,
# 下一次 `anet node start` 便 fail-closed:
#   "pending Codex thread is not bound to the exact private previous-generation marker"
#
# 本套件量的(全部用真 codex 0.147.0 + 容器内私有 tmux socket):
#   0  隔离 hub(非 9200),admin utok → node token,直接写共存节点 config(codexCopresence:true,
#      daemon 写的形状)
#   A  从没对话过的节点:start → (等桥写下 codexPendingThread)→ stop → start 必须成功:
#      三段 tmux + 新标记都在,旧候选被丢弃(它在 CODEX_HOME 里没有 rollout),新一代绑新候选;
#      再来一轮 stop → start 也要成功
#   C  有过一次对话的节点(在 TUI 里提交一条消息,桥把线程提升为 codexThreadId):
#      stop → start 恢复同一个线程(修之前就能;对照)
#   D  安全面不放松:
#      D1 候选绑的是一个**不是本节点留下的**标记、而且它的线程**有** rollout → 仍 fail-closed、
#         不起任何会话(标记没了就证明不了归属,有 rollout 的线程绝不收养)
#      D2 同样的伪标记、线程没有 rollout → 丢弃并起新线程,那个线程 id 不被收养
#
# 全程在容器里:HOME=$(mktemp -d),hub 在 9602,tmux 走 ANET_TMUX_SOCKET 私有 socket。
set -uo pipefail
# Exercise Codex behavior, not host resource admission (covered by test612).
# Shared CI runner load/memory must not delay the fixture's app-server startup.
export ANET_START_MEM_GATE=0

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite starts tmux servers and kills pids; run it in its container." >&2
  exit 2
fi
echo "source_commit=${CCSS_SOURCE_COMMIT:-unknown}"

HUB_PORT=9602
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/ccss-XXXXXX.db)
export HOME=$(mktemp -d /tmp/ccss-home-XXXXXX)
export ANET_TMUX_SOCKET="$HOME/tmux-602.sock"
WORK="$HOME/proj"
mkdir -p "$WORK"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
tm()   { tmux -S "$ANET_TMUX_SOCKET" "$@"; }

session_alive() { tm has-session -t "=$1" 2>/dev/null; }
marker_pids() {
  local uuid="$1" p
  for p in /proc/[0-9]*; do
    tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -Fxq "ANET_NODE_MARKER=$uuid" && basename "$p"
  done
}

cleanup() {
  tm kill-server 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  [[ -n "${PAIR_REG_PID:-}" ]] && kill "$PAIR_REG_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

note "0. isolated hub :$HUB_PORT (HOME=$HOME, tmux socket $ANET_TMUX_SOCKET)"
echo "    $(codex --version 2>/dev/null | tail -1) / tmux $(tmux -V | cut -d' ' -f2) / anet $(anet --version 2>/dev/null | tail -1)"
PAIR_REG_PORT=9603
python3 /app/tests/qa-create-node-codex-copresence/paired-registry.py \
  "$(ls /app/agent-node/sleep2agi-agent-node-*.tgz)" "$PAIR_REG_PORT" >/tmp/pair-registry.log 2>&1 &
PAIR_REG_PID=$!
printf '@sleep2agi:registry=http://127.0.0.1:%s/\n' "$PAIR_REG_PORT" > "$HOME/.npmrc"
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PAIR_REG_PORT/@sleep2agi%2fagent-node" >/dev/null 2>&1 && break; sleep 0.25; done
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-602.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-602.log; exit 1; }
REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"ccssadmin","password":"ccss_TestPass_1234!","email":"ccss@test.local"}')
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
mkdir -p "$HOME/.anet" "$HOME/.codex"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
# A host codex login for the launcher to stage into each node's CODEX_HOME. Fake key; the
# container has no route to use it (`docker run --network none`).
printf '{"OPENAI_API_KEY":"sk-ccss-not-a-real-key"}\n' > "$HOME/.codex/auth.json"; chmod 600 "$HOME/.codex/auth.json"
# This suite verifies stop/start and thread continuity, not Codex's updater.
# Its deliberately old, pinned real binary must not open an update-choice TUI
# when the registry has moved on while CI is running.
printf 'check_for_update_on_startup = false\n' > "$HOME/.codex/config.toml"; chmod 600 "$HOME/.codex/config.toml"

# make_node ALIAS — a co-presence node config the way the daemon writes one (codexCopresence:true)
make_node() {
  local alias="$1" dir="$WORK/.anet/nodes/$1" ntok
  ntok=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$alias\"}" | jq -r '.token')
  [[ "$ntok" == ntok_* ]] || { bad "$alias: node token mint failed"; return 1; }
  mkdir -p "$dir"
  jq -n --arg a "$alias" --arg h "$HUB_BASE" --arg t "$ntok" --arg n "$NET_ID" \
    '{node_name:$a,runtime:"codex-app-server",model:"gpt-5.5",hub:$h,token:$t,network_id:$n,flags:{permissionMode:"default"},codexCopresence:true}' \
    > "$dir/config.json"
  chmod 600 "$dir/config.json"
}
cfg()    { jq -c "${2:-.}" "$WORK/.anet/nodes/$1/config.json" 2>/dev/null; }
marker() { jq -r '.marker // empty' "$WORK/.anet/nodes/$1/copresence-identity.json" 2>/dev/null; }

# start_node ALIAS LABEL → rc in START_RC, output in /tmp/start-<alias>-<label>.log
start_node() {
  local log="/tmp/start-$1-$2.log"
  (cd "$WORK" && timeout 150 anet node start "$1" </dev/null >"$log" 2>&1); START_RC=$?
  echo "    start($2) rc=$START_RC; last lines:"; tail -4 "$log" | sed 's/^/      /'
}
stop_node() {
  local log="/tmp/stop-$1-$2.log"
  (cd "$WORK" && timeout 60 anet node stop "$1" </dev/null >"$log" 2>&1); STOP_RC=$?
  echo "    stop($2) rc=$STOP_RC; last lines:"; tail -3 "$log" | sed 's/^/      /'
}
triplet_up() {
  local a="$1" s
  for s in "$a" "$a-appsrv" "$a-桥"; do session_alive "$s" || return 1; done
  [[ -n "$(marker "$a")" ]]
}
wait_field() {   # alias jq-path seconds → waits until non-null
  local i
  for i in $(seq 1 "$3"); do
    [[ "$(cfg "$1" "$2")" != null && -n "$(cfg "$1" "$2")" ]] && return 0
    sleep 1
  done
  return 1
}
generation_gone() {
  local uuid="$1" i left
  for i in $(seq 1 20); do
    left=$(marker_pids "$uuid" | tr '\n' ' ')
    [[ -z "${left// /}" ]] && return 0
    sleep 0.5
  done
  echo "    survivors of ${uuid:0:8}: $left"
  return 1
}

# ── A. never-used thread: start → pending bound → stop → start ─────────
note "A. never-used thread: start → (pending candidate bound) → stop → start"
A=cx-idle
make_node "$A" || exit 1
start_node "$A" first
[[ "$START_RC" == 0 ]] && triplet_up "$A" && ok "A: first start brought up the triplet" || { bad "A: first start failed"; cat "/tmp/start-$A-first.log"; exit 1; }
A_M1=$(marker "$A")
if wait_field "$A" .codexPendingThread 40; then
  ok "A: bridge bound the TUI's thread as a pending candidate: $(cfg "$A" '.codexPendingThread|{threadId,marker:(.marker[0:8])}')"
else
  bad "A: no codexPendingThread after 40 s: $(cfg "$A" 'del(.token)')"
fi
[[ "$(cfg "$A" '.codexPendingThread.marker' | tr -d '"')" == "$A_M1" ]] && ok "A: the pending candidate is bound to this generation's marker" \
  || bad "A: pending marker ≠ live marker"
[[ "$(cfg "$A" .codexThreadId)" == null ]] && ok "A: no codexThreadId (the thread never had a conversation)" || bad "A: codexThreadId unexpectedly set"
stop_node "$A" 1
[[ "$STOP_RC" == 0 ]] && ok "A: stop rc=0" || bad "A: stop rc=$STOP_RC"
generation_gone "$A_M1" && ok "A: no process carries the stopped generation's marker" || bad "A: stopped generation survived"
[[ -z "$(marker "$A")" ]] && ok "A: identity marker file removed by stop" || bad "A: marker file still present"
echo "    config after stop: $(cfg "$A" '{codexPendingThread,codexThreadId,codexAppServerUrl}')"
A_TID1=$(cfg "$A" '.codexPendingThread.threadId' | tr -d '"')
[[ -z "$(find "$WORK/.anet/nodes/$A/codex-home" -name "*-$A_TID1.jsonl" 2>/dev/null)" ]] \
  && ok "A: codex never wrote a rollout for the pending thread (it had no conversation)" || bad "A: a rollout exists for $A_TID1"
start_node "$A" second
if [[ "$START_RC" == 0 ]] && triplet_up "$A"; then
  ok "A: start after stop brought the node back up"
else
  bad "A: start after stop refused/failed (rc=$START_RC): $(grep -m1 -F '❌' "/tmp/start-$A-second.log")"
fi
A_M2=$(marker "$A")
[[ -n "$A_M2" && "$A_M2" != "$A_M1" ]] && ok "A: new generation has a fresh marker" || bad "A: marker not renewed ($A_M1 → $A_M2)"
P=$(cfg "$A" '.codexPendingThread.marker' | tr -d '"')
[[ -z "$P" || "$P" == null || "$P" == "$A_M2" ]] && ok "A: no pending candidate is left bound to a dead marker" \
  || bad "A: pending candidate still bound to ${P:0:8} (live marker ${A_M2:0:8})"
grep -Fq "dropped the pending Codex thread $A_TID1" "/tmp/start-$A-second.log" \
  && ok "A: start said it dropped the never-used candidate $A_TID1" || bad "A: start did not report dropping $A_TID1"
wait_field "$A" .codexPendingThread 40 && [[ "$(cfg "$A" '.codexPendingThread.threadId' | tr -d '"')" != "$A_TID1" ]] \
  && ok "A: the new generation bound its own fresh thread ($(cfg "$A" '.codexPendingThread.threadId'))" \
  || bad "A: new generation's candidate: $(cfg "$A" '.codexPendingThread')"
# a second cycle must work too
stop_node "$A" 2
start_node "$A" third
[[ "$START_RC" == 0 ]] && triplet_up "$A" && ok "A: a second stop → start cycle works too" || bad "A: second cycle failed (rc=$START_RC)"
stop_node "$A" 3
[[ "$STOP_RC" == 0 ]] && ok "A: final stop rc=0" || bad "A: final stop rc=$STOP_RC"

# ── C. a thread that DID have a conversation ─────────────────────────
note "C. thread with a conversation: start → submit a message in the TUI → stop → start"
C=cx-used
make_node "$C" || exit 1
start_node "$C" first
[[ "$START_RC" == 0 ]] && triplet_up "$C" && ok "C: first start brought up the triplet" || { bad "C: first start failed"; cat "/tmp/start-$C-first.log"; exit 1; }
wait_field "$C" .codexPendingThread 40 && ok "C: pending candidate bound" || bad "C: no pending candidate"
sleep 2
echo "    TUI before typing:"; tm capture-pane -p -t "=$C:" 2>&1 | grep -v '^\s*$' | tail -12 | sed 's/^/      | /'
tm send-keys -t "=$C:" -l "hello from qa 602"; sleep 0.5; tm send-keys -t "=$C:" Enter
sleep 3
echo "    TUI after submitting:"; tm capture-pane -p -t "=$C:" 2>&1 | grep -v '^\s*$' | tail -12 | sed 's/^/      | /'
if wait_field "$C" .codexThreadId 40; then
  ok "C: the bridge promoted the thread once it had a conversation: $(cfg "$C" .codexThreadId)"
else
  bad "C: thread never promoted: $(cfg "$C" '{codexPendingThread,codexThreadId}')"
  tm capture-pane -p -t "=$C:" 2>/dev/null | tail -20 | sed 's/^/      /'
fi
C_TID=$(cfg "$C" .codexThreadId | tr -d '"')
# The submitted turn cannot reach a model (--network none) and codex keeps retrying it ("Working").
# Stopping a node in the middle of a turn is a different scenario (CI saw a marker pid outlive
# grace+KILL there); this one is about restarting a used thread, so let the turn end first:
# interrupt it the way a human would (Esc) and wait until the TUI is idle.
C_IDLE=0
for _ in $(seq 1 30); do
  tm capture-pane -p -t "=$C:" 2>/dev/null | grep -Fq "Working" || { C_IDLE=1; break; }
  tm send-keys -t "=$C:" Escape; sleep 1
done
[[ "$C_IDLE" == 1 ]] && ok "C: the turn was interrupted and the TUI is idle before stop" \
  || { bad "C: the TUI still shows a running turn after 30 s"; tm capture-pane -p -t "=$C:" | grep -v '^\s*$' | tail -6 | sed 's/^/      | /'; }
C_M1=$(marker "$C")
stop_node "$C" 1
if [[ "$STOP_RC" == 0 ]]; then ok "C: stop rc=0"; else
  bad "C: stop rc=$STOP_RC"
  echo "    full stop log:"; sed 's/^/      /' "/tmp/stop-$C-1.log"
  for p in $(marker_pids "$C_M1"); do echo "    survivor pid=$p stat=$(awk '{print $3}' /proc/$p/stat 2>/dev/null) cmd=$(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-120)"; done
fi
start_node "$C" second
[[ "$START_RC" == 0 ]] && triplet_up "$C" && ok "C: start after stop brought the node back up" \
  || bad "C: start after stop failed (rc=$START_RC): $(grep -m1 -F '❌' "/tmp/start-$C-second.log")"
[[ -n "$C_TID" && "$(cfg "$C" .codexThreadId | tr -d '"')" == "$C_TID" ]] && ok "C: the same thread is kept ($C_TID)" || bad "C: thread changed: $C_TID → $(cfg "$C" .codexThreadId)"
grep -Fq "$C_TID" "/tmp/start-$C-second.log" && ok "C: the launcher resumed that thread" || bad "C: launcher output does not name the thread"
stop_node "$C" 2

# ── D. the safety the refusal protects ─────────────────────────────────
note "D. pending candidate bound to a marker this node never had"
D=cx-forged
make_node "$D" || exit 1
start_node "$D" first
[[ "$START_RC" == 0 ]] && triplet_up "$D" && ok "D: first start brought up the triplet" || { bad "D: first start failed"; exit 1; }
wait_field "$D" .codexPendingThread 40 && ok "D: pending candidate bound" || bad "D: no pending candidate"
stop_node "$D" 1
DCFG="$WORK/.anet/nodes/$D/config.json"
FORGED_TID="01a10dbe-0000-7000-8000-000000000602"
jq --arg t "$FORGED_TID" '.codexPendingThread.marker = "11111111-2222-4333-8444-555555555555" | .codexPendingThread.threadId = $t' \
  "$DCFG" > "$DCFG.tmp" && mv "$DCFG.tmp" "$DCFG" && chmod 600 "$DCFG"
ROLL_DIR="$WORK/.anet/nodes/$D/codex-home/sessions/2026/10/06"
mkdir -p "$ROLL_DIR"; printf '{}\n' > "$ROLL_DIR/rollout-2026-10-06T00-00-00-$FORGED_TID.jsonl"

echo "  D1: foreign marker + the thread has a rollout"
start_node "$D" forged-with-rollout
[[ "$START_RC" != 0 ]] && ok "D1: start refused (rc=$START_RC)" || bad "D1: start ACCEPTED a foreign-marker candidate whose thread has a rollout"
grep -Fq "previous-generation marker" "/tmp/start-$D-forged-with-rollout.log" && grep -Fq "has a rollout" "/tmp/start-$D-forged-with-rollout.log" \
  && ok "D1: refused for that reason" || bad "D1: refused for another reason: $(grep -F '❌' -A1 "/tmp/start-$D-forged-with-rollout.log" | head -2)"
for s in "$D" "$D-appsrv" "$D-桥"; do session_alive "$s" && bad "D1: session $s was started" || ok "D1: no session $s"; done
[[ "$(cfg "$D" '.codexPendingThread.threadId' | tr -d '"')" == "$FORGED_TID" ]] && ok "D1: the candidate is left untouched for the operator" || bad "D1: candidate was altered"

echo "  D2: same foreign marker, no rollout"
rm -f "$ROLL_DIR/rollout-2026-10-06T00-00-00-$FORGED_TID.jsonl"
start_node "$D" forged-no-rollout
[[ "$START_RC" == 0 ]] && triplet_up "$D" && ok "D2: start dropped the unmaterialized candidate and came up" || bad "D2: start failed (rc=$START_RC)"
wait_field "$D" .codexPendingThread 40
[[ "$(cfg "$D" '.codexPendingThread.threadId' | tr -d '"')" != "$FORGED_TID" && "$(cfg "$D" .codexThreadId | tr -d '"')" != "$FORGED_TID" ]] \
  && ok "D2: the forged thread id was not adopted (now: $(cfg "$D" '.codexPendingThread.threadId'))" || bad "D2: forged thread id adopted"
stop_node "$D" 2

printf "\n==== qa-codex-copresence-stop-start: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
