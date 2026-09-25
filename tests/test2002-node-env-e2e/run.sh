#!/usr/bin/env bash
# test2002 — 节点环境变量端到端:一次性 hub + `anet node start`(真 exit-75 监督进程)
# 拉起的真 agent-node + 桌面端同款 tools/call。验单测验不了的那几条:
#   - set 落到节点自己的 config.json(0600,有 .prev),hub 库里 ack 之后没有值
#   - restart_node 之后**进程真的看见了**:节点回报 in_effect=true + 长度,
#     且 /proc/<pid>/environ 里有这个键(只比哈希,不打印值)
#   - 改一个启动时就有的键,重启后生效(启动器 exit-75 重读配置,profile-env-refresh.ts)
#   - unset 之后重启,进程里没有这个键
#   - 传输闸:调用方经「中继」(Host 不是回环)→ insecure_transport leg=client;
#     节点经「中继」连 hub → leg=node;回环 hop 上 X-Forwarded-Proto: https → 放行
#   - 值不在 hub 库 / hub 日志 / 启动器日志 / 节点日志里
#   - witnessed-red:关掉启动器的重读,「改已有键」那一步必须红
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/test2002}"
PORT="${PORT:-9762}"
RELAY_PORT="${RELAY_PORT:-9763}"
BASE="http://127.0.0.1:$PORT"
ALIAS="env-node"
RELAYED_ALIAS="env-node-relayed"
ADMIN="node_env_admin"
PASSWORD="Node-Env-Strong-1!"
# 一个不可能偶然出现在任何地方的值。
SECRET="sk-TEST2002-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')-SECRET"
SECRET_SHA=$(printf '%s' "$SECRET" | sha256sum | cut -c1-64)
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

test "${TEST2002_SOURCE_COMMIT:-unknown}" != unknown
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj" "$WORK/bin" "$WORK/relayed"
export HOME="$WORK/home"

