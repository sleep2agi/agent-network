#!/usr/bin/env bash
# app「新建节点」工作目录 —— 真 hub + 真 `anet daemon up` + 真 create_node 的端到端。
#
# 单测验不了、这里验的:
#   - daemon 自报的 default_workdir_root 真的一路走到 /api/host-supervisors(app 读的那个接口)
#   - 默认规则 `<root>/<name>` 建出来的节点,.anet 真的落在那个目录、进程 cwd 就是它、目录 0700
#   - 自定义 `~/…` 在 daemon 侧展开;节点能起、能注册
#   - 老布局(不带 workdir)逐字不变:落 daemon cwd
#   - 拒绝路径:$HOME 本身 / 已住着别的节点 / 形状不对(hub 侧)—— 都**不**建出节点
#   - 停止 → 启动 → 删除 仍然找得到一个住在自己目录里的节点(daemon 的登记)
#   - DEV 开机 sweep 的 glob(`$HOME/*/.anet`,从 deploy/fleet/anet-nodes-boot.sh 原样取)
#     命中默认目录、**不**命中更深的自定义目录 —— 默认根取 $HOME 的理由,这里量给你看
#
# 全程在容器里:HOME=$(mktemp -d),hub 在非 9200 端口。
set -uo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub and kills pids; run it in its container." >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_COMMIT=${CNWD_SOURCE_COMMIT:-}
RUNSH_BLOB=${CNWD_RUNSH_BLOB:-}
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: CNWD_SOURCE_COMMIT must be one full lowercase Git SHA (got '${SOURCE_COMMIT:-unset}')" >&2
  echo "      build with: --build-arg SOURCE_COMMIT=\$(git rev-parse HEAD) --build-arg RUNSH_BLOB=\$(git rev-parse HEAD:tests/qa-create-node-workdir/run.sh)" >&2
  exit 1
fi
_self="$SCRIPT_DIR/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
if [[ "$_actual" != "$RUNSH_BLOB" ]]; then
  echo "FAIL: run.sh in the image is not the one SOURCE_COMMIT=$SOURCE_COMMIT claims (expected blob $RUNSH_BLOB, actual $_actual)" >&2
  exit 1
fi
echo "provenance: source_commit=$SOURCE_COMMIT run.sh blob=$_actual (verified)"

HUB_PORT=9263
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/qa-cnwd-XXXXXX.db)
ADMIN_USER="cnwdadmin"
ADMIN_PW="cnwd_TestPass_1234!"
DAEMON_NAME="wd-daemon"
BOOT_SWEEP=/app/deploy/fleet/anet-nodes-boot.sh

