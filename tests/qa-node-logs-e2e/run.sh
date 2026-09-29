#!/usr/bin/env bash
# qa-node-logs-e2e — 节点运行日志(tail_node_logs)端到端:真 hub + 真 agent-node。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-node-logs}"
PORT="${PORT:-9766}"
BASE="http://127.0.0.1:$PORT"
ALIAS="logs-e2e-node"
ADMIN="logs_e2e_admin"
OTHER="logs_e2e_other"
PASSWORD="Logs-E2E-Strong-1!"
ENV_SECRET="PLANTEDenvonly0042zz"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

test "${QA_NODE_LOGS_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/node" "$WORK/cwd"
export HOME="$WORK/home"

HUB_PID=""
NODE_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
LOGS_SRC="$REPO/agent-node/src/runtime/node-logs.ts"
cleanup() {
  stop_group "$NODE_PID" || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/node-logs.ts.orig" ]]; then cp "$WORK/node-logs.ts.orig" "$LOGS_SRC"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok 'real Hub booted'

register() {
  curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PASSWORD\",\"email\":\"$1@example.invalid\"}"
}
REG=$(register "$ADMIN")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
REG2=$(register "$OTHER")
UTOK2=$(jq -r '.token // empty' <<<"$REG2")
NET2=$(jq -r '.network_id // empty' <<<"$REG2")
[[ "$UTOK2" == utok_* && -n "$NET2" && "$NET2" != "$NET" ]] || fail 'second user registration (own network)'
NODE_ID="node_qalogs_$(date +%s%N | sha256sum | head -c 12)"
NTOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || fail 'node token mint'
ok 'two users in two networks + a node token'

CFG="$WORK/node/config.json"
cat >"$CFG" <<JSON
{"alias":"$ALIAS","node_id":"$NODE_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET"}
JSON

start_node() {
  NODE_PID=""
  (cd "$WORK/cwd" && exec setsid env ANTHROPIC_API_KEY=qa-node-logs-not-used QA_DEMO_SERVICE_TOKEN="$ENV_SECRET" HOME="$HOME" \
    bun "$REPO/agent-node/src/cli.ts" --alias "$ALIAS" --config "$CFG" >"$WORK/node.log" 2>&1) &
  NODE_PID=$!
}
stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}

