#!/usr/bin/env bash
# qa-hub-23-node-permissions — 节点自己的权限,第一阶段:先记录、后执行(RFC-041,#487)。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-hub-23}"
PORT="${PORT:-$((20000 + RANDOM % 9000))}"
[[ "$PORT" != 9200 ]] || PORT=9279
BASE="http://127.0.0.1:$PORT"
PASSWORD="NodePerm-E2E-Strong-1!"
NP_SRC="$REPO/server/src/node-permissions.ts"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; [[ -f "$WORK/hub.log" ]] && tail -40 "$WORK/hub.log" >&2; exit 1; }

test "${QA_HUB_23_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'

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
  if [[ -f "$WORK/node-permissions.ts.orig" ]]; then cp "$WORK/node-permissions.ts.orig" "$NP_SRC"; fi
}
trap cleanup EXIT

# 每轮一个全新的 HOME + DB;$2 = COMMHUB_NODE_PERMISSIONS(空 = 不设,即默认 log)。
start_hub() {
  local round="$1" flag="${2:-}"
  safe_rm_rf "$WORK/$round"
  mkdir -p "$WORK/$round/home"
  (cd "$REPO/server" && exec setsid env HOME="$WORK/$round/home" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$WORK/$round/hub.db" ${flag:+COMMHUB_NODE_PERMISSIONS=$flag} \
    bun run src/index.ts >"$WORK/hub.log" 2>&1) &
  HUB_PID=$!
  for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
  curl -fsS "$BASE/health" >/dev/null || fail "hub boot ($round)"
}

register() {
  curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PASSWORD\"}"
}

# 不带 -f:403 / 404 的正文也要读。输出「状态码<TAB>正文」。
api() { # method path token [body]
  local out
  if [[ $# -ge 4 ]]; then
    out=$(curl -sS -w '\t%{http_code}' -X "$1" "$BASE$2" -H "Authorization: Bearer $3" -H 'Content-Type: application/json' -d "$4")
  else
    out=$(curl -sS -w '\t%{http_code}' -X "$1" "$BASE$2" -H "Authorization: Bearer $3")
  fi
  printf '%s\t%s\n' "${out##*$'\t'}" "${out%$'\t'*}"
}
status_of() { cut -f1 <<<"$1"; }
body_of() { cut -f2- <<<"$1"; }

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

# boss(网络 owner)给三个节点铸令牌:node-a 正常、node-r 受限、node-o 只读;node-x 作被操作的「别的节点」。
setup_round() {
  start_hub "$1" "${2:-}"
  local reg r
  reg=$(register qa23boss); BOSS=$(jq -r '.token // empty' <<<"$reg"); NET=$(jq -r '.network_id // empty' <<<"$reg")
  [[ "$BOSS" == utok_* && -n "$NET" ]] || fail 'boss registration'
  for n in a r o x; do
    r=$(body_of "$(api POST /api/auth/node-token "$BOSS" "{\"network_id\":\"$NET\",\"node_name\":\"node-$n\",\"node_id\":\"n_qa23_$n\"}")")
    printf -v "TOK_$n" '%s' "$(jq -r '.token // empty' <<<"$r")"
    local tok_var="TOK_$n"
    [[ "${!tok_var}" == ntok_* ]] || fail "node-token node-$n: $r"
    r=$(mcp_call "${!tok_var}" report_status "$(jq -nc --arg net "$NET" --arg n "$n" '{resume_id:("qa23-"+$n),alias:("node-"+$n),status:"idle",node_id:("n_qa23_"+$n),network_id:$net}')")
    jq -e '.ok == true' >/dev/null <<<"$r" || fail "report_status node-$n: $r"
  done
  CARD_R=$(body_of "$(api POST /api/requirements "$BOSS" "{\"name\":\"for node-r\",\"network_id\":\"$NET\",\"agent_owner\":{\"kind\":\"node\",\"id\":\"n_qa23_r\"}}")" | jq -r '.requirement.id // empty')
  CARD_B=$(body_of "$(api POST /api/requirements "$BOSS" "{\"name\":\"boss only\",\"network_id\":\"$NET\"}")" | jq -r '.requirement.id // empty')
  [[ -n "$CARD_R" && -n "$CARD_B" ]] || fail 'cards'
  [[ $(status_of "$(api PUT /api/nodes/n_qa23_r/permission-mode "$BOSS" '{"mode":"restricted"}')") == 200 ]] || fail 'set restricted'
  [[ $(status_of "$(api PUT /api/nodes/n_qa23_o/permission-mode "$BOSS" '{"mode":"readonly"}')") == 200 ]] || fail 'set readonly'
}
attrs_rev() { body_of "$(api GET "/api/nodes?node_id=$1" "$BOSS")" | jq -r '.nodes[0].attrs_revision // 0'; }

safe_rm_rf "$WORK"
mkdir -p "$WORK"

# ── 1. 默认(log):正常节点只记不拦;显式模式立刻生效 ───────────────────────────
setup_round log
ok "hub booted on :$PORT (COMMHUB_NODE_PERMISSIONS unset = log); node-r restricted, node-o read-only"

res=$(api PUT /api/nodes/n_qa23_x/attrs "$TOK_a" "{\"display_name\":\"renamed by node-a\",\"base_attrs_revision\":$(attrs_rev n_qa23_x)}")
[[ $(status_of "$res") == 200 ]] || fail "log mode must not block node-a editing another node: $res"
ok 'log: a normal node editing another node (human-only) goes through'

res=$(api PATCH "/api/requirements/$CARD_B" "$TOK_o" '{"description":"read-only node writes"}')
[[ $(status_of "$res") == 403 ]] && body_of "$res" | jq -e '.error == "node_permission_denied" and .reason == "mode_readonly" and (.hint|length) > 0' >/dev/null \
  || fail "read-only write: $res"
out=$(mcp_call "$TOK_o" send_task "$(jq -nc '{alias:"node-x",task:"x"}')")
jq -e '.reason == "mode_readonly"' >/dev/null <<<"$out" || fail "read-only dispatch: $out"
out=$(mcp_call "$TOK_o" report_status "$(jq -nc --arg net "$NET" '{resume_id:"qa23-o",alias:"node-o",status:"idle",network_id:$net}')")
jq -e '.ok == true' >/dev/null <<<"$out" || fail "read-only heartbeat: $out"
ok 'read-only (explicit mode): write and dispatch refused with reason + hint; heartbeat works'

list=$(body_of "$(api GET "/api/requirements?network_id=$NET" "$TOK_r")")
jq -e --arg a "$CARD_R" '[.requirements[].id] == [$a]' >/dev/null <<<"$list" || fail "restricted list: $(jq -c '[.requirements[].id]' <<<"$list")"
[[ $(status_of "$(api PATCH "/api/requirements/$CARD_R" "$TOK_r" '{"column":"doing"}')") == 200 ]] || fail 'restricted edit of its own card'
[[ $(status_of "$(api GET "/api/requirements/$CARD_B" "$TOK_r")") == 404 ]] || fail 'restricted must not see an unassigned card'
out=$(mcp_call "$TOK_r" broadcast "$(jq -nc '{message:"hi"}')")
jq -e '.reason == "mode_restricted_not_assigned"' >/dev/null <<<"$out" || fail "restricted broadcast: $out"
ok 'restricted (explicit mode): sees/edits only its assigned card; broadcast refused'

report=$(api GET "/api/networks/$NET/node-permission-report" "$BOSS")
[[ $(status_of "$report") == 200 ]] || fail "report: $report"
body_of "$report" | jq -e '.mode == "log" and ([.nodes[] | select(.node_id == "n_qa23_a") | .by_reason.human_only][0] >= 1) and ([.nodes[] | select(.node_id == "n_qa23_o") | .by_reason.mode_readonly][0] >= 2)' >/dev/null \
  || fail "report contents: $(body_of "$report")"
[[ $(status_of "$(api GET "/api/networks/$NET/node-permission-report" "$TOK_a")") == 403 ]] || fail 'node token must not read the report'
ok 'report: owner sees would-have-blocked counts per node and reason; node token refused'
stop_hub

# ── 2. enforce:同一个只有人能做的写被拒 ─────────────────────────────────────────
setup_round enforce enforce
res=$(api PUT /api/nodes/n_qa23_x/attrs "$TOK_a" "{\"display_name\":\"nope\",\"base_attrs_revision\":$(attrs_rev n_qa23_x)}")
[[ $(status_of "$res") == 403 ]] && body_of "$res" | jq -e '.reason == "human_only"' >/dev/null || fail "enforce human-only: $res"
[[ $(status_of "$(api PUT /api/nodes/n_qa23_a/attrs "$TOK_a" "{\"display_name\":\"me\",\"base_attrs_revision\":$(attrs_rev n_qa23_a)}")") == 200 ]] || fail 'a node may still edit its own attrs'
out=$(mcp_call "$TOK_a" send_task "$(jq -nc '{alias:"node-x",task:"still allowed"}')")
jq -e '.ok == true' >/dev/null <<<"$out" || fail "enforce: owner-granted dispatch: $out"
ok 'enforce: human-only write refused (human_only); own attrs and normal dispatch still allowed'
stop_hub

# ── 3. witnessed-red:判定永远放行时,只读节点的写会穿过去 ───────────────────────
cp "$NP_SRC" "$WORK/node-permissions.ts.orig"
sed -i 's/  return explicit || flag === "enforce";/  return false;/' "$NP_SRC"
cmp -s "$NP_SRC" "$WORK/node-permissions.ts.orig" && fail 'MUTATION_NOOP: nodeDecide return not found'
setup_round mutant
res=$(api PATCH "/api/requirements/$CARD_B" "$TOK_o" '{"description":"read-only node writes"}')
[[ $(status_of "$res") == 200 ]] || fail "witnessed-red: with the decision forced to allow, the read-only write should pass, got $res"
ok 'witnessed-red: with nodeDecide forced to allow, the read-only node write goes through (step 1 would be red)'
stop_hub
cp "$WORK/node-permissions.ts.orig" "$NP_SRC"

echo "qa-hub-23-node-permissions: PASS=$PASS FAIL=0"
