#!/usr/bin/env bash
# #605 —— create_node 的 flags.timeout 单位对不上。
#
# 链路:create_node(node_spec.flags.timeout)→ hub validateFlagValue → daemon validateFlagValueDaemon
# → daemon 把 flags 原样写进子节点 config.json → agent-node 按**毫秒**读 flags.timeout
# (cli.ts currentClaudeTimeoutMs / currentCodexTimeoutMs → util/timeout.ts resolveTimeoutMs,
#  runtime/opencode-timeout.ts;默认 300000)。
# 修之前 hub 和 daemon 只收 1..86400(看起来是「秒」):填 600 想要 10 分钟的人拿到 0.6 秒,
# 每个任务都超时;而真正的毫秒值(600000 = 10 分钟)被 hub 拒掉。
#
# 修之后的契约(与 update_node_config / agent-node config-apply 同一把尺子):
#   flags.timeout 是整数毫秒,0(不设上限)或 1000..3600000。
#   1..999 拒绝并说明「单位是毫秒」—— 旧客户端按秒发的小数值分辨不出意图,不偷偷乘 1000,
#   但也绝不再让人悄悄拿到亚秒超时。
#
# 本套件量的(真 hub + 真 `anet daemon up` + 真 create_node):
#   A  timeout=600     → hub 拒(flag_value_invalid,原因里写毫秒),不落请求行
#   B  timeout=600000  → hub 收、daemon 写进子节点 config,agent-node 的解析器读成 600000ms
#   C  timeout=0       → 收(= 不设上限,与 update_node_config 一致)
#   D  timeout=3600001 → 拒(上限与 update_node_config 一致)
#
# 全程在容器里:HOME=$(mktemp -d),hub 在非 9200 端口。
set -uo pipefail
# Exercise Codex behavior, not host resource admission (covered by test612).
# Shared CI runner load/memory must not delay the fixture's app-server startup.
export ANET_START_MEM_GATE=0

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub and kills pids; run it in its container." >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_COMMIT=${CNTM_SOURCE_COMMIT:-}
RUNSH_BLOB=${CNTM_RUNSH_BLOB:-}
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: CNTM_SOURCE_COMMIT must be one full lowercase Git SHA (got '${SOURCE_COMMIT:-unset}')" >&2
  echo "      build with: --build-arg SOURCE_COMMIT=\$(git rev-parse HEAD) --build-arg RUNSH_BLOB=\$(git rev-parse HEAD:tests/qa-create-node-timeout-ms/run.sh)" >&2
  exit 1
fi
_self="$SCRIPT_DIR/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
if [[ "$_actual" != "$RUNSH_BLOB" ]]; then
  echo "FAIL: run.sh in the image is not the one SOURCE_COMMIT=$SOURCE_COMMIT claims (expected blob $RUNSH_BLOB, actual $_actual)" >&2
  exit 1
fi
echo "provenance: source_commit=$SOURCE_COMMIT run.sh blob=$_actual (verified)"

HUB_PORT=9266
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/qa-cntm-XXXXXX.db)
ADMIN_USER="cntmadmin"
ADMIN_PW="cntm_TestPass_1234!"
DAEMON_NAME="tm-daemon"

