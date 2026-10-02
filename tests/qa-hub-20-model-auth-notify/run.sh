#!/usr/bin/env bash
# qa-hub-20-model-auth-notify — 节点模型登录失效 → 通知节点主人一次(#462)。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-hub-20}"
PORT="${PORT:-$((20000 + RANDOM % 9000))}"
[[ "$PORT" != 9200 ]] || PORT=9277
BASE="http://127.0.0.1:$PORT"
PASSWORD="ModelAuth-E2E-Strong-1!"
ALIAS="node-a"
NOTIFY_SRC="$REPO/server/src/model-auth-notify.ts"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; [[ -f "$WORK/hub.log" ]] && tail -40 "$WORK/hub.log" >&2; exit 1; }

test "${QA_HUB_20_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'

HUB_PID=""
stop_hub() {
  [[ -n "$HUB_PID" ]] || return 0
  kill -TERM -- "-$HUB_PID" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$HUB_PID" ]] && break; sleep 0.1; done
  kill -KILL -- "-$HUB_PID" 2>/dev/null || true
  HUB_PID=""
}
cleanup() {
  stop_hub || true
  if [[ -f "$WORK/model-auth-notify.ts.orig" ]]; then cp "$WORK/model-auth-notify.ts.orig" "$NOTIFY_SRC"; fi
}
trap cleanup EXIT

