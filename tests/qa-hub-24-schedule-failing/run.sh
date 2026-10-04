#!/usr/bin/env bash
# qa-hub-24-schedule-failing — 定时任务连续失败:告诉创建者(#523)。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-hub-24}"
PORT="${PORT:-$((20000 + RANDOM % 9000))}"
[[ "$PORT" != 9200 ]] || PORT=9279
BASE="http://127.0.0.1:$PORT"
PASSWORD="SchedFailing-E2E-Strong-1!"
ALIAS="node-a"
NODE_ID="n_qa24_node_a"
FAIL_SRC="$REPO/server/src/scheduled-failures.ts"
ERR_TEXT="upstream model refused the request (safety system)"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; [[ -f "$WORK/hub.log" ]] && tail -40 "$WORK/hub.log" >&2; exit 1; }

test "${QA_HUB_24_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'

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
  if [[ -f "$WORK/scheduled-failures.ts.orig" ]]; then cp "$WORK/scheduled-failures.ts.orig" "$FAIL_SRC"; fi
}
trap cleanup EXIT

# 每轮一个全新的 HOME + DB。额外的环境变量从第二个参数起传入(KEY=VALUE)。
start_hub() {
  local round="$1"; shift
  safe_rm_rf "$WORK/$round"
  mkdir -p "$WORK/$round/home"
  (cd "$REPO/server" && exec setsid env HOME="$WORK/$round/home" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$WORK/$round/hub.db" COMMHUB_SCHEDULER_TICK_MS=1000 "$@" \
    bun run src/index.ts >"$WORK/hub.log" 2>&1) &
  HUB_PID=$!
  for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
  curl -fsS "$BASE/health" >/dev/null || fail "hub boot ($round)"
}

register() {
  curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PASSWORD\"}"
}

api() { # method path token [body]
  if [[ $# -ge 4 ]]; then
    curl -fsS -X "$1" "$BASE$2" -H "Authorization: Bearer $3" -H 'Content-Type: application/json' -d "$4"
  else
    curl -fsS -X "$1" "$BASE$2" -H "Authorization: Bearer $3"
  fi
}

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

notices() {
  api GET "/api/messages?scope=user&network_id=$NET" "$1" \
    | jq -c --arg a "$ALIAS" '[.messages[] | select(.kind == "schedule_failing" and .from_session == $a)]'
}
notice_count() { notices "$1" | jq 'length'; }

# 派一次(run-now,与调度器同一个派发函数),节点以 $1(failed / replied)回复。
run_once() {
  local outcome="$1" out task reply text
  out=$(api POST "/api/scheduled-tasks/$SCHED/run-now" "$BOSS" '{}' || true)
  task=$(jq -r 'select(.status == "delivered") | .taskId // empty' <<<"$out")
  [[ -n "$task" ]] || fail "occurrence not delivered: $out"
  text=$([[ "$outcome" == failed ]] && echo "$ERR_TEXT" || echo "done")
  reply=$(mcp_call "$NTOK" send_reply "$(jq -nc --arg t "$task" --arg x "$text" --arg s "$outcome" '{in_reply_to:$t,text:$x,status:$s}')")
  jq -e '.ok == true' >/dev/null <<<"$reply" || fail "send_reply ($outcome): $reply"
}

schedule_field() { api GET "/api/scheduled-tasks/$SCHED" "$BOSS" | jq -r ".schedule.$1"; }

# boss(网络 owner,排程创建者)、otto(另一成员);boss 铸 node-a 的节点令牌,节点上报 idle。
# 排程建好即暂停,由 run-now 逐次驱动,时间线确定;第二个参数 = active 时再恢复(自动暂停那一轮要它是 active)。
setup_round() {
  local round="$1" want="$2"; shift 2
  start_hub "$round" "$@"
  local reg inv out rev
  reg=$(register qa24boss); BOSS=$(jq -r '.token // empty' <<<"$reg"); NET=$(jq -r '.network_id // empty' <<<"$reg")
  [[ "$BOSS" == utok_* && -n "$NET" ]] || fail 'boss registration'
  reg=$(register qa24otto); OTTO=$(jq -r '.token // empty' <<<"$reg")
  [[ "$OTTO" == utok_* ]] || fail 'member registration'
  inv=$(api POST "/api/networks/$NET/invite" "$BOSS" '{"role":"member"}' | jq -r '.invite_code // empty')
  api POST /api/networks/join "$OTTO" "{\"invite_code\":\"$inv\"}" | jq -e '.ok == true' >/dev/null || fail 'join'
  NTOK=$(api POST /api/auth/node-token "$BOSS" "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" | jq -r '.token // empty')
  [[ "$NTOK" == ntok_* ]] || fail 'node-token'
  out=$(mcp_call "$NTOK" report_status "$(jq -nc --arg net "$NET" --arg a "$ALIAS" --arg n "$NODE_ID" '{resume_id:"qa24-node-a",alias:$a,status:"idle",node_id:$n,network_id:$net}')")
  jq -e '.ok == true' >/dev/null <<<"$out" || fail "report_status: $out"
  SCHED=$(api POST /api/scheduled-tasks "$BOSS" "$(jq -nc --arg net "$NET" --arg n "$NODE_ID" \
    '{network_id:$net,name:"qa24 report",target_node_id:$n,task:"qa24 tick",timezone:"UTC",schedule:{type:"interval",every_seconds:120}}')" \
    | jq -r '.schedule.schedule_id // empty')
  [[ -n "$SCHED" ]] || fail 'create schedule'
  if [[ "$want" == paused ]]; then
    rev=$(schedule_field revision)
    api PATCH "/api/scheduled-tasks/$SCHED" "$BOSS" "{\"revision\":$rev,\"status\":\"paused\"}" | jq -e '.ok == true' >/dev/null || fail 'pause'
  fi
}

safe_rm_rf "$WORK"
mkdir -p "$WORK"

# ── 0. 单测(SQLite)────────────────────────────────────────────────────────────
(cd "$REPO/server" && HOME="$WORK/unit-home" COMMHUB_DB="$WORK/unit.db" bun test src/scheduled-failures-http.test.ts) >"$WORK/unit.log" 2>&1 \
  || { tail -60 "$WORK/unit.log" >&2; fail 'unit tests (scheduled-failures-http.test.ts)'; }
ok 'unit tests: scheduled-failures-http.test.ts'

# ── 1. 真实链路:默认设置 ────────────────────────────────────────────────────────
setup_round real paused
ok "hub booted on :$PORT; schedule driven by run-now, node replies failed"

for _ in 1 2 3 4; do run_once failed; done
[[ $(notice_count "$BOSS") == 0 ]] || fail 'notice before the 5th failure'
run_once failed
[[ $(notice_count "$BOSS") == 1 ]] || fail "expected 1 notice after 5 failures, got $(notice_count "$BOSS")"
ok 'creator notified after the 5th consecutive failure'
run_once failed; run_once failed
[[ $(notice_count "$BOSS") == 1 ]] || fail "same streak must notify once, got $(notice_count "$BOSS")"
[[ $(notice_count "$OTTO") == 0 ]] || fail 'other member got a notice'
ok 'still exactly one notice after 7 failures; other member got none'

content=$(notices "$BOSS" | jq -r '.[0].content')
for frag in "qa24 report" "$ALIAS" "连续 5 次" "$ERR_TEXT" "task_failed" "暂停" "$SCHED"; do
  [[ "$content" == *"$frag"* ]] || fail "notice text lacks '$frag': $content"
done
ok 'notice names the schedule, the node, the count, the latest error and how to pause'
[[ $(schedule_field status) == paused ]] || fail 'status changed without the auto-pause flag'

runs=$(api GET "/api/scheduled-tasks/$SCHED/runs?limit=5" "$BOSS")
jq -e --arg e "$ERR_TEXT" '.consecutive_failures == 7 and .failure_alert_threshold == 5 and (.last_failure_alert_at | type == "string")
  and (.runs | length == 5) and all(.runs[]; .status == "failed" and .error_code == "task_failed" and (.error_message | contains($e)) and .completed_at != null)' >/dev/null <<<"$runs" \
  || fail "runs API: $(jq -c '{consecutive_failures,failure_alert_threshold,last_failure_alert_at,runs:[.runs[]|{status,error_code,error_message}]}' <<<"$runs")"
ok 'GET /runs: consecutive_failures=7, threshold, last alert time, each failed run carries the task reason'

run_once replied
api GET "/api/scheduled-tasks/$SCHED/runs" "$BOSS" | jq -e '.consecutive_failures == 0' >/dev/null || fail 'success did not reset the streak'
for _ in 1 2 3 4 5; do run_once failed; done
[[ $(notice_count "$BOSS") == 2 ]] || fail "a success should re-arm: expected 2 notices, got $(notice_count "$BOSS")"
ok 'a success resets the streak; the next 5 failures notify again'
stop_hub

# ── 2. 自动暂停(显式打开)───────────────────────────────────────────────────────
setup_round autopause active COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=3
[[ $(schedule_field status) == active ]] || fail 'schedule should start active'
run_once failed; run_once failed
[[ $(schedule_field status) == active ]] || fail 'paused too early'
run_once failed
[[ $(schedule_field status) == paused ]] || fail 'flag set: expected paused after 3 failures'
[[ $(schedule_field next_run_at) == null ]] || fail 'auto-paused schedule kept a next_run_at'
notices "$BOSS" | jq -e 'length == 1 and (.[0].title | contains("已自动暂停"))' >/dev/null || fail "pause notice: $(notices "$BOSS")"
ok 'COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=3 pauses after the 3rd failure and tells the creator'
stop_hub

# ── 3. witnessed-red:去掉去重条件,同一段失败必然多发 ─────────────────────────────
cp "$FAIL_SRC" "$WORK/scheduled-failures.ts.orig"
sed -i 's/AND (failure_alert_at IS NULL OR /AND (1 = 1 OR failure_alert_at IS NULL OR /' "$FAIL_SRC"
cmp -s "$FAIL_SRC" "$WORK/scheduled-failures.ts.orig" && fail 'MUTATION_NOOP: dedup condition not found'
set +e
(cd "$REPO/server" && HOME="$WORK/unit-home" COMMHUB_DB="$WORK/unit-mut.db" bun test src/scheduled-failures-http.test.ts) >"$WORK/unit-mut.log" 2>&1
mut_rc=$?
set -e
[[ "$mut_rc" -ne 0 ]] || fail 'witnessed-red: unit tests stayed green with the dedup removed'
ok "witnessed-red: unit tests go red without the dedup (rc=$mut_rc)"
setup_round mutant paused
for _ in 1 2 3 4 5 6 7; do run_once failed; done
n_mut=$(notice_count "$BOSS")
[[ "$n_mut" -gt 1 ]] || fail "witnessed-red: with the dedup removed expected >1 notices, got $n_mut"
ok "witnessed-red: without the dedup the same 7 failures yield $n_mut notices"
stop_hub
cp "$WORK/scheduled-failures.ts.orig" "$FAIL_SRC"

echo "qa-hub-24-schedule-failing: PASS=$PASS FAIL=0"
