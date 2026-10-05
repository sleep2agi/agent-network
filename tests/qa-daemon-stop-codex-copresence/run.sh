#!/usr/bin/env bash
# #596 —— daemon 建的 Codex TUI 共存节点(create_node + flags.copresence,#2410),
# daemon 的 stop_node / delete_node 能不能把它**真的**停掉。
#
# 共存节点的 `anet node start` 只是个启动器:它在 tmux 里起三段(<alias> TUI、
# <alias>-appsrv、<alias>-桥),写下身份标记 copresence-identity.json(ANET_NODE_MARKER),
# 然后**自己退出**。daemon 记下的 pid 就是这个启动器 —— 它的进程组里没有任何一段
# tmux 会话(tmux 服务器是自己 daemonize 的),所以按 pid / 进程组发信号对它们无效。
#
# 本套件量的:
#   0  隔离 hub(非 9200)+ 真 `anet daemon up`,镜像里有 tmux + 真 codex(0.147.0)
#   A  create_node(codex-app-server, flags.copresence=true)→ 三段 tmux + 标记都在;
#      建节点请求的状态不是 runtime_capability_check_failed
#   B  delete_node(节点在跑)→ 标记进程 / 用该 CODEX_HOME 的进程 / 三段 tmux 全部消失,
#      workdir 进了回收站
#   C  同名再建一次(新目录)
#   D  stop_node → 同样全部消失、标记文件被删、config 保留
#   B、D 都断言旁边一个**无关**的 tmux 会话与带**别的**标记的进程不受影响。
#
# 为什么不是 stop → start_node → delete:`anet node stop` 之后 config 里的 codexPendingThread
# (线程还没有过一次对话)指向已被删除的标记,下一次 `anet node start` 会 fail-closed 拒起
# ——那是另一件事(手工 stop/start 同样如此),不在本套件的判据里。
#
# 全程在容器里:HOME=$(mktemp -d),hub 在 9596,tmux 是这个容器自己的服务器。
set -uo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite starts tmux servers and kills pids; run it in its container." >&2
  exit 2
fi
echo "source_commit=${DSCC_SOURCE_COMMIT:-unknown}"

HUB_PORT=9596
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/dscc-XXXXXX.db)
ADMIN_USER="dsccadmin"
ADMIN_PW="dscc_TestPass_1234!"
DAEMON_NAME="cp-daemon"
ALIAS="cx-shared"

export HOME=$(mktemp -d /tmp/dscc-home-XXXXXX)
DAEMON_DIR="$HOME/$DAEMON_NAME"
NODE_DIR="$DAEMON_DIR/.anet/nodes/$ALIAS"
MARKER="$NODE_DIR/copresence-identity.json"
SESSIONS=("$ALIAS" "$ALIAS-appsrv" "$ALIAS-桥")

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }

mcp_call() {
  local tok="$1" body="$2" resp inner
  resp=$(curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' -d "$body")
  inner=$(printf '%s\n' "$resp" | sed -n 's/^data: //p' | sed -n '1p' | jq -r '.result.content[0].text' 2>/dev/null)
  if [[ -z "$inner" || "$inner" == "null" ]]; then
    inner=$(printf '%s' "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  fi
  if [[ -z "$inner" || "$inner" == "null" ]]; then printf '%s' "$resp"; else printf '%s' "$inner"; fi
}
tool_body() { jq -cn --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}'; }

session_alive() { tmux has-session -t "=$1" 2>/dev/null; }
marker_pids() {   # every live pid whose environ carries ANET_NODE_MARKER=<uuid>
  local uuid="$1" p
  for p in /proc/[0-9]*; do
    tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -Fxq "ANET_NODE_MARKER=$uuid" && basename "$p"
  done
}
codex_home_pids() {   # every live pid whose environ carries CODEX_HOME=<node codex-home>
  local home="$1" p
  for p in /proc/[0-9]*; do
    tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -Fxq "CODEX_HOME=$home" && basename "$p"
  done
}
req_status() { sqlite3 "$HUB_DB" "SELECT status FROM $1 WHERE request_id='$2';" 2>/dev/null; }
req_error()  { sqlite3 "$HUB_DB" "SELECT COALESCE(error,'') FROM $1 WHERE request_id='$2';" 2>/dev/null; }
wait_terminal() {   # table, request_id, seconds
  local s="" i
  for i in $(seq 1 "$3"); do
    s=$(req_status "$1" "$2")
    case "$s" in stopped|stop_failed|failed|started|start_failed|succeeded|runtime_capability_check_failed|noop_not_my_child) break ;; esac
    sleep 1
  done
  printf '%s' "$s"
}
wait_up() {   # wait for marker + all three sessions; prints the marker uuid
  local i s all
  for i in $(seq 1 90); do
    all=1
    [[ -s "$MARKER" ]] || all=0
    for s in "${SESSIONS[@]}"; do session_alive "$s" || all=0; done
    [[ "$all" == 1 ]] && { jq -r '.marker' "$MARKER"; return 0; }
    sleep 1
  done
  return 1
}
show_state() {
  echo "    tmux: $(tmux list-sessions -F '#{session_name}' 2>/dev/null | tr '\n' ' ')"
  echo "    daemon log (create/stop/start lines):"
  grep -E '\[(create-node|stop-daemon|start-daemon)\]' /tmp/daemon-596.log | tail -25 | sed 's/^/      /'
}
# Shared assertions: the generation identified by $1 (marker uuid) is completely gone.
assert_generation_gone() {
  local uuid="$1" label="$2" left s i
  for i in $(seq 1 20); do
    left=$(marker_pids "$uuid" | tr '\n' ' ')
    [[ -z "${left// /}" ]] && break
    sleep 0.5
  done
  [[ -z "${left// /}" ]] && ok "$label: no process carries the node's ANET_NODE_MARKER" \
    || bad "$label: marker-bearing pids survived the daemon's $label: $left ($(for p in $left; do tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-60; echo -n ' | '; done))"
  left=$(codex_home_pids "$CODEX_HOME_ABS" | tr '\n' ' ')
  [[ -z "${left// /}" ]] && ok "$label: no process runs with the node's CODEX_HOME" \
    || bad "$label: CODEX_HOME=$CODEX_HOME_ABS pids survived: $left"
  for s in "${SESSIONS[@]}"; do
    session_alive "$s" && bad "$label: tmux session survived: $s" || ok "$label: tmux session gone: $s"
  done
}

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  tmux kill-server 2>/dev/null   # this container's own tmux server only
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  [[ -n "${PAIR_REG_PID:-}" ]] && kill "$PAIR_REG_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 0. hub + daemon ───────────────────────────────────────────────────
note "0. isolated hub :$HUB_PORT + \`anet daemon up\` (HOME=$HOME)"
[[ "$HUB_PORT" != 9200 ]] && ok "hub port is not 9200" || { bad "refusing to use 9200"; exit 1; }
command -v tmux >/dev/null && command -v codex >/dev/null && ok "tmux $(tmux -V | cut -d' ' -f2) + $(codex --version 2>/dev/null | tail -1) in the image" \
  || { bad "image lacks tmux/codex"; exit 1; }
PAIR_REG_PORT=9597
python3 /app/tests/qa-create-node-codex-copresence/paired-registry.py \
  "$(ls /app/agent-node/sleep2agi-agent-node-*.tgz)" "$PAIR_REG_PORT" >/tmp/pair-registry.log 2>&1 &
PAIR_REG_PID=$!
printf '@sleep2agi:registry=http://127.0.0.1:%s/\n' "$PAIR_REG_PORT" > "$HOME/.npmrc"
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PAIR_REG_PORT/@sleep2agi%2fagent-node" >/dev/null 2>&1 && break; sleep 0.25; done
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-596.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-596.log; exit 1; }
REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"dscc@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')