HUB_PID="" LAUNCHER_PID="" RELAY_PID="" RELAYED_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
LAUNCHER_SRC="$REPO/agent-network/bin/cli.ts"
cleanup() {
  stop_group "$LAUNCHER_PID" || true
  stop_group "$RELAYED_PID" || true
  stop_group "$RELAY_PID" || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$LAUNCHER_SRC"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok "throwaway hub booted on 127.0.0.1:$PORT (HOME=$HOME)"

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test2002@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
mint() {
  curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$1\",\"node_id\":\"$2\"}" | jq -r '.token // empty'
}
NODE_ID="node_t2002_$(date +%s%N | sha256sum | head -c 12)"
RELAYED_ID="node_t2002r_$(date +%s%N | sha256sum | head -c 12)"
NTOK=$(mint "$ALIAS" "$NODE_ID"); [[ "$NTOK" == ntok_* ]] || fail 'node token mint'
RTOK=$(mint "$RELAYED_ALIAS" "$RELAYED_ID"); [[ "$RTOK" == ntok_* ]] || fail 'relayed node token mint'
ok 'admin + two network-scoped node tokens'

# ── 节点:`anet node start` 的 profile 布局(.anet/nodes/<id>/config.json,0600)──
NODE_DIR="$WORK/proj/.anet/nodes/$ALIAS"
CFG="$NODE_DIR/config.json"
mkdir -p "$NODE_DIR"
( umask 077; cat >"$CFG" <<JSON
{"alias":"$ALIAS","node_name":"$ALIAS","node_id":"$NODE_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET","env":{"PRE_EXISTING":"one"}}
JSON
)
# agent-node 从这棵树的源码跑(PATH 上的 shim;启动器找不到旁边的包就用 PATH)。
cat >"$WORK/bin/agent-node" <<SH
#!/usr/bin/env bash
exec bun "$REPO/agent-node/src/cli.ts" "\$@"
SH
chmod +x "$WORK/bin/agent-node"

start_launcher() {
  (cd "$WORK/proj" && exec setsid env HOME="$HOME" PATH="$WORK/bin:$PATH" ANTHROPIC_API_KEY=test2002-not-used \
    bun "$LAUNCHER_SRC" node start "$ALIAS" >>"$WORK/launcher.log" 2>&1 </dev/null) &
  LAUNCHER_PID=$!
}
child_pid() { cat "$NODE_DIR/.pid" 2>/dev/null || true; }

# 桌面端同款 tools/call。第 3 个参数可以追加 curl 头(模拟经中继 / 经 TLS 代理)。
mcp_call() {
  local name="$1" args_json="$2" body raw data
  shift 2
  body=$(jq -nc --arg n "$name" --argjson a "$args_json" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw=$(curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' "$@" -d "$body")
  data=$(sed -n 's/^data: //p' <<<"$raw" | head -1)
  [[ -z "$data" ]] && data="$raw"
  jq -r '.result.content[0].text // empty' <<<"$data"
}
status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$1" '.sessions[]? | select(.alias==$a)'
}
wait_registered() {
  local alias="$1"
  for _ in $(seq 1 240); do
    local row; row=$(status_row "$alias" || true)
    if [[ -n "$row" ]] && jq -e '.env_capable==true' >/dev/null <<<"$row"; then return 0; fi
    sleep 0.25
  done
  return 1
}
wait_result() {
  local rid="$1" res status
  for _ in $(seq 1 120); do
    res=$(mcp_call get_rules_file_result "$(jq -nc --arg r "$rid" --arg n "$NET" '{request_id:$r,network_id:$n}')")
    status=$(jq -r '.status // empty' <<<"$res")
    case "$status" in done|failed|timeout) printf '%s\n' "$res"; return 0 ;; esac
    sleep 0.25
  done
  printf '%s\n' "$res"; return 1
}
dump_diag() {
  echo "---- launcher.log (tail 60) ----" >&2; tail -60 "$WORK/launcher.log" >&2 || true
  echo "---- hub.log (tail 30) ----" >&2; tail -30 "$WORK/hub.log" >&2 || true
}
ARGS=$(jq -nc --arg id "$NODE_ID" --arg n "$NET" '{node_id:$id,network_id:$n}')
env_list() {
  local enq rid
  enq=$(mcp_call list_node_env "$ARGS" "$@")
  rid=$(jq -r '.request_id // empty' <<<"$enq"); [[ "$rid" == rf_* ]] || fail "list enqueue: $enq"
  wait_result "$rid" || fail "list never terminal"
}
env_set() {
  local key="$1" value="$2" enq rid
  enq=$(mcp_call set_node_env "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --arg k "$key" --arg v "$value" '{node_id:$id,network_id:$n,key:$k,value:$v}')")
  rid=$(jq -r '.request_id // empty' <<<"$enq"); [[ "$rid" == rf_* ]] || fail "set enqueue: $enq"
  wait_result "$rid" || fail "set never terminal"
}
env_unset() {
  local enq rid
  enq=$(mcp_call unset_node_env "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --arg k "$1" '{node_id:$id,network_id:$n,key:$k}')")
  rid=$(jq -r '.request_id // empty' <<<"$enq"); [[ "$rid" == rf_* ]] || fail "unset enqueue: $enq"
  wait_result "$rid" || fail "unset never terminal"
}
key_row() { jq -c --arg k "$2" '.content | fromjson | .keys[] | select(.key==$k)' <<<"$1"; }
restart_and_wait() {
  local before after upd
  before=$(child_pid)
  upd=$(mcp_call restart_node "$ARGS")
  jq -e '.ok==true' >/dev/null <<<"$upd" || fail "restart_node: $upd"
  for _ in $(seq 1 240); do
    after=$(child_pid)
    if [[ -n "$after" && "$after" != "$before" && -e "/proc/$after" ]]; then break; fi
    sleep 0.25
  done
  [[ -n "$after" && "$after" != "$before" ]] || { dump_diag; fail "node did not respawn after restart_node (pid $before)"; }
  # 新进程重新上报之后再问(env 请求要它来拉)。
  sleep 2
  wait_registered "$ALIAS" || { dump_diag; fail 'node did not re-register after restart'; }
}
# /proc/<pid>/environ 里这个键的值的哈希(不打印值)。没有这个键 → 空。
proc_env_sha() {
  local pid="$1" key="$2"
  tr '\0' '\n' <"/proc/$pid/environ" | sed -n "s/^$key=//p" | head -n1 | tr -d '\n' | { v=$(cat); [[ -n "$v" ]] && printf '%s' "$v" | sha256sum | cut -c1-64 || true; }
}

start_launcher
wait_registered "$ALIAS" || { dump_diag; fail 'node never registered with env_capable'; }
[[ -n "$(child_pid)" ]] || { dump_diag; fail 'launcher wrote no .pid'; }
ok "anet node start → agent-node registered with env_capable (pid $(child_pid))"

# ── 1. list:只有键和元数据;本机回环连接 → write_allowed ──
ENQ=$(mcp_call list_node_env "$ARGS")
jq -e '.ok==true and .write_allowed==true' >/dev/null <<<"$ENQ" || fail "list over loopback should allow writes: $ENQ"
RES=$(wait_result "$(jq -r .request_id <<<"$ENQ")") || fail "first list: $RES"
jq -e '.status=="done" and (.content|fromjson|.restart=="remote")' >/dev/null <<<"$RES" || fail "list result: $RES"
[[ "$(key_row "$RES" PRE_EXISTING)" == '{"key":"PRE_EXISTING","set":true,"length":3,"in_effect":true,"kind":"plain"}' ]] || fail "PRE_EXISTING row: $(key_row "$RES" PRE_EXISTING)"
ok 'list: keys + metadata only, restart=remote (under the exit-75 supervisor), PRE_EXISTING in effect'

# ── 2. set 一个新键:落到 config.json(0600 + .prev);ack 之后 hub 库里没有值 ──
RES=$(env_set E2E_TOKEN "$SECRET")
jq -e --argjson n "${#SECRET}" '.status=="done" and (.content|fromjson|.key=="E2E_TOKEN" and .length==$n and .requires_restart==true and .restart=="remote")' >/dev/null <<<"$RES" || fail "set result: $RES"
grep -Fq "$SECRET" "$CFG" || fail 'value not written to the node config.json'
[[ "$(stat -c %a "$CFG")" == 600 ]] || fail "config.json mode $(stat -c %a "$CFG")"
[[ -f "$CFG.prev" ]] && ! grep -Fq "$SECRET" "$CFG.prev" || fail '.prev backup missing or already holds the new value'
jq -e '.token and .node_id and .env.PRE_EXISTING=="one"' "$CFG" >/dev/null || fail 'set clobbered other config fields'
db_has_secret() { (cd "$REPO/server" && bun -e "const {Database}=require('bun:sqlite');const db=new Database(process.argv[1],{readonly:true});let hit=[];for(const {name} of db.query(\"SELECT name FROM sqlite_master WHERE type='table'\").all()){for(const r of db.query('SELECT * FROM \"'+name+'\"').all()){if(JSON.stringify(r).includes(process.argv[2]))hit.push(name)}}console.log(hit.join(','))" "$WORK/hub.db" "$SECRET"); }
[[ -z "$(db_has_secret)" ]] || fail "value still in hub DB tables: $(db_has_secret)"
ok 'set: written to the node config.json (0600, .prev kept, other fields intact); hub DB holds no value after the ack'

RES=$(env_list)
jq -e '.content|fromjson|.keys[]|select(.key=="E2E_TOKEN")|.in_effect==false' >/dev/null <<<"$RES" || fail "before restart E2E_TOKEN should not be in effect: $RES"
ok 'before restart: E2E_TOKEN listed with in_effect=false (needs restart)'

# ── 3. 改一个启动时就有的键,重启 ──
RES=$(env_set PRE_EXISTING "two-changed")
jq -e '.status=="done"' >/dev/null <<<"$RES" || fail "change PRE_EXISTING: $RES"
restart_and_wait
PID=$(child_pid)
RES=$(env_list)
jq -e --argjson n "${#SECRET}" '.content|fromjson|.keys[]|select(.key=="E2E_TOKEN")|(.in_effect==true and .length==$n)' >/dev/null <<<"$RES" || fail "after restart E2E_TOKEN should be in effect: $RES"
[[ "$(proc_env_sha "$PID" E2E_TOKEN)" == "$SECRET_SHA" ]] || fail "E2E_TOKEN not in /proc/$PID/environ with the set value"
ok "after restart_node: node reports E2E_TOKEN in_effect=true length=${#SECRET}; /proc/$PID/environ has it (sha matches)"
jq -e '.content|fromjson|.keys[]|select(.key=="PRE_EXISTING")|(.in_effect==true and .length==11)' >/dev/null <<<"$RES" || fail "changed PRE_EXISTING not in effect after restart: $(key_row "$RES" PRE_EXISTING)"
ok 'a key that existed at launch takes its NEW value after restart (launcher re-reads the config on exit 75)'

# ── 4. unset + 重启:进程里没有这个键 ──
RES=$(env_unset E2E_TOKEN)
jq -e '.status=="done" and (.content|fromjson|.existed==true)' >/dev/null <<<"$RES" || fail "unset: $RES"
! grep -Fq E2E_TOKEN "$CFG" || fail 'E2E_TOKEN still in config.json after unset'
restart_and_wait
PID=$(child_pid)
RES=$(env_list)
! jq -e '.content|fromjson|.keys[]|select(.key=="E2E_TOKEN")' >/dev/null <<<"$RES" || fail "E2E_TOKEN still listed after unset"
[[ -z "$(proc_env_sha "$PID" E2E_TOKEN)" ]] || fail "E2E_TOKEN still in /proc/$PID/environ after unset + restart"
ok 'unset + restart: key gone from config and from the new process environment'

# ── 5. 传输闸:调用方这一段 ──
SET_ARGS=$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --arg v "$SECRET" '{node_id:$id,network_id:$n,key:"GATE_KEY",value:$v}')
R=$(mcp_call set_node_env "$SET_ARGS" -H 'Host: relay.example.invalid:9300')
jq -e '.ok==false and .error=="insecure_transport" and .leg=="client"' >/dev/null <<<"$R" || fail "relayed caller should be refused: $R"
! grep -Fq "$SECRET" <<<"$R" || fail 'refusal echoed the value'
R=$(mcp_call list_node_env "$ARGS" -H 'Host: relay.example.invalid:9300')
jq -e '.ok==true and .write_allowed==false and .write_blocked.leg=="client"' >/dev/null <<<"$R" || fail "relayed list should say writes blocked: $R"
wait_result "$(jq -r .request_id <<<"$R")" >/dev/null || true
R=$(mcp_call set_node_env "$SET_ARGS" -H 'Host: relay.example.invalid:9443' -H 'X-Forwarded-Proto: https')
jq -e '.ok==true' >/dev/null <<<"$R" || fail "TLS-terminated hop (X-Forwarded-Proto: https on loopback) should be allowed: $R"
wait_result "$(jq -r .request_id <<<"$R")" >/dev/null || fail 'GATE_KEY set never terminal'
ok 'client leg: relayed (non-loopback Host) → insecure_transport leg=client; list says write_allowed=false; X-Forwarded-Proto: https on the loopback hop → allowed'

