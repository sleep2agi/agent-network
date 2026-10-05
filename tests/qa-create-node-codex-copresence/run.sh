#!/usr/bin/env bash
# #584 —— app 向导里的「Codex（TUI 共存）」经 daemon 建出来的是**无头**节点,没有 TUI。
#
# 链路:app create_node(runtime=codex-app-server)→ hub → daemon 直接写子节点 config.json
# (不跑 `anet node create`)→ daemon 起 `anet node start <name>`。`anet node start` 只在
# 两种情况下走共存:命令行带 `--copresence`,或 config 里 `codexCopresence: true`
# (agent-network/src/codex-copresence-profile.ts 的 codexCopresenceRequested)。daemon 两样都不给,
# 于是起来的是 `agent-node --runtime codex-app-server` —— 无头。
#
# 修法:node_spec.flags.copresence=true(只对 codex-app-server 有效)一路带到 daemon,
# daemon 写进子节点 config 的 `codexCopresence: true`。选 flags 而不是 node_spec 顶层字段:
# 老 hub 的 zod 会**静默丢掉**未知顶层字段、老 daemon 也会静默忽略 —— 那正是本缺陷的形状;
# 而 flags 里的未知键在老 hub(FLAG_KEYS)和老 daemon(buildAnetArgsDaemon)都会**拒绝**,
# 新 app 撞上老组件得到的是一条报错,不是又一个无头节点。
#
# 本套件量的:
#   A  不带标志(今天 app 发的形状、老 app 永远发的形状)→ 仍是无头,config 无 codexCopresence。
#      这是**保留**的行为:headless codex-app-server 依旧可经 daemon 建。
#   B  带 flags.copresence=true → config 写 codexCopresence:true、flags 里不残留 copresence;
#      daemon 起的 `anet node start` 走共存(从不出现无头 agent-node);
#      前台 `anet node start` 打印共存依赖预检(镜像里故意没有 tmux/codex)。
#   C  非 codex-app-server 带 copresence → hub 拒绝,不落请求行
#   D  copresence 不是布尔 → hub 拒绝
#
# 全程在容器里:HOME=$(mktemp -d),hub 在非 9200 端口,没有 tmux。
set -uo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub and kills pids; run it in its container." >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_COMMIT=${CNCC_SOURCE_COMMIT:-}
RUNSH_BLOB=${CNCC_RUNSH_BLOB:-}
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: CNCC_SOURCE_COMMIT must be one full lowercase Git SHA (got '${SOURCE_COMMIT:-unset}')" >&2
  echo "      build with: --build-arg SOURCE_COMMIT=\$(git rev-parse HEAD) --build-arg RUNSH_BLOB=\$(git rev-parse HEAD:tests/qa-create-node-codex-copresence/run.sh)" >&2
  exit 1
fi
_self="$SCRIPT_DIR/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
if [[ "$_actual" != "$RUNSH_BLOB" ]]; then
  echo "FAIL: run.sh in the image is not the one SOURCE_COMMIT=$SOURCE_COMMIT claims (expected blob $RUNSH_BLOB, actual $_actual)" >&2
  exit 1
fi
echo "provenance: source_commit=$SOURCE_COMMIT run.sh blob=$_actual (verified)"

HUB_PORT=9264
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/qa-cncc-XXXXXX.db)
ADMIN_USER="cnccadmin"
ADMIN_PW="cncc_TestPass_1234!"
DAEMON_NAME="cc-daemon"

export HOME=$(mktemp -d /tmp/qa-cncc-home-XXXXXX)
DAEMON_DIR="$HOME/$DAEMON_NAME"

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
tool_body() {   # name, arguments-json
  jq -cn --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}'
}
create_body() { # name, runtime, flags-json, model-or-empty
  local spec
  spec=$(jq -cn --arg n "$1" --arg r "$2" --argjson f "$3" --arg m "${4:-}" \
    '{name:$n,runtime:$r,flags:$f} + (if $m == "" then {} else {model:$m} end)')
  tool_body create_node "$(jq -cn --arg d "$DAEMON_NODE_ID" --arg net "$NET_ID" --argjson s "$spec" '{daemon_node_id:$d,network_id:$net,node_spec:$s}')"
}
# a headless start of a codex-app-server node is `agent-node … --alias <name> … --runtime codex-app-server`
headless_pids() {
  local p out=""
  for p in $(pgrep -f "agent-node" 2>/dev/null); do
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -Eq -- "--alias $1( |\$)" && out="$out $p"
  done
  printf '%s' "${out# }"
}
req_status() { sqlite3 "$HUB_DB" "SELECT status FROM node_create_requests WHERE request_id='$1';" 2>/dev/null; }
req_error()  { sqlite3 "$HUB_DB" "SELECT COALESCE(error,'') FROM node_create_requests WHERE request_id='$1';" 2>/dev/null; }
# wait until the daemon has acted on the request (config written or a terminal status)
wait_req_settled() {
  local s="" i
  for i in $(seq 1 60); do
    s=$(req_status "$1")
    case "$s" in succeeded|failed|rejected|runtime_capability_check_failed|started) break ;; esac
    sleep 1
  done
  printf '%s' "$s"
}

