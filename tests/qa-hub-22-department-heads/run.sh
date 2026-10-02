#!/usr/bin/env bash
# qa-hub-22-department-heads — 部门负责人权限(RFC-040,#455)。见 README.md。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-hub-22}"
PORT="${PORT:-$((20000 + RANDOM % 9000))}"
[[ "$PORT" != 9200 ]] || PORT=9278
BASE="http://127.0.0.1:$PORT"
PASSWORD="DeptHeads-E2E-Strong-1!"
HEADS_SRC="$REPO/server/src/department-heads.ts"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; [[ -f "$WORK/hub.log" ]] && tail -40 "$WORK/hub.log" >&2; exit 1; }

test "${QA_HUB_22_SOURCE_COMMIT:-unknown}" != unknown || fail 'source commit unknown'

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
  if [[ -f "$WORK/department-heads.ts.orig" ]]; then cp "$WORK/department-heads.ts.orig" "$HEADS_SRC"; fi
}
trap cleanup EXIT

# 每轮一个全新的 HOME + DB。
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

# req METHOD PATH TOKEN [BODY] → 打印 "<status> <body>"(不用 -f:403 / 400 也要读正文)。
req() {
  local out
  if [[ $# -ge 4 ]]; then
    out=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X "$1" "$BASE$2" -H "Authorization: Bearer $3" -H 'Content-Type: application/json' -d "$4")
  else
    out=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X "$1" "$BASE$2" -H "Authorization: Bearer $3")
  fi
  printf '%s %s' "$out" "$(cat "$WORK/body")"
}
status_of() { printf '%s' "${1%% *}"; }
body_of() { printf '%s' "${1#* }"; }
expect_status() { # want label response
  [[ "$(status_of "$3")" == "$1" ]] || fail "$2: want $1, got $(status_of "$3") $(body_of "$3")"
}
login() {
  curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$PASSWORD\"}" | jq -r .token
}

