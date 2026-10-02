#!/usr/bin/env bash
# qa-hub-21-schedule-stuck — 定时任务被卡住:告警 + 超时放行(#464)。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-hub-21}"
PORT="${PORT:-$((20000 + RANDOM % 9000))}"
[[ "$PORT" != 9200 ]] || PORT=9278
BASE="http://127.0.0.1:$PORT"
PASSWORD="SchedStuck-E2E-Strong-1!"
ALIAS="node-a"
NODE_ID="n_qa21_node_a"
TIMEOUT_SEC=20
SCHED_SRC="$REPO/server/src/scheduled-tasks.ts"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; [[ -f "$WORK/hub.log" ]] && tail -40 "$WORK/hub.log" >&2; exit 1; }

test "${QA_HUB_21_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'

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
  if [[ -f "$WORK/scheduled-tasks.ts.orig" ]]; then cp "$WORK/scheduled-tasks.ts.orig" "$SCHED_SRC"; fi
}
trap cleanup EXIT

# 每轮一个全新的 HOME + DB。调度器 1 秒一拍;卡住超时压到 TIMEOUT_SEC 秒(默认是 clamp(6×间隔, 1h, 24h))。
start_hub() {
  local round="$1"
  safe_rm_rf "$WORK/$round"
  mkdir -p "$WORK/$round/home"
  (cd "$REPO/server" && exec setsid env HOME="$WORK/$round/home" PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$WORK/$round/hub.db" COMMHUB_SCHEDULER_TICK_MS=1000 \
    COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR=0 COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC="$TIMEOUT_SEC" \
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

notice_count() {
  local body
  body=$(api GET "/api/messages?scope=user&network_id=$NET" "$1")
  jq --arg a "$ALIAS" '[.messages[] | select(.kind == "schedule_stuck" and .from_session == $a)] | length' <<<"$body"
}

run_now() { api POST "/api/scheduled-tasks/$SCHED/run-now" "$BOSS" '{}' || true; }

# boss(网络 owner,排程创建者)、otto(另一成员);boss 铸 node-a 的节点令牌,节点上报 idle 但从不回复。
setup_round() {
  start_hub "$1"
  local reg inv out
  reg=$(register qa21boss); BOSS=$(jq -r '.token // empty' <<<"$reg"); NET=$(jq -r '.network_id // empty' <<<"$reg")
  [[ "$BOSS" == utok_* && -n "$NET" ]] || fail 'boss registration'
  reg=$(register qa21otto); OTTO=$(jq -r '.token // empty' <<<"$reg")
  [[ "$OTTO" == utok_* ]] || fail 'member registration'
  inv=$(api POST "/api/networks/$NET/invite" "$BOSS" '{"role":"member"}' | jq -r '.invite_code // empty')
  api POST /api/networks/join "$OTTO" "{\"invite_code\":\"$inv\"}" | jq -e '.ok == true' >/dev/null || fail 'join'
  NTOK=$(api POST /api/auth/node-token "$BOSS" "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" | jq -r '.token // empty')
  [[ "$NTOK" == ntok_* ]] || fail 'node-token'
  out=$(mcp_call "$NTOK" report_status "$(jq -nc --arg net "$NET" --arg a "$ALIAS" --arg n "$NODE_ID" '{resume_id:"qa21-node-a",alias:$a,status:"idle",node_id:$n,network_id:$net}')")
  jq -e '.ok == true' >/dev/null <<<"$out" || fail "report_status: $out"
  # 间隔 60 秒(Hub 允许的最短);建好就暂停,由 run-now 逐次驱动(与调度器同一个派发函数),时间线确定。
  SCHED=$(api POST /api/scheduled-tasks "$BOSS" "$(jq -nc --arg net "$NET" --arg n "$NODE_ID" \
    '{network_id:$net,name:"qa21 report",target_node_id:$n,task:"qa21 tick",timezone:"UTC",schedule:{type:"interval",every_seconds:60}}')" \
    | jq -r '.schedule.schedule_id // empty')
  [[ -n "$SCHED" ]] || fail 'create schedule'
  local rev
  rev=$(api GET "/api/scheduled-tasks/$SCHED" "$BOSS" | jq -r '.schedule.revision')
  api PATCH "/api/scheduled-tasks/$SCHED" "$BOSS" "{\"revision\":$rev,\"status\":\"paused\"}" | jq -e '.ok == true' >/dev/null || fail 'pause'
}

safe_rm_rf "$WORK"
mkdir -p "$WORK"

# ── 1. 真实链路 ────────────────────────────────────────────────────────────────
setup_round real
ok "hub booted on :$PORT; schedule (60s interval) on a node that never replies"

A=$(run_now | jq -r 'select(.status == "delivered") | .taskId // empty')
[[ -n "$A" ]] || fail 'first occurrence not delivered'
ok "first occurrence delivered task $A"

for i in 1 2; do [[ $(run_now | jq -r .status) == skipped ]] || fail "skip $i"; done
[[ $(notice_count "$BOSS") == 0 ]] || fail 'notice before the 3rd skip'
[[ $(run_now | jq -r .status) == skipped ]] || fail 'skip 3'
[[ $(notice_count "$BOSS") == 1 ]] || fail "expected 1 notice after 3 skips, got $(notice_count "$BOSS")"
ok 'creator notified after the 3rd consecutive skip'
for i in 4 5; do [[ $(run_now | jq -r .status) == skipped ]] || fail "skip $i"; done
[[ $(notice_count "$BOSS") == 1 ]] || fail "episode must notify once, got $(notice_count "$BOSS")"
[[ $(notice_count "$OTTO") == 0 ]] || fail 'other member got a notice'
ok 'still exactly one notice after 5 skips; other member got none'

body=$(api GET "/api/messages?scope=user&network_id=$NET" "$BOSS")
content=$(jq -r --arg a "$ALIAS" '[.messages[] | select(.kind == "schedule_stuck" and .from_session == $a)][0].content' <<<"$body")
for frag in "qa21 report" "$A" "$ALIAS" "(UTC)" "3 次"; do
  [[ "$content" == *"$frag"* ]] || fail "notice text lacks '$frag': $content"
done
ok 'notice names the schedule, the blocking task, the node and the start time'

runs=$(api GET "/api/scheduled-tasks/$SCHED/runs" "$BOSS")
jq -e --arg a "$A" '[.runs[] | select(.status == "skipped" and .blocked_by_task_id == $a and .blocked_by_state != null)] | length == 5' >/dev/null <<<"$runs" \
  || fail "runs API should expose blocked_by_task_id on 5 skipped rows: $(jq -c '[.runs[]|{status,blocked_by_task_id}]' <<<"$runs")"
ok 'GET /runs exposes blocked_by_task_id + blocked_by_state on every skipped row'

# 等挡路任务开满 TIMEOUT_SEC 秒,下一次就放行
sleep $((TIMEOUT_SEC + 2))
NEXT=$(run_now)
B=$(jq -r 'select(.status == "delivered") | .taskId // empty' <<<"$NEXT")
[[ -n "$B" && "$B" != "$A" ]] || fail "timeout should release the next occurrence: $NEXT"
ok "after ${TIMEOUT_SEC}s the stuck task is timed out and the next occurrence dispatched ($B)"
task=$(api GET "/api/tasks/$A" "$BOSS")
jq -e '.ok == true and .task.status == "expired" and .task.content == "qa21 tick"' >/dev/null <<<"$task" || fail "stuck task row: $task"
runs=$(api GET "/api/scheduled-tasks/$SCHED/runs" "$BOSS")
jq -e --arg a "$A" '[.runs[] | select(.task_id == $a)][0] | .status == "expired" and .error_code == "task_expired" and (.error_message | contains("timed out by the scheduler"))' >/dev/null <<<"$runs" \
  || fail "stuck run row: $(jq -c --arg a "$A" '[.runs[]|select(.task_id==$a)]' <<<"$runs")"
ok 'stuck task stays readable as expired; its run is expired/task_expired with the scheduler reason'
[[ $(notice_count "$BOSS") == 1 ]] || fail 'timeout after the stuck notice must not notify again'
ok 'no second notice for the same episode'

late=$(mcp_call "$NTOK" send_reply "$(jq -nc --arg t "$A" '{in_reply_to:$t,text:"late answer",status:"replied"}')")
jq -e '.ok == false and .error == "reply_task_terminal" and .reply_queued == false' >/dev/null <<<"$late" || fail "late reply: $late"
api GET "/api/tasks/$A" "$BOSS" | jq -e '.task.status == "expired"' >/dev/null || fail 'late reply changed the stuck task'
api GET "/api/tasks/$B" "$BOSS" | jq -e '.task.status == "delivered"' >/dev/null || fail 'late reply touched the new task'
ok 'a late reply to the timed-out task is refused (reply_task_terminal) and changes nothing'
ontime=$(mcp_call "$NTOK" send_reply "$(jq -nc --arg t "$B" '{in_reply_to:$t,text:"on time",status:"replied"}')")
jq -e '.ok == true' >/dev/null <<<"$ontime" || fail "reply to the new task: $ontime"
[[ $(run_now | jq -r .status) == delivered ]] || fail 'schedule should run normally after the new task replied'
ok 'the new task replies normally and the schedule runs on'
stop_hub

# ── 2. witnessed-red:把「恰好第 N 次」改成「第 N 次及以后」,同一段卡住必然多发 ────
cp "$SCHED_SRC" "$WORK/scheduled-tasks.ts.orig"
sed -i 's/if (skips === stuckNoticeSkips())/if (skips >= stuckNoticeSkips())/' "$SCHED_SRC"
cmp -s "$SCHED_SRC" "$WORK/scheduled-tasks.ts.orig" && fail 'MUTATION_NOOP: notice condition not found'
setup_round mutant
run_now >/dev/null
for _ in 1 2 3 4 5; do run_now >/dev/null; done
n_mut=$(notice_count "$BOSS")
[[ "$n_mut" -gt 1 ]] || fail "witnessed-red: with the once-guard removed expected >1 notices, got $n_mut"
ok "witnessed-red: without the once-per-episode guard the same 5 skips yield $n_mut notices"
stop_hub
cp "$WORK/scheduled-tasks.ts.orig" "$SCHED_SRC"

echo "qa-hub-21-schedule-stuck: PASS=$PASS FAIL=0"