cleanup() {
  local a p
  for a in cx-headless cx-shared "$DAEMON_NAME"; do
    for p in $(headless_pids "$a"); do kill "$p" 2>/dev/null; done
  done
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 0. hub + daemon ───────────────────────────────────────────────────
note "0. isolated hub :$HUB_PORT + \`anet daemon up\` (HOME=$HOME)"
[[ "$HUB_PORT" != 9200 ]] && ok "hub port is not 9200" || { bad "refusing to use 9200"; exit 1; }
if command -v tmux >/dev/null 2>&1 || command -v codex >/dev/null 2>&1; then
  bad "image has tmux/codex — the dependency preflight below would not be a clean witness"; exit 1
fi
ok "no tmux / codex in the image (by design)"
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-cncc.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-cncc.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"cncc@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network = $NET_ID" || { bad "no network"; exit 1; }

mkdir -p "$HOME/.anet" "$DAEMON_DIR"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
(cd "$DAEMON_DIR" && exec anet daemon up "$DAEMON_NAME") >/tmp/daemon-cncc.log 2>&1 &
DAEMON_PID=$!

DAEMON_NODE_ID=""
for _ in $(seq 1 60); do
  HS=$(curl -sS "$HUB_BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
  DAEMON_NODE_ID=$(printf '%s' "$HS" | jq -r --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .daemon_node_id' 2>/dev/null)
  [[ -n "$DAEMON_NODE_ID" ]] && break
  sleep 1
done
[[ -n "$DAEMON_NODE_ID" ]] && ok "daemon listed by /api/host-supervisors ($DAEMON_NODE_ID)" \
  || { bad "daemon never listed"; tail -40 /tmp/daemon-cncc.log; exit 1; }
sleep 4   # past the daemon's boot children-map rebuild

# ── A. today's app request (no flag) → headless, unchanged ────────────
note "A. codex-app-server without the flag (what every app sends today) → headless, as before"
A=cx-headless
A_CFG="$DAEMON_DIR/.anet/nodes/$A/config.json"
R=$(mcp_call "$UTOK" "$(create_body "$A" codex-app-server '{"permissionMode":"default"}')")
A_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$A_REQ" == cr_* ]] && ok "create_node dispatched ($A_REQ)" || bad "dispatch failed: $R"
for _ in $(seq 1 40); do [[ -f "$A_CFG" ]] && break; sleep 0.5; done
test -f "$A_CFG" && ok "child config written by the daemon" || bad "no child config at $A_CFG"
echo "    config: $(jq -c 'del(.token)' "$A_CFG" 2>/dev/null)"
[[ "$(jq -r '.codexCopresence // "absent"' "$A_CFG" 2>/dev/null)" == absent ]] \
  && ok "no codexCopresence → a plain \`anet node start\` stays headless (kept for old callers)" \
  || bad "codexCopresence unexpectedly set on a flagless create: $(jq -c . "$A_CFG")"
A_HEADLESS=""
for _ in $(seq 1 20); do A_HEADLESS=$(headless_pids "$A"); [[ -n "$A_HEADLESS" ]] && break; sleep 0.5; done
if [[ -n "$A_HEADLESS" ]]; then
  ok "daemon's start brought up a headless agent-node (pid $A_HEADLESS): $(tr '\0' ' ' < "/proc/${A_HEADLESS%% *}/cmdline" 2>/dev/null | grep -oE -- '--runtime [^ ]+')"
else
  bad "no headless agent-node for $A — the baseline this suite contrasts against did not happen"
fi
echo "    request status: $(wait_req_settled "$A_REQ")"

# ── B. flags.copresence=true → config records it, start takes the shared-TUI path ─
note "B. codex-app-server + flags.copresence=true (what 「Codex（TUI 共存）」 must send)"
B=cx-shared
B_CFG="$DAEMON_DIR/.anet/nodes/$B/config.json"
R=$(mcp_call "$UTOK" "$(create_body "$B" codex-app-server '{"permissionMode":"default","copresence":true}')")
B_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$B_REQ" == cr_* ]] && ok "hub accepted flags.copresence and dispatched ($B_REQ)" || bad "hub refused flags.copresence: $R"
for _ in $(seq 1 40); do [[ -f "$B_CFG" ]] && break; sleep 0.5; done
test -f "$B_CFG" && ok "child config written by the daemon" || bad "no child config at $B_CFG (daemon: $(grep -F create-node /tmp/daemon-cncc.log | tail -2))"
echo "    config: $(jq -c 'del(.token)' "$B_CFG" 2>/dev/null)"
[[ "$(jq -r '.codexCopresence // "absent"' "$B_CFG" 2>/dev/null)" == true ]] \
  && ok "config has codexCopresence:true → plain \`anet node start\` brings up the shared TUI" \
  || bad "config lacks codexCopresence:true"
[[ "$(jq -r '.flags.copresence // "absent"' "$B_CFG" 2>/dev/null)" == absent ]] \
  && ok "the create-time switch is not left behind in config.flags" || bad "config.flags still carries copresence"
[[ "$(jq -r '.flags.permissionMode // empty' "$B_CFG" 2>/dev/null)" == default ]] \
  && ok "other flags preserved" || bad "other flags lost: $(jq -c .flags "$B_CFG" 2>/dev/null)"
B_STATUS=$(wait_req_settled "$B_REQ")
echo "    request status: $B_STATUS error: $(req_error "$B_REQ")"
B_HEADLESS=""
for _ in $(seq 1 10); do B_HEADLESS="$B_HEADLESS$(headless_pids "$B")"; sleep 0.5; done
[[ -z "$B_HEADLESS" ]] && ok "daemon's start never brought up a headless agent-node for $B" \
  || bad "daemon started $B HEADLESS (pid $B_HEADLESS)"
# 前台跑同一条 `anet node start`(daemon 起的那条 stdio 被丢弃)。
B_OUT=$(cd "$DAEMON_DIR" && timeout 30 anet node start "$B" </dev/null 2>&1); B_RC=$?
echo "    foreground start rc=$B_RC:"; printf '%s\n' "$B_OUT" | sed -n '1,12p' | sed 's/^/      /'
if printf '%s' "$B_OUT" | grep -Fq "needs" && printf '%s' "$B_OUT" | grep -Fq "tmux"; then
  ok "plain \`anet node start\` ran the co-presence preflight (asks for tmux/codex) — not headless"
else
  bad "plain \`anet node start\` did not take the co-presence path"
fi
[[ -z "$(headless_pids "$B")" ]] && ok "still no headless agent-node for $B" || bad "headless agent-node appeared for $B"

# ── C. copresence on a runtime that has no codex co-presence → hub refuses ─
note "C. flags.copresence on a non-codex runtime"
R=$(mcp_call "$UTOK" "$(create_body cc-sdk claude-agent-sdk '{"copresence":true}' claude-opus-original)")
E=$(printf '%s' "$R" | jq -r '.error // empty' 2>/dev/null)
[[ "$E" == flag_not_applicable_to_runtime ]] && ok "rejected at hub: $E" || bad "non-codex copresence: $R"
[[ "$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM node_create_requests WHERE child_name='cc-sdk';")" == 0 ]] \
  && ok "no request row written" || bad "request row written for a rejected spec"

# ── D. wrong type ──────────────────────────────────────────────────────
note "D. flags.copresence must be boolean"
R=$(mcp_call "$UTOK" "$(create_body cc-str codex-app-server '{"copresence":"yes"}')")
E=$(printf '%s' "$R" | jq -r '.error // empty' 2>/dev/null)
[[ "$E" == flag_value_invalid ]] && ok "rejected at hub: $E" || bad "string copresence: $R"

printf "\n==== qa-create-node-codex-copresence: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "── daemon log (tail) ──"; tail -60 /tmp/daemon-cncc.log
  exit 1
fi
exit 0