# ── 6. 传输闸:节点这一段(节点经「中继」连 hub:对端 127.0.0.1,Host 是中继)──
cat >"$WORK/relay.ts" <<'TS'
const [listen, upstream, host] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
Bun.serve({ hostname: "127.0.0.1", port: listen, idleTimeout: 0, async fetch(req) {
  const u = new URL(req.url);
  const h = new Headers(req.headers); h.set("host", host);
  return fetch(`${upstream}${u.pathname}${u.search}`, { method: req.method, headers: h, body: req.body, redirect: "manual", decompress: false } as any);
} });
TS
(exec setsid bun "$WORK/relay.ts" "$RELAY_PORT" "$BASE" "relay.example.invalid:9300" >"$WORK/relay.log" 2>&1) &
RELAY_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$RELAY_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
( umask 077; cat >"$WORK/relayed/config.json" <<JSON
{"alias":"$RELAYED_ALIAS","node_id":"$RELAYED_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"http://127.0.0.1:$RELAY_PORT","token":"$RTOK","network_id":"$NET","env":{}}
JSON
)
(cd "$WORK/relayed" && exec setsid env HOME="$HOME" ANTHROPIC_API_KEY=test2002-not-used \
  bun "$REPO/agent-node/src/cli.ts" --alias "$RELAYED_ALIAS" --config "$WORK/relayed/config.json" >"$WORK/relayed.log" 2>&1) &
RELAYED_PID=$!
wait_registered "$RELAYED_ALIAS" || { tail -40 "$WORK/relayed.log" >&2; fail 'relayed node never registered'; }
RARGS=$(jq -nc --arg id "$RELAYED_ID" --arg n "$NET" '{node_id:$id,network_id:$n}')
R=$(mcp_call set_node_env "$(jq -c --arg v "$SECRET" '. + {key:"GATE_KEY",value:$v}' <<<"$RARGS")")
jq -e '.ok==false and .error=="insecure_transport" and .leg=="node"' >/dev/null <<<"$R" || fail "relayed node should be refused: $R"
R=$(mcp_call list_node_env "$RARGS")
jq -e '.write_allowed==false and .write_blocked.leg=="node"' >/dev/null <<<"$R" || fail "relayed node list should say writes blocked: $R"
RES=$(wait_result "$(jq -r .request_id <<<"$R")") || fail 'relayed list never terminal'
jq -e '.status=="done" and (.content|fromjson|.restart=="manual")' >/dev/null <<<"$RES" || fail "relayed list result: $RES"
! grep -Fq "$SECRET" "$WORK/relayed/config.json" || fail 'a secret reached the relayed node'
ok 'node leg: a node that reaches the hub through a relay (peer 127.0.0.1, Host = relay) → insecure_transport leg=node; env_list still works there (restart=manual: no supervisor)'

# ── 7. 值不在任何日志里 ──
LOGS=("$WORK/hub.log" "$WORK/launcher.log" "$WORK/relayed.log" "$WORK/relay.log")
while IFS= read -r f; do LOGS+=("$f"); done < <(find "$WORK/proj/.anet" "$WORK/relayed" -path '*logs*' -type f 2>/dev/null)
for f in "${LOGS[@]}"; do ! grep -Fq "$SECRET" "$f" || fail "value found in $f"; done
[[ -z "$(db_has_secret)" ]] || fail "value in hub DB at the end: $(db_has_secret)"
grep -q '\[env\] set E2E_TOKEN length=' "$WORK/launcher.log" "$WORK/proj/.anet/nodes/$ALIAS/logs/"* 2>/dev/null || fail 'node never logged the key-only set line (is the log where we think?)'
ok "value absent from ${#LOGS[@]} log file(s) and the hub DB; the node did log the key-only line"

# ── 8. witnessed-red:关掉启动器 exit-75 重读,「改已有键」必须红 ──
cp "$LAUNCHER_SRC" "$WORK/cli.ts.orig"
grep -Fq 'if (spawnCount++ > 0) refreshSpawnEnv();' "$LAUNCHER_SRC" || fail 'mutation anchor missing'
sed -i 's/if (spawnCount++ > 0) refreshSpawnEnv();/spawnCount++;/' "$LAUNCHER_SRC"
stop_group "$LAUNCHER_PID"; LAUNCHER_PID=""
sleep 1
start_launcher
wait_registered "$ALIAS" || { dump_diag; fail 'mutated launcher: node never registered'; }
RES=$(env_set PRE_EXISTING "three-mutated")
jq -e '.status=="done"' >/dev/null <<<"$RES" || fail "mutated: set: $RES"
restart_and_wait
RES=$(env_list)
cp "$WORK/cli.ts.orig" "$LAUNCHER_SRC"
jq -e '.content|fromjson|.keys[]|select(.key=="PRE_EXISTING")|.in_effect==false' >/dev/null <<<"$RES" \
  || fail "mutation stayed green: PRE_EXISTING in effect even without the launcher refresh: $(key_row "$RES" PRE_EXISTING)"
ok 'witnessed-red: without the exit-75 env refresh, a changed key is NOT in effect after restart (step 3 would fail)'

printf 'source_commit=%s\n' "$TEST2002_SOURCE_COMMIT"
printf 'RESULT: PASS (%s checks)\n' "$PASS"