# 搭场景:owner(第一个注册 = Hub 管理员)、负责人 head(前端)、上级负责人 parent(研发)、member(前端一组)、
# sales(销售)。除 owner 外都是「只看相关任务」。member 负责一张卡,sales 负责一张卡(在项目 P 里)。
setup() {
  OWNER=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d "{\"username\":\"qa22owner\",\"password\":\"$PASSWORD\"}" | jq -r .token)
  NET=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer $OWNER" | jq -r '.networks[0].network_id')
  declare -gA TOK UID_
  for who in head parent member sales; do
    req POST /api/admin/users "$OWNER" "{\"username\":\"qa22$who\",\"password\":\"$PASSWORD\",\"network_id\":\"$NET\",\"role\":\"member\"}" >/dev/null
    TOK[$who]=$(login "qa22$who")
    UID_[$who]=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer ${TOK[$who]}" | jq -r .user.user_id)
    expect_status 200 "scoped $who" "$(req PUT "/api/networks/$NET/members/${UID_[$who]}/task-grants" "$OWNER" '{"task_access":"scoped"}')"
  done
  mkdept() { # name parent leader
    local r; r=$(req POST "/api/networks/$NET/departments" "$OWNER" "$(jq -nc --arg n "$1" --arg p "$2" --arg l "$3" '{name:$n, parent_id:(if $p=="" then null else $p end), leader_user_id:(if $l=="" then null else $l end)}')")
    expect_status 201 "create $1" "$r"; body_of "$r" | jq -r .department.id
  }
  RD=$(mkdept 研发 "" "${UID_[parent]}")
  FE=$(mkdept 前端 "$RD" "${UID_[head]}")
  FE1=$(mkdept 前端一组 "$FE" "")
  SALES=$(mkdept 销售 "" "")
  for pair in "head:$FE" "member:$FE1" "sales:$SALES" "parent:$RD"; do
    expect_status 200 "place ${pair%%:*}" "$(req PUT "/api/networks/$NET/members/${UID_[${pair%%:*}]}/department" "$OWNER" "{\"department_id\":\"${pair#*:}\"}")"
  done
  local p; p=$(req POST "/api/requirements/projects?network_id=$NET" "$OWNER" "{\"name\":\"示例项目\",\"network_id\":\"$NET\"}")
  expect_status 201 project "$p"; PROJ=$(body_of "$p" | jq -r .project.id)
  MCARD=$(body_of "$(req POST /api/requirements "$OWNER" "{\"name\":\"成员的卡\",\"network_id\":\"$NET\",\"owner\":{\"kind\":\"user\",\"id\":\"${UID_[member]}\"}}")" | jq -r .requirement.id)
  SCARD=$(body_of "$(req POST /api/requirements "$OWNER" "{\"name\":\"销售的卡\",\"network_id\":\"$NET\",\"project_id\":\"$PROJ\",\"owner\":{\"kind\":\"user\",\"id\":\"${UID_[sales]}\"}}")" | jq -r .requirement.id)
  [[ "$MCARD" == req_* && "$SCARD" == req_* ]] || fail "cards not created"
}
sees() { # who card → 0 if the card is in who's list
  req GET "/api/requirements?network_id=$NET" "${TOK[$1]}" >/dev/null
  jq -e --arg c "$2" 'any(.requirements[]; .id == $c)' "$WORK/body" >/dev/null
}

# ── 第 1 轮:真实行为 ──
start_hub main
setup
managed=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer ${TOK[head]}" | jq -c --arg n "$NET" '[.networks[] | select(.network_id == $n) | .managed_department_ids[]] | sort')
[[ "$managed" == "$(jq -nc --arg a "$FE" --arg b "$FE1" '[$a,$b] | sort')" ]] || fail "managed_department_ids: $managed"
ok "auth/me: head manages its department and the sub-department"

expect_status 201 "head creates under own subtree" "$(req POST "/api/networks/$NET/departments" "${TOK[head]}" "{\"name\":\"前端二组\",\"parent_id\":\"$FE\"}")"
r=$(req POST "/api/networks/$NET/departments" "${TOK[head]}" "{\"name\":\"越权\",\"parent_id\":\"$SALES\"}")
expect_status 403 "head outside subtree" "$r"; [[ "$(body_of "$r" | jq -r .error)" == department_scope_denied ]] || fail "fixed 403 code: $r"
r=$(req POST "/api/networks/$NET/departments" "${TOK[member]}" "{\"name\":\"x\",\"parent_id\":\"$FE\"}")
[[ "$(body_of "$r")" == '{"ok":false,"error":"owner/admin required"}' ]] || fail "non-head byte-for-byte: $r"
ok "department writes: inside the subtree 201, outside 403 department_scope_denied, non-heads unchanged"

sees head "$MCARD" || fail "head sees member's card"
! sees head "$SCARD" || fail "head must not see sales' card"
sees parent "$MCARD" || fail "parent head sees the sub-sub-department's card"
ok "tasks: heads see their (sub)department's cards only"

expect_status 200 "revoke" "$(req PATCH "/api/networks/$NET/departments/$FE" "$OWNER" '{"leader_user_id":null}')"
! sees head "$MCARD" || fail "revoked head still sees the card"
expect_status 200 "restore" "$(req PATCH "/api/networks/$NET/departments/$FE" "$OWNER" "{\"leader_user_id\":\"${UID_[head]}\"}")"
sees head "$MCARD" || fail "restored head sees the card again"
ok "revoking a head takes effect on the next request"

! sees member "$SCARD" || fail "member must not see sales' card before the grant"
expect_status 200 "grant" "$(req PUT "/api/networks/$NET/departments/$RD/project-grants" "$OWNER" "{\"project_grants\":[{\"project_id\":\"$PROJ\"}]}")"
sees member "$SCARD" || fail "a grant to 研发 reaches 前端一组"
expect_status 403 "head cannot set grants" "$(req PUT "/api/networks/$NET/departments/$FE/project-grants" "${TOK[head]}" '{"project_grants":[]}')"
ok "department project grant cascades to sub-departments (owner/admin only)"

expect_status 200 "head deletes a department card" "$(req DELETE "/api/requirements/$MCARD" "${TOK[head]}")"
req GET "/api/messages?scope=user&network_id=$NET" "${TOK[member]}" >/dev/null
jq -e 'any(.messages[]; (.content // "") | contains("部门负责人"))' "$WORK/body" >/dev/null || fail "member got no DM: $(cat "$WORK/body" | head -c 400)"
ok "head delete → DM to the card owner"

# ── 第 2 轮 witnessed-red:负责人只管自己那一层(不算下级),换全新 hub 重跑 ⇒ 上级负责人看不见孙部门的卡 ──
stop_hub
cp "$HEADS_SRC" "$WORK/department-heads.ts.orig"
sed -i 's/^    collect(t, r\.department_id, managed);$/    managed.add(r.department_id);/' "$HEADS_SRC"
cmp -s "$HEADS_SRC" "$WORK/department-heads.ts.orig" && fail 'MUTATION_NOOP: subtree walk not found'
start_hub red
setup
if sees parent "$MCARD"; then fail "witnessed-red: the subtree check did not turn red"; fi
cp "$WORK/department-heads.ts.orig" "$HEADS_SRC"
ok "witnessed-red: without the subtree walk the parent head loses the sub-department's card"

echo "qa-hub-22-department-heads: $PASS passed"