mkdir -p "$HOME/.anet" "$DAEMON_DIR" "$HOME/.codex"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
# A host codex login for the launcher to stage into the node's CODEX_HOME (the login gate refuses
# to start a TUI that would sit on the sign-in page). Fake key; the container has no route to use it.
printf '{"OPENAI_API_KEY":"sk-dscc-not-a-real-key"}\n' > "$HOME/.codex/auth.json"; chmod 600 "$HOME/.codex/auth.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
(cd "$DAEMON_DIR" && exec anet daemon up "$DAEMON_NAME") >/tmp/daemon-596.log 2>&1 &
DAEMON_PID=$!
DAEMON_NODE_ID=""
for _ in $(seq 1 60); do
  DAEMON_NODE_ID=$(curl -sS "$HUB_BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK" \
    | jq -r --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .daemon_node_id' 2>/dev/null)
  [[ -n "$DAEMON_NODE_ID" ]] && break
  sleep 1
done
[[ -n "$DAEMON_NODE_ID" ]] && ok "daemon listed ($DAEMON_NODE_ID)" || { bad "daemon never listed"; tail -40 /tmp/daemon-596.log; exit 1; }
sleep 4   # past the daemon's boot children-map rebuild

# Bystanders that must survive everything below: an unrelated tmux session, and a process that
# carries a DIFFERENT co-presence marker (another node's generation).
tmux new-session -d -s bystander-596 "exec sleep 3600"
BYSTANDER_PID_FILE=$(mktemp -u /tmp/dscc-by-XXXXXX)
setsid env ANET_NODE_MARKER=00000000-0000-4000-8000-000000000596 bash -c "echo \$\$ > $BYSTANDER_PID_FILE; exec sleep 3600" &
for _ in $(seq 1 20); do [[ -s "$BYSTANDER_PID_FILE" ]] && break; sleep 0.1; done
BYSTANDER_PID=$(cat "$BYSTANDER_PID_FILE")
bystanders_intact() {
  session_alive bystander-596 && ok "$1: unrelated tmux session untouched" || bad "$1: unrelated tmux session was killed"
  kill -0 "$BYSTANDER_PID" 2>/dev/null && ok "$1: other-marker process untouched" || bad "$1: other-marker process was killed"
}

# create_node with flags.copresence and wait for the triplet; sets CREQ / CHILD_ID / UUID / CODEX_HOME_ABS
create_copresence() {
  local label="$1" spec r cstatus n
  spec=$(jq -cn --arg n "$ALIAS" '{name:$n,runtime:"codex-app-server",model:"gpt-5.5",flags:{permissionMode:"default",copresence:true}}')
  r=$(mcp_call "$UTOK" "$(tool_body create_node "$(jq -cn --arg d "$DAEMON_NODE_ID" --arg net "$NET_ID" --argjson s "$spec" '{daemon_node_id:$d,network_id:$net,node_spec:$s}')")")
  CREQ=$(printf '%s' "$r" | jq -r '.request_id // empty' 2>/dev/null)
  [[ "$CREQ" == cr_* ]] && ok "$label: create_node dispatched ($CREQ)" || { bad "$label: dispatch failed: $r"; return 1; }
  CHILD_ID="node_${CREQ#cr_}"
  if UUID=$(wait_up); then
    ok "$label: marker + tmux sessions ${SESSIONS[*]} are up (marker ${UUID:0:8}…)"
  else
    bad "$label: co-presence triplet never came up"; show_state; tail -40 /tmp/daemon-596.log; return 1
  fi
  CODEX_HOME_ABS=$(realpath "$NODE_DIR/codex-home")
  n=$(marker_pids "$UUID" | wc -l)
  [[ "$n" -ge 3 ]] && ok "$label: $n processes carry the node marker" || bad "$label: only $n marker processes"
  cstatus=$(wait_terminal node_create_requests "$CREQ" 30)
  echo "    create request: status=$cstatus error=$(req_error node_create_requests "$CREQ" | cut -c1-200)"
  [[ "$cstatus" != runtime_capability_check_failed && "$cstatus" != failed ]] \
    && ok "$label: create request not misreported as a failed start (status=$cstatus)" \
    || bad "$label: create request misreported: status=$cstatus"
  for _ in $(seq 1 60); do
    [[ -n "$(sqlite3 "$HUB_DB" "SELECT node_id FROM nodes WHERE node_id='$CHILD_ID';" 2>/dev/null)" ]] && break
    sleep 1
  done
  sleep 6   # past the daemon's 5 s post-spawn check
  # The status above can already read `succeeded` (the bridge registered) when the daemon's +5 s
  # check acks runtime_capability_check_failed — the hub keeps the status but still REVOKES the
  # child's node token and audits daemon_capability_lied. That happens whenever the launcher
  # finishes inside 5 s (it exits 0 by design once the sessions are up), so assert the effects.
  local lied revoked
  lied=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM audit_log WHERE action='daemon_capability_lied' AND target_id='$CREQ';" 2>/dev/null)
  [[ "$lied" == 0 ]] && ok "$label: no daemon_capability_lied audit for a node that came up" \
    || bad "$label: daemon reported a capability failure for a running node ($(grep -F 'runtime_capability_check_failed' /tmp/daemon-596.log | tail -1 | cut -c1-160))"
  revoked=$(sqlite3 "$HUB_DB" "SELECT COALESCE(t.revoked_at,'') FROM node_create_requests r JOIN api_tokens t ON t.token_id=r.child_token_id WHERE r.request_id='$CREQ';" 2>/dev/null)
  [[ -z "$revoked" ]] && ok "$label: the running child's node token is not revoked" \
    || bad "$label: the running child's node token was revoked at $revoked"
}

# Test hygiene only (never part of a verdict): when the daemon left a generation running (the
# defect), remove it from this container so the next section starts clean — by its marker, then
# by its own three session names. This container's tmux server only.
force_clean_generation() {
  local uuid="$1" p s
  for p in $(marker_pids "$uuid"); do kill -9 "$p" 2>/dev/null; done
  for s in "${SESSIONS[@]}"; do tmux kill-session -t "=$s" 2>/dev/null; done
  return 0
}

# ── A+B. create → delete_node while it runs ───────────────────────────
note "A. create_node codex-app-server + flags.copresence=true → shared TUI triplet"
create_copresence "create#1" || exit 1
show_state

note "B. delete_node through the daemon (node running)"
R=$(mcp_call "$UTOK" "$(tool_body delete_node "$(jq -cn --arg c "$CHILD_ID" --arg d "$DAEMON_NODE_ID" --arg a "$ALIAS" --arg net "$NET_ID" '{child_node_id:$c,daemon_node_id:$d,confirm_alias:$a,network_id:$net,force:true}')")")
DREQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$DREQ" == sr_* ]] && ok "delete_node dispatched ($DREQ)" || bad "delete_node dispatch: $R"
DSTATUS=$(wait_terminal node_stop_requests "$DREQ" 90)
echo "    delete request: status=$DSTATUS error=$(req_error node_stop_requests "$DREQ" | cut -c1-300)"
[[ "$DSTATUS" == stopped ]] && ok "daemon acked the delete" || bad "delete request status=$DSTATUS"
assert_generation_gone "$UUID" "delete"
[[ ! -e "$NODE_DIR" ]] && ok "delete: node dir moved out of .anet/nodes" || bad "delete: node dir still at $NODE_DIR"
TRASHED=$(ls -d "$DAEMON_DIR/.anet/deleted/"*"-$ALIAS" 2>/dev/null | head -1)
[[ -n "$TRASHED" ]] && ok "delete: workdir in the trash ($TRASHED)" || bad "delete: nothing in .anet/deleted"
[[ -n "$TRASHED" && ! -e "$TRASHED/copresence-identity.json" ]] && ok "delete: trashed dir holds no live identity marker (teardown ran before the move)" \
  || bad "delete: identity marker moved into the trash with its generation still owning it"
bystanders_intact "delete"
show_state
force_clean_generation "$UUID"

# ── C+D. re-create the same alias → stop_node ─────────────────────────
note "C. create the same alias again (fresh node dir)"
for _ in $(seq 1 30); do
  [[ -z "$(sqlite3 "$HUB_DB" "SELECT node_id FROM nodes WHERE node_id='$CHILD_ID';" 2>/dev/null)" ]] && break; sleep 1
done
create_copresence "create#2" || exit 1

note "D. stop_node through the daemon"
R=$(mcp_call "$UTOK" "$(tool_body stop_node "$(jq -cn --arg c "$CHILD_ID" --arg d "$DAEMON_NODE_ID" --arg net "$NET_ID" '{child_node_id:$c,daemon_node_id:$d,network_id:$net,force:true}')")")
SREQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$SREQ" == sr_* ]] && ok "stop_node dispatched ($SREQ)" || bad "stop_node dispatch: $R"
SSTATUS=$(wait_terminal node_stop_requests "$SREQ" 90)
echo "    stop request: status=$SSTATUS error=$(req_error node_stop_requests "$SREQ" | cut -c1-300)"
[[ "$SSTATUS" == stopped ]] && ok "daemon acked stopped" || bad "stop request status=$SSTATUS"
assert_generation_gone "$UUID" "stop"
[[ ! -e "$MARKER" ]] && ok "stop: identity marker file removed (teardown completed)" || bad "stop: identity marker file still present"
[[ -f "$NODE_DIR/config.json" ]] && ok "stop: child config kept (stop is not delete)" || bad "stop: child config gone"
bystanders_intact "stop"
show_state

printf "\n==== qa-daemon-stop-codex-copresence: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "── daemon log (tail) ──"; tail -60 /tmp/daemon-596.log
  exit 1
fi
exit 0