export HOME=$(mktemp -d /tmp/qa-cnwd-home-XXXXXX)
DAEMON_DIR="$HOME/$DAEMON_NAME"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
# 先断言「现在是红的」,再做动作,再断言绿 —— 同一个谓词,证明它有分辨力。
expect_red() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "RED-GATE $what — passed before the action (no discriminating power)"
  else ok "RED-GATE $what — red before the action"; fi
}

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
tool_body() {   # name, arguments-json
  jq -cn --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}'
}
create_body() { # name, [workdir]
  local spec
  if [[ $# -ge 2 ]]; then
    spec=$(jq -cn --arg n "$1" --arg w "$2" '{name:$n,runtime:"claude-agent-sdk",model:"claude-opus-original",workdir:$w}')
  else
    spec=$(jq -cn --arg n "$1" '{name:$n,runtime:"claude-agent-sdk",model:"claude-opus-original"}')
  fi
  tool_body create_node "$(jq -cn --arg d "$DAEMON_NODE_ID" --arg net "$NET_ID" --argjson s "$spec" '{daemon_node_id:$d,network_id:$net,node_spec:$s}')"
}

agent_pids() { pgrep -f "agent-node.*--alias $1( |\$)" 2>/dev/null; }
agent_cwd() {
  local p
  for p in $(agent_pids "$1"); do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "--alias $1"; then readlink "/proc/$p/cwd"; return 0; fi
  done
  return 1
}
req_status() { sqlite3 "$HUB_DB" "SELECT status FROM node_create_requests WHERE request_id='$1';" 2>/dev/null; }
req_error()  { sqlite3 "$HUB_DB" "SELECT COALESCE(error,'') FROM node_create_requests WHERE request_id='$1';" 2>/dev/null; }
wait_req_terminal() { # request_id → prints final status
  local s="" i
  for i in $(seq 1 60); do
    s=$(req_status "$1")
    case "$s" in succeeded|failed|rejected|runtime_capability_check_failed) break ;; esac
    sleep 1
  done
  printf '%s' "$s"
}
registered() { curl -sS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK" | jq -e --arg a "$1" '[.nodes[]? | select(.alias==$a)] | length > 0' >/dev/null 2>&1; }
wait_registered() { local i; for i in $(seq 1 60); do registered "$1" && return 0; sleep 1; done; return 1; }
lifecycle_is() { [[ "$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$1';" 2>/dev/null)" == "$2" ]]; }
wait_lifecycle() { local i; for i in $(seq 1 60); do lifecycle_is "$1" "$2" && return 0; sleep 1; done; return 1; }

cleanup() {
  local a p
  for a in child-default custom-b legacy-c "$DAEMON_NAME"; do
    for p in $(agent_pids "$a"); do
      tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "--alias $a" && kill "$p" 2>/dev/null
    done
  done
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 0. hub + daemon ───────────────────────────────────────────────────
note "0. isolated hub :$HUB_PORT + \`anet daemon up\` (HOME=$HOME)"
[[ "$HUB_PORT" != 9200 ]] && ok "hub port is not 9200" || { bad "refusing to use 9200"; exit 1; }
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-cnwd.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-cnwd.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"cnwd@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network = $NET_ID" || { bad "no network"; exit 1; }

mkdir -p "$HOME/.anet" "$DAEMON_DIR"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
(cd "$DAEMON_DIR" && exec anet daemon up "$DAEMON_NAME") >/tmp/daemon-cnwd.log 2>&1 &
DAEMON_PID=$!

# readiness = /api/host-supervisors (the endpoint the app wizard reads) lists the daemon
# WITH the new capability. Registration alone is not enough: config_snapshot lands after.
DAEMON_NODE_ID=""; ROOT=""
for _ in $(seq 1 60); do
  HS=$(curl -sS "$HUB_BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
  DAEMON_NODE_ID=$(printf '%s' "$HS" | jq -r --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .daemon_node_id' 2>/dev/null)
  ROOT=$(printf '%s' "$HS" | jq -r --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .default_workdir_root // empty' 2>/dev/null)
  [[ -n "$DAEMON_NODE_ID" && -n "$ROOT" ]] && break
  sleep 1
done
[[ -n "$DAEMON_NODE_ID" ]] && ok "daemon listed by /api/host-supervisors ($DAEMON_NODE_ID)" \
  || { bad "daemon never listed"; tail -40 /tmp/daemon-cnwd.log; exit 1; }
[[ "$ROOT" == "$HOME" ]] && ok "default_workdir_root == daemon \$HOME (unset config → \$HOME)" \
  || bad "default_workdir_root='$ROOT' (want $HOME)"
test -f "$DAEMON_DIR/.anet/nodes/$DAEMON_NAME/config.json" \
  && ok "daemon lives in its own dir ($DAEMON_DIR), not \$HOME" || bad "daemon config not under $DAEMON_DIR"

# ── A. default rule: <root>/<name> (what the app sends when the user doesn't edit) ─
note "A. default workdir <root>/<name>"
A=child-default
A_WD="$ROOT/$A"
A_CFG="$A_WD/.anet/nodes/$A/config.json"
expect_red "A config absent before create" test -f "$A_CFG"
R=$(mcp_call "$UTOK" "$(create_body "$A" "$A_WD")")
A_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$A_REQ" == cr_* ]] && ok "create_node dispatched ($A_REQ)" || bad "dispatch failed: $R"
A_NODE_ID="node_${A_REQ#cr_}"
wait_registered "$A" && ok "$A registered with the hub" || { bad "$A never registered"; tail -40 /tmp/daemon-cnwd.log; }
[[ "$(wait_req_terminal "$A_REQ")" == succeeded ]] && ok "request status succeeded" || bad "status=$(req_status "$A_REQ") error=$(req_error "$A_REQ")"
test -f "$A_CFG" && ok ".anet landed in $A_WD" || bad "config not at $A_CFG (ls: $(ls -la "$A_WD" 2>&1))"
[[ ! -e "$DAEMON_DIR/.anet/nodes/$A" ]] && ok "NOT in the daemon's own dir" || bad "also/instead in $DAEMON_DIR/.anet/nodes/$A"
[[ ! -e "$HOME/.anet/nodes/$A" ]] && ok "NOT in \$HOME/.anet" || bad "leaked into \$HOME/.anet/nodes/$A"
MODE=$(stat -c %a "$A_WD" 2>/dev/null)
[[ "$MODE" == 700 ]] && ok "new workdir created 0700" || bad "workdir mode=$MODE (want 700)"
A_CWD=$(agent_cwd "$A" || true)
[[ "$A_CWD" == "$A_WD" ]] && ok "agent-node process cwd == $A_WD" || bad "agent-node cwd='$A_CWD' (want $A_WD)"
[[ "$(jq -r --arg a "$A" '.[$a] // empty' "$DAEMON_DIR/.anet/child-workdirs.json" 2>/dev/null)" == "$A_WD" ]] \
  && ok "daemon registry records $A → its workdir" || bad "registry: $(cat "$DAEMON_DIR/.anet/child-workdirs.json" 2>&1)"
sleep 8
[[ -n "$(agent_pids "$A")" ]] && ok "$A still alive after 8s" || bad "$A died after start"

# ── B. custom ~/… path (the 「改」 button) ───────────────────────────────
note "B. custom workdir ~/projects/custom-b"
B=custom-b
B_WD="$HOME/projects/custom-b"
R=$(mcp_call "$UTOK" "$(create_body "$B" "~/projects/custom-b")")
B_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$B_REQ" == cr_* ]] && ok "create_node dispatched ($B_REQ)" || bad "dispatch failed: $R"
B_NODE_ID="node_${B_REQ#cr_}"
wait_registered "$B" && ok "$B registered" || bad "$B never registered"
[[ "$(wait_req_terminal "$B_REQ")" == succeeded ]] && ok "request succeeded" || bad "status=$(req_status "$B_REQ") error=$(req_error "$B_REQ")"
test -f "$B_WD/.anet/nodes/$B/config.json" && ok "~ expanded daemon-side → $B_WD" || bad "config not under $B_WD"
[[ "$(stat -c %a "$HOME/projects" 2>/dev/null)" == 700 ]] && ok "intermediate dir created 0700 too" || bad "intermediate mode=$(stat -c %a "$HOME/projects" 2>/dev/null)"
[[ "$(agent_cwd "$B" || true)" == "$B_WD" ]] && ok "agent-node cwd == $B_WD" || bad "cwd='$(agent_cwd "$B" || true)'"

# ── C. legacy: no workdir → daemon cwd (old callers unchanged) ──────────
note "C. no workdir → legacy layout (daemon cwd)"
C=legacy-c
R=$(mcp_call "$UTOK" "$(create_body "$C")")
C_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$C_REQ" == cr_* ]] && ok "create_node dispatched ($C_REQ)" || bad "dispatch failed: $R"
wait_registered "$C" && ok "$C registered" || bad "$C never registered"
test -f "$DAEMON_DIR/.anet/nodes/$C/config.json" && ok "landed in daemon dir exactly as before" || bad "legacy layout changed"
[[ -z "$(jq -r --arg a "$C" '.[$a] // empty' "$DAEMON_DIR/.anet/child-workdirs.json" 2>/dev/null)" ]] \
  && ok "legacy child NOT in the registry" || bad "legacy child was registered"

# ── D. rejections: no node gets created ─────────────────────────────────
note "D. rejections"
R=$(mcp_call "$UTOK" "$(create_body d-home "~")")
D1=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
S=$(wait_req_terminal "$D1"); E=$(req_error "$D1")
[[ "$S" == rejected && "$E" == *workdir_is_home* ]] && ok "~ (=\$HOME) rejected by daemon: $E" || bad "home: status=$S error=$E"
[[ ! -e "$HOME/.anet/nodes/d-home" ]] && ok "nothing written under \$HOME/.anet" || bad "d-home config written"

R=$(mcp_call "$UTOK" "$(create_body d-squat "$A_WD")")
D2=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
S=$(wait_req_terminal "$D2"); E=$(req_error "$D2")
[[ "$S" == rejected && "$E" == *"workdir_has_other_node:$A"* ]] && ok "dir already hosting $A rejected, naming it: $E" || bad "squat: status=$S error=$E"
[[ ! -e "$A_WD/.anet/nodes/d-squat" ]] && ok "no second node written into $A's dir" || bad "d-squat written next to $A"

R=$(mcp_call "$UTOK" "$(create_body d-etc /etc/d-etc)")
D3=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
S=$(wait_req_terminal "$D3"); E=$(req_error "$D3")
[[ "$S" == rejected && "$E" == *workdir_is_system_dir* ]] && ok "/etc/... rejected: $E" || bad "etc: status=$S error=$E"
[[ ! -e /etc/d-etc ]] && ok "/etc/d-etc not created" || bad "/etc/d-etc exists"

R=$(mcp_call "$UTOK" "$(create_body d-cjk "~/吉他大师")")
D4=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
S=$(wait_req_terminal "$D4"); E=$(req_error "$D4")
[[ "$S" == rejected && "$E" == *workdir_not_ascii* ]] && ok "non-ASCII dir name rejected: $E" || bad "cjk: status=$S error=$E"
[[ ! -e "$HOME/吉他大师" ]] && ok "~/吉他大师 not created" || bad "~/吉他大师 was created"

R=$(mcp_call "$UTOK" "$(create_body d-rel relative/dir)")
[[ "$(printf '%s' "$R" | jq -r '.error // empty' 2>/dev/null)" == workdir_invalid ]] && ok "relative path rejected at hub (workdir_invalid)" || bad "relative: $R"
N=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM node_create_requests WHERE child_name='d-rel';")
[[ "$N" == 0 ]] && ok "no request row for the hub-rejected one" || bad "rows=$N"
LEAKED=""
for n in d-home d-squat d-etc d-cjk d-rel; do registered "$n" && LEAKED="$LEAKED $n"; done
[[ -z "$LEAKED" ]] && ok "none of the rejected names registered" || bad "registered despite rejection:$LEAKED"

# ── E. stop → start → delete a child that lives in its own dir ──────────
note "E. lifecycle of $B (own workdir) via the daemon registry"
R=$(mcp_call "$UTOK" "$(tool_body stop_node "$(jq -cn --arg c "$B_NODE_ID" --arg n "$NET_ID" '{child_node_id:$c,network_id:$n,force:true}')")")
wait_lifecycle "$B_NODE_ID" stopped && ok "stop_node → stopped" || bad "stop: $R / state=$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$B_NODE_ID';")"
for _ in $(seq 1 20); do [[ -z "$(agent_pids "$B")" ]] && break; sleep 0.5; done
[[ -z "$(agent_pids "$B")" ]] && ok "$B process gone" || bad "$B still running after stop"
test -f "$B_WD/.anet/nodes/$B/config.json" && ok "stop keeps config in place" || bad "config vanished on stop"

R=$(mcp_call "$UTOK" "$(tool_body start_node "$(jq -cn --arg c "$B_NODE_ID" --arg n "$NET_ID" '{child_node_id:$c,network_id:$n}')")")
for _ in $(seq 1 40); do [[ -n "$(agent_pids "$B")" ]] && break; sleep 0.5; done
[[ -n "$(agent_pids "$B")" ]] && ok "🔴 start_node found $B in its own dir and started it" \
  || bad "start_node did not start $B: $R ; daemon log: $(grep -F start-daemon /tmp/daemon-cnwd.log | tail -3)"
[[ "$(agent_cwd "$B" || true)" == "$B_WD" ]] && ok "restarted with cwd $B_WD" || bad "restart cwd='$(agent_cwd "$B" || true)'"
wait_lifecycle "$B_NODE_ID" active && ok "hub lifecycle back to active" || bad "state=$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$B_NODE_ID';")"

R=$(mcp_call "$UTOK" "$(tool_body delete_node "$(jq -cn --arg c "$B_NODE_ID" --arg d "$DAEMON_NODE_ID" --arg a "$B" --arg n "$NET_ID" '{child_node_id:$c,daemon_node_id:$d,confirm_alias:$a,network_id:$n,force:true}')")")
for _ in $(seq 1 60); do [[ ! -e "$B_WD/.anet/nodes/$B" ]] && break; sleep 0.5; done
[[ ! -e "$B_WD/.anet/nodes/$B" ]] && ok "delete moved $B's config out of its workdir" || bad "delete left config: $R"
TRASH=$(ls -d "$B_WD/.anet/deleted/"*"-$B" 2>/dev/null || true)
[[ -n "$TRASH" && -f "$TRASH/config.json" ]] && ok "backup in $B_WD/.anet/deleted (same tree)" || bad "no backup under $B_WD/.anet/deleted"
[[ -z "$(jq -r --arg a "$B" '.[$a] // empty' "$DAEMON_DIR/.anet/child-workdirs.json" 2>/dev/null)" ]] \
  && ok "registry entry dropped after delete" || bad "registry still has $B"
[[ -d "$B_WD" ]] && ok "the project dir itself is left alone" || bad "project dir removed"

# ── F. DEV boot sweep reach (why the default root is $HOME) ─────────────
note "F. boot sweep glob (taken verbatim from $BOOT_SWEEP)"
SWEEP_LINE=$(grep -m1 -E '^for d in .*\.anet; do$' "$BOOT_SWEEP" || true)
[[ "$SWEEP_LINE" == 'for d in $HOME/*/.anet; do' ]] && ok "sweep still collects with: $SWEEP_LINE" \
  || bad "sweep collection line changed: '$SWEEP_LINE' — re-check the default-root rationale"
shopt -s nullglob
SWEPT=()
for d in $HOME/*/.anet; do [ -d "$d/nodes" ] && SWEPT+=("$d"); done
shopt -u nullglob
printf '    swept: %s\n' "${SWEPT[@]}"
[[ " ${SWEPT[*]} " == *" $A_WD/.anet "* ]] && ok "default <\$HOME>/<name> is inside the sweep" || bad "default dir NOT swept"
[[ " ${SWEPT[*]} " != *" $HOME/projects/custom-b/.anet "* ]] && ok "deeper custom dir is outside the sweep (documented trade-off)" || bad "custom dir unexpectedly swept"

printf "\n==== qa-create-node-workdir: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "── daemon log (tail) ──"; tail -60 /tmp/daemon-cnwd.log
  exit 1
fi
exit 0