mcp_as() {
  local tok="$1" name="$2" args_json="$3" body raw data
  body=$(jq -nc --arg n "$name" --argjson a "$args_json" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw=$(curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' -d "$body")
  data=$(sed -n 's/^data: //p' <<<"$raw")
  data=${data%%$'\n'*}
  [[ -z "$data" ]] && data="$raw"
  jq -r '.result.content[0].text // .error.message // empty' <<<"$data"
}
status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)'
}
dump_diag() {
  echo "---- node.log (tail 60) ----" >&2; tail -60 "$WORK/node.log" >&2 || true
  echo "---- hub.log (tail 30) ----" >&2; tail -30 "$WORK/hub.log" >&2 || true
}
wait_capable() {
  local row
  for _ in $(seq 1 240); do
    row=$(status_row || true)
    [[ -n "$row" && "$(jq -r '.logs_capable' <<<"$row")" == true ]] && return 0
    sleep 0.25
  done
  return 1
}
wait_result() {
  local rid="$1" res status
  for _ in $(seq 1 120); do
    res=$(mcp_as "$UTOK" get_rules_file_result "$(jq -nc --arg r "$rid" --arg n "$NET" '{request_id:$r,network_id:$n}')")
    status=$(jq -r '.status // empty' <<<"$res")
    case "$status" in done|failed|timeout) printf '%s\n' "$res"; return 0 ;; esac
    sleep 0.25
  done
  printf '%s\n' "$res"
  return 1
}
tail_logs() {
  local extra="$1" enq rid
  enq=$(mcp_as "$UTOK" tail_node_logs "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --argjson x "$extra" '{node_id:$id,network_id:$n} + $x')")
  rid=$(jq -r '.request_id // empty' <<<"$enq")
  [[ -n "$rid" ]] || { echo "enqueue failed: $enq" >&2; return 1; }
  wait_result "$rid"
}
request_rows() {
  (cd "$REPO/server" && bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    console.log(JSON.stringify(db.query("SELECT request_id, op, result_content, content, content_purged_at FROM node_rules_requests WHERE op = ?1").all("logs_tail")));
  ' "$WORK/hub.db")
}

SENTINELS=()
plant() {
  local log_dir="$WORK/cwd/.anet/nodes/$ALIAS/logs"
  local log="$log_dir/$(date -u +%F).log"
  [[ -d "$log_dir" ]] || fail "node log dir missing: $log_dir"
  local t; t=$(date +%H:%M:%S)
  SENTINELS=("$NTOK" "PLANTEDbearer0001abcdef" "PLANTEDenvkey0002abc" "PLANTEDjson0003" "$ENV_SECRET")
  {
    echo "[$t] [INFO ] [$ALIAS] planted-token connecting with $NTOK"
    echo "[$t] [WARN ] [$ALIAS] planted-bearer retry with Authorization: Bearer PLANTEDbearer0001abcdef"
    echo "[$t] [ERROR] [$ALIAS] planted-assign provider rejected OPENAI_API_KEY=PLANTEDenvkey0002abc and api_key=\"PLANTEDjson0003\""
    echo "[$t] [INFO ] [$ALIAS] planted-env echo $ENV_SECRET"
    echo "[$t] [ERROR] [$ALIAS] planted-plain task failed: ECONNRESET"
  } >>"$log"
}
assert_no_sentinel() {
  local content="$1" label="$2" s
  for s in "${SENTINELS[@]}"; do
    if grep -Fq -- "$s" <<<"$content"; then fail "$label: sentinel survived redaction: ${s:0:12}…"; fi
  done
}

# ── 1. capability ──
start_node
wait_capable || { dump_diag; fail 'node never reported logs_capable'; }
ok 'agent-node reported logs_capable (visible on /api/status)'

# ── 2. planted secrets never leave the node ──
plant
RES=$(tail_logs '{"lines":50}') || { dump_diag; fail "tail never terminal: $RES"; }
[[ "$(jq -r .status <<<"$RES")" == done ]] || { dump_diag; fail "tail status: $RES"; }
CONTENT=$(jq -r '.content // empty' <<<"$RES")
[[ -n "$CONTENT" ]] || fail 'tail returned no content'
assert_no_sentinel "$CONTENT" 'step 2'
TEXTS=$(jq -r '.lines[].text' <<<"$CONTENT")
for marker in planted-token planted-bearer planted-assign planted-env planted-plain ECONNRESET 'OPENAI_API_KEY=' 'Authorization: '; do
  grep -Fq -- "$marker" <<<"$TEXTS" || fail "step 2: non-secret text missing ($marker)"
done
[[ $(grep -Fc '[REDACTED' <<<"$TEXTS") -ge 4 ]] || fail 'step 2: expected ≥ 4 redacted lines'
[[ "$(jq -r '.files | join(",")' <<<"$CONTENT")" == "$(date -u +%F).log" ]] || fail "step 2: files should be the dated log name only: $(jq -c .files <<<"$CONTENT")"
ok "planted token / Bearer / KEY= / api_key / env-only value all redacted on the node (${#SENTINELS[@]} sentinels, 0 survived)"

# ── 3. filters ──
ERR=$(tail_logs '{"lines":50,"level":"error"}' | jq -r '.content')
[[ "$(jq '[.lines[] | select(.level != "error")] | length' <<<"$ERR")" == 0 && "$(jq '.lines | length' <<<"$ERR")" -ge 2 ]] || fail "level=error returned non-error lines: $ERR"
ok 'level=error returns only error lines'
PROBE=$(tail_logs '{"lines":50,"grep":"PLANTEDbearer0001"}' | jq -r '.content')
[[ "$(jq '.lines | length' <<<"$PROBE")" == 0 ]] || fail 'grep for a masked secret matched — grep ran before redaction'
HIT=$(tail_logs '{"lines":50,"grep":"PLANTED-PLAIN"}' | jq -r '.content')
[[ "$(jq '.lines | length' <<<"$HIT")" == 1 ]] || fail "grep (case-insensitive) should hit exactly the plain line: $HIT"
ok 'grep is case-insensitive and cannot probe a masked secret'

# ── 4. read-once ──
RID=$(jq -r .request_id <<<"$RES")
AGAIN=$(mcp_as "$UTOK" get_rules_file_result "$(jq -nc --arg r "$RID" --arg n "$NET" '{request_id:$r,network_id:$n}')")
[[ "$(jq -r '.content_purged' <<<"$AGAIN")" == true && "$(jq -r 'has("content")' <<<"$AGAIN")" == false ]] || fail "second read still has content: $AGAIN"
ROWS=$(request_rows)
[[ "$(jq '[.[] | select(.result_content != null)] | length' <<<"$ROWS")" == 0 ]] || fail "hub DB still holds log bytes: $ROWS"
[[ "$(jq '[.[] | select(.content != null)] | length' <<<"$ROWS")" == 0 ]] || fail "hub DB still holds filter JSON: $ROWS"
ok "read-once: second read is content_purged; $(jq length <<<"$ROWS") logs_tail row(s) in the hub DB hold no log bytes"

# ── 5. who may ask ──
BEFORE=$(jq length <<<"$(request_rows)")
R_NODE=$(mcp_as "$NTOK" tail_node_logs "$(jq -nc --arg id "$NODE_ID" '{node_id:$id}')")
[[ "$(jq -r '.error // empty' <<<"$R_NODE")" == node_token_cannot_read_logs ]] || fail "node token was not refused: $R_NODE"
R_OTHER=$(mcp_as "$UTOK2" tail_node_logs "$(jq -nc --arg id "$NODE_ID" --arg n "$NET2" '{node_id:$id,network_id:$n}')")
[[ "$(jq -r '.ok' <<<"$R_OTHER")" == false ]] || fail "other network's user was not refused: $R_OTHER"
R_OTHER2=$(mcp_as "$UTOK2" tail_node_logs "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" '{node_id:$id,network_id:$n}')")
[[ "$(jq -r '.ok' <<<"$R_OTHER2")" == false ]] || fail "other user naming this network was not refused: $R_OTHER2"
[[ "$(jq length <<<"$(request_rows)")" == "$BEFORE" ]] || fail 'a refused request still wrote a row'
ok "refused: node token ($(jq -r .error <<<"$R_NODE")), other network ($(jq -r .error <<<"$R_OTHER")), outsider naming this network ($(jq -r .error <<<"$R_OTHER2")); no rows written"

# ── 6. witnessed-red ──
stop_node
cp "$LOGS_SRC" "$WORK/node-logs.ts.orig"
node "$REPO/tests/qa-node-logs-e2e/mutate-redactor.mjs" "$LOGS_SRC"
start_node
sleep 1
wait_capable || { dump_diag; fail 'mutated node never came back'; }
MUT=$(tail_logs '{"lines":50}' | jq -r '.content // empty')
cp "$WORK/node-logs.ts.orig" "$LOGS_SRC"; rm -f "$WORK/node-logs.ts.orig"
if ( assert_no_sentinel "$MUT" 'mutant' ) 2>/dev/null; then
  fail 'witnessed-red: with the redactor disabled, step 2 still passed — the assertion cannot fail'
fi
ok 'witnessed-red: with the node redactor disabled, the step 2 assertion fails (sentinels appear)'

echo "RESULT pass=$PASS fail=0 source=$QA_NODE_LOGS_SOURCE_COMMIT"