export HOME=$(mktemp -d /tmp/qa-cntm-home-XXXXXX)
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
create_body() { # name, flags-json
  local spec
  spec=$(jq -cn --arg n "$1" --argjson f "$2" '{name:$n,runtime:"codex-app-server",flags:$f}')
  tool_body create_node "$(jq -cn --arg d "$DAEMON_NODE_ID" --arg net "$NET_ID" --argjson s "$spec" '{daemon_node_id:$d,network_id:$net,node_spec:$s}')"
}
rows_for() { sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM node_create_requests WHERE child_name='$1';" 2>/dev/null; }
# What agent-node does with the child config's flags.timeout: the codex lanes call
# resolveTimeoutMs({flagValue: flags.timeout}) (cli.ts currentCodexTimeoutMs); claude's
# currentClaudeTimeoutMs uses the number as-is. Both are milliseconds.
# Stub codex for the #648 create gate. Must stay off the image PATH and off
# the fixed child PATH (dirname(node) + system dirs). `--version` is what
# the gate runs; anything else just stays up so a later exec does not
# instantly look like a missing binary.
plant_codex_off_fixed_path() {
  CODEX_STUB_DIR=/opt/qa-codex/bin
  mkdir -p "$CODEX_STUB_DIR"
  cat > "$CODEX_STUB_DIR/codex" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' "codex-cli 0.0.0"
  exit 0
fi
exec sleep 3600
EOF
  chmod 0755 "$CODEX_STUB_DIR/codex"
  if command -v codex >/dev/null 2>&1; then
    echo "FAIL: codex is on the image PATH ($CODEX_STUB_DIR must stay off it)" >&2
    exit 1
  fi
  local d node_dir
  node_dir=$(dirname "$(command -v node)")
  for d in "$node_dir" /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
    if [[ -e "$d/codex" ]]; then
      echo "FAIL: codex is inside the fixed child PATH ($d)" >&2
      exit 1
    fi
  done
  "$CODEX_STUB_DIR/codex" --version >/dev/null
}

agent_node_resolves() {   # cfg path → "<valueMs> <source>"
  (cd /app/agent-node && bun -e '
    import { resolveTimeoutMs } from "./src/util/timeout.ts";
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = resolveTimeoutMs({ envValue: undefined, flagValue: cfg.flags?.timeout, defaultMs: 300_000 });
    console.log(`${r.valueMs} ${r.source}`);
  ' "$1")
}

cleanup() {
  local p
  for p in $(pgrep -f "agent-node" 2>/dev/null); do kill "$p" 2>/dev/null; done
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  [[ -n "${PAIR_REG_PID:-}" ]] && kill "$PAIR_REG_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 0. hub + daemon ───────────────────────────────────────────────────
note "0. isolated hub :$HUB_PORT + daemon init, daemonExtraPath, start (HOME=$HOME)"
[[ "$HUB_PORT" != 9200 ]] && ok "hub port is not 9200" || { bad "refusing to use 9200"; exit 1; }
# Same reason as qa-create-node-codex-copresence: the daemon's headless start resolves
# agent-node as the exact release pair via npx; serve this build's tarball for @sleep2agi.
PAIR_REG_PORT=9267
python3 "$SCRIPT_DIR/paired-registry.py" \
  "$(ls /app/agent-node/sleep2agi-agent-node-*.tgz)" "$PAIR_REG_PORT" >/tmp/pair-registry.log 2>&1 &
PAIR_REG_PID=$!
printf '@sleep2agi:registry=http://127.0.0.1:%s/\n' "$PAIR_REG_PORT" > "$HOME/.npmrc"
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PAIR_REG_PORT/@sleep2agi%2fagent-node" >/dev/null 2>&1 && break; sleep 0.25; done
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-cntm.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-cntm.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"cntm@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network = $NET_ID" || { bad "no network"; exit 1; }

mkdir -p "$HOME/.anet" "$DAEMON_DIR"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
# #648 — this image never installed codex (it copied the co-presence image,
# which omits it on purpose). The create gate now refuses codex-app-server
# before spawn when the CLI is missing. Plant a stub outside the fixed
# child PATH and name that directory in the daemon config. Do not put the
# stub on PATH, and do not weaken the refusal.
plant_codex_off_fixed_path
ok "codex stub is off PATH at $CODEX_STUB_DIR"
(cd "$DAEMON_DIR" && anet daemon init "$DAEMON_NAME") >/tmp/daemon-cntm-init.log 2>&1
[[ $? -eq 0 ]] && ok "daemon init wrote config before start" || { bad "daemon init failed"; tail -40 /tmp/daemon-cntm-init.log; exit 1; }
DAEMON_CFG="$DAEMON_DIR/.anet/nodes/$DAEMON_NAME/config.json"
[[ -f "$DAEMON_CFG" ]] || { bad "daemon config missing at $DAEMON_CFG"; exit 1; }
_cfg_tmp=$(mktemp)
jq --arg d "$CODEX_STUB_DIR" '.daemonExtraPath = [$d]' "$DAEMON_CFG" > "$_cfg_tmp"
mv "$_cfg_tmp" "$DAEMON_CFG"
chmod 600 "$DAEMON_CFG"
jq -e --arg d "$CODEX_STUB_DIR" '.daemonExtraPath == [$d] and (.token|type=="string") and (.token|length>0)' "$DAEMON_CFG" >/dev/null \
  && ok "daemon config.json daemonExtraPath=[$CODEX_STUB_DIR]" \
  || { bad "daemonExtraPath was not written"; exit 1; }
(cd "$DAEMON_DIR" && exec anet daemon start "$DAEMON_NAME") >/tmp/daemon-cntm.log 2>&1 &
DAEMON_PID=$!

DAEMON_NODE_ID=""
for _ in $(seq 1 60); do
  HS=$(curl -sS "$HUB_BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
  DAEMON_NODE_ID=$(printf '%s' "$HS" | jq -r --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .daemon_node_id' 2>/dev/null)
  [[ -n "$DAEMON_NODE_ID" ]] && break
  sleep 1
done
[[ -n "$DAEMON_NODE_ID" ]] && ok "daemon listed by /api/host-supervisors ($DAEMON_NODE_ID)" \
  || { bad "daemon never listed"; tail -40 /tmp/daemon-cntm.log; exit 1; }
sleep 4   # past the daemon's boot children-map rebuild

# ── A. 600 (someone meaning "10 minutes" in seconds) ───────────────────
note "A. flags.timeout=600 — the seconds-shaped value"
A=tm-secs
A_CFG="$DAEMON_DIR/.anet/nodes/$A/config.json"
R=$(mcp_call "$UTOK" "$(create_body "$A" '{"timeout":600}')")
echo "    create_node → $R"
E=$(printf '%s' "$R" | jq -r '.error // empty' 2>/dev/null)
REASON=$(printf '%s' "$R" | jq -r '.reason // empty' 2>/dev/null)
[[ "$E" == flag_value_invalid ]] && ok "hub rejects 600 (flag_value_invalid)" || bad "hub accepted timeout=600 (error='${E}')"
printf '%s' "$REASON" | grep -qi "millisecond" && ok "the reason says the unit is milliseconds: $REASON" \
  || bad "reason does not tell the caller the unit is milliseconds: '${REASON}'"
[[ "$(rows_for "$A")" == 0 ]] && ok "no request row written" || bad "request row written for timeout=600"
sleep 3
if [[ -f "$A_CFG" ]]; then
  bad "daemon wrote a child config with flags.timeout=$(jq -r '.flags.timeout' "$A_CFG") — agent-node reads it as: $(agent_node_resolves "$A_CFG") (ms)"
else
  ok "no child config written for $A"
fi

# ── B. 600000 (10 minutes in the unit agent-node reads) ────────────────
note "B. flags.timeout=600000 — ten minutes in milliseconds"
B=tm-ms
B_CFG="$DAEMON_DIR/.anet/nodes/$B/config.json"
R=$(mcp_call "$UTOK" "$(create_body "$B" '{"timeout":600000}')")
echo "    create_node → $R"
B_REQ=$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)
[[ "$B_REQ" == cr_* ]] && ok "hub accepts 600000 and dispatches ($B_REQ)" || bad "hub refused timeout=600000: $R"
for _ in $(seq 1 40); do [[ -f "$B_CFG" ]] && break; sleep 0.5; done
if [[ -f "$B_CFG" ]]; then
  echo "    config: $(jq -c 'del(.token)' "$B_CFG")"
  [[ "$(jq -r '.flags.timeout' "$B_CFG")" == 600000 ]] && ok "child config flags.timeout=600000" \
    || bad "child config flags.timeout=$(jq -r '.flags.timeout' "$B_CFG")"
  RES=$(agent_node_resolves "$B_CFG")
  [[ "$RES" == "600000 flag" ]] && ok "agent-node resolves it to 600000 ms (10 min) from flags.timeout" \
    || bad "agent-node resolves: $RES"
else
  bad "no child config at $B_CFG (daemon: $(grep -F create-node /tmp/daemon-cntm.log | tail -2))"
fi

# ── C. 0 = no deadline (what update_node_config and agent-node already accept) ──
note "C. flags.timeout=0 — no deadline"
R=$(mcp_call "$UTOK" "$(create_body tm-zero '{"timeout":0}')")
echo "    create_node → $R"
[[ "$(printf '%s' "$R" | jq -r '.request_id // empty' 2>/dev/null)" == cr_* ]] \
  && ok "hub accepts 0 (same as update_node_config)" || bad "hub refused timeout=0: $R"

# ── D. above the shared ceiling ────────────────────────────────────────
note "D. flags.timeout=3600001 — above update_node_config's ceiling"
R=$(mcp_call "$UTOK" "$(create_body tm-big '{"timeout":3600001}')")
E=$(printf '%s' "$R" | jq -r '.error // empty' 2>/dev/null)
[[ "$E" == flag_value_invalid ]] && ok "rejected at hub: $E" || bad "timeout=3600001: $R"

printf "\n==== qa-create-node-timeout-ms: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "── daemon log (create-node lines) ──"; grep -F create-node /tmp/daemon-cntm.log | tail -20
  exit 1
fi
exit 0