# 每轮一个全新的 HOME + DB:与上一轮没有任何共享状态。
start_hub() {
  local round="$1"
  safe_rm_rf "$WORK/$round"
  mkdir -p "$WORK/$round/home"
  (cd "$REPO/server" && exec setsid env HOME="$WORK/$round/home" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$WORK/$round/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
  HUB_PID=$!
  for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
  curl -fsS "$BASE/health" >/dev/null || fail "hub boot ($round)"
}

register() {
  curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PASSWORD\"}"
}

# MCP tools/call;回包可能是 SSE(data: 行)也可能是 JSON。
mcp_call() {
  local token="$1" name="$2" args="$3" raw line
  raw=$(curl -fsS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$(jq -nc --arg n "$name" --argjson a "$args" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')")
  line=$(grep -m1 '^data: ' <<<"$raw" || true)
  [[ -n "$line" ]] && raw=${line#data: }
  jq -r '.result.content[0].text // empty' <<<"$raw"
}

report() {
  local state="$1" args out
  args=$(jq -nc --arg net "$NET" --arg alias "$ALIAS" --arg s "$state" \
    '{resume_id:"qa20-node-a",alias:$alias,status:"idle",network_id:$net,health:{bridge:"ok",model_auth:$s}}')
  out=$(mcp_call "$NTOK" report_status "$args")
  jq -e '.ok == true' >/dev/null <<<"$out" || fail "report_status $state: $out"
}

# 某个用户收到的、来自 node-a 的登录失效通知条数(走 App 读未读的同一个 REST 口)。
notice_count() {
  local body
  body=$(curl -fsS "$BASE/api/messages?scope=user&network_id=$NET" -H "Authorization: Bearer $1")
  jq -e '.ok == true' >/dev/null <<<"$body" || fail "messages read: $body"
  jq --arg a "$ALIAS" '[.messages[] | select(.kind == "node_model_auth" and .from_session == $a)] | length' <<<"$body"
}

# 一轮:boss(网络 owner)、nora(节点主人,成员)、otto(另一成员);nora 铸 node-a 的节点令牌。
setup_round() {
  start_hub "$1"
  local reg inv
  reg=$(register qa20boss); BOSS=$(jq -r '.token // empty' <<<"$reg"); NET=$(jq -r '.network_id // empty' <<<"$reg")
  [[ "$BOSS" == utok_* && -n "$NET" ]] || fail 'boss registration'
  reg=$(register qa20nora); NORA=$(jq -r '.token // empty' <<<"$reg"); NORA_ID=$(jq -r '.user.user_id // empty' <<<"$reg")
  reg=$(register qa20otto); OTTO=$(jq -r '.token // empty' <<<"$reg"); OTTO_ID=$(jq -r '.user.user_id // empty' <<<"$reg")
  [[ "$NORA" == utok_* && "$OTTO" == utok_* && -n "$NORA_ID" && -n "$OTTO_ID" ]] || fail 'member registration'
  for pair in "$NORA:$NORA_ID" "$OTTO:$OTTO_ID"; do
    local tok=${pair%%:*} uid=${pair#*:}
    inv=$(curl -fsS -X POST "$BASE/api/networks/$NET/invite" -H "Authorization: Bearer $BOSS" -H 'Content-Type: application/json' -d '{"role":"member"}' | jq -r '.invite_code // empty')
    [[ -n "$inv" ]] || fail 'invite'
    curl -fsS -X POST "$BASE/api/networks/join" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
      -d "{\"invite_code\":\"$inv\"}" | jq -e '.ok == true' >/dev/null || fail 'join'
    # 新成员默认只看授权 Agent(不能铸节点令牌);放开成 all。
    curl -fsS -X PUT "$BASE/api/networks/$NET/members/$uid/agent-grants" -H "Authorization: Bearer $BOSS" -H 'Content-Type: application/json' \
      -d '{"agent_access":"all"}' | jq -e '.ok == true' >/dev/null || fail 'agent-grants'
  done
  NTOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $NORA" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"n_qa20_node_a\"}" | jq -r '.token // empty')
  [[ "$NTOK" == ntok_* ]] || fail 'node-token'
}

safe_rm_rf "$WORK"
mkdir -p "$WORK"

# ── 1. 真实链路:ok → expired → expired → ok → expired ────────────────────────
setup_round real
ok "hub booted on :$PORT; owner/member/node token set up"
for s in ok expired expired ok expired; do report "$s"; done
ok 'node reported ok → expired → expired → ok → expired'

n_nora=$(notice_count "$NORA"); n_boss=$(notice_count "$BOSS"); n_otto=$(notice_count "$OTTO")
[[ "$n_nora" == 2 ]] || fail "node owner should get exactly 2 notices, got $n_nora"
ok 'node owner got exactly 2 notices'
[[ "$n_boss" == 0 && "$n_otto" == 0 ]] || fail "others must get none: network owner=$n_boss other member=$n_otto"
ok 'network owner and other member got 0'

body=$(curl -fsS "$BASE/api/messages?scope=user&network_id=$NET" -H "Authorization: Bearer $NORA")
first=$(jq -c --arg a "$ALIAS" '[.messages[] | select(.kind == "node_model_auth" and .from_session == $a)][0]' <<<"$body")
jq -e '.title == "节点登录失效" and .severity == "warning"' >/dev/null <<<"$first" || fail "notice title/severity: $first"
content=$(jq -r '.content' <<<"$first")
for frag in "节点 $ALIAS" "过期" "codex login" "CODEX_HOME=" "不要拷别的节点的 auth.json"; do
  [[ "$content" == *"$frag"* ]] || fail "notice text lacks '$frag': $content"
done
ok 'notice names the node, the cause and the per-node re-login command'
unread=$(jq -r --arg a "$ALIAS" '.unread_by_agent[$a] // 0' <<<"$body")
[[ "$unread" == 2 ]] || fail "unread_by_agent[$ALIAS] should be 2, got $unread"
ok "counted in the owner's unread for $ALIAS (what the app badges)"
stop_hub

# ── 2. witnessed-red:去掉去重,同一序列必须多发 ─────────────────────────────
cp "$NOTIFY_SRC" "$WORK/model-auth-notify.ts.orig"
sed -i 's/if (prev === "notified") return { notify: false, mark: "notified" };/if (false) return { notify: false, mark: "notified" };/' "$NOTIFY_SRC"
cmp -s "$NOTIFY_SRC" "$WORK/model-auth-notify.ts.orig" && fail 'MUTATION_NOOP: dedup line not found'
setup_round mutant
for s in ok expired expired ok expired; do report "$s"; done
n_mut=$(notice_count "$NORA")
[[ "$n_mut" == 3 ]] || fail "witnessed-red: without dedup expected 3 notices, got $n_mut"
ok 'witnessed-red: with dedup removed the same sequence yields 3 (assertion above would go red)'
stop_hub
cp "$WORK/model-auth-notify.ts.orig" "$NOTIFY_SRC"

echo "qa-hub-20-model-auth-notify: PASS=$PASS FAIL=0"
