#!/usr/bin/env bash
# test9763 — 团队技能端到端：真 hub + 真 agent-node。
# 验启动时的链接、skills_list 的 origin、不覆盖别人的目录、两个 codex home，
# 以及拿掉安装调用后链接不再出现。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
source "$REPO/tests/lib/mutation-guard.sh"
WORK="${WORK:-/tmp/test9763}"
PORT="${PORT:-9763}"
BASE="http://127.0.0.1:$PORT"
ALIAS="skill-node"
ADMIN="team_skills_admin"
PASSWORD="Team-Skills-Strong-1!"
PASS=0
BODY=$'---\nname: team-echo\ndescription: echo\n---\nteam-echo-ok\n'

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
mutation_guard_report() { fail "$@"; }

test "${TEST9763_SOURCE_COMMIT:-unknown}" != unknown
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/node" "$WORK/cwd" "$WORK/codex-a" "$WORK/codex-b" "$WORK/inherited"
export HOME="$WORK/home"

HUB_PID=""
NODE_PID=""
CODEX_PIDS=()
CLI_SRC="$REPO/agent-node/src/cli.ts"
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
cleanup() {
  stop_group "$NODE_PID" || true
  local pid
  for pid in "${CODEX_PIDS[@]:-}"; do stop_group "$pid" || true; done
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$CLI_SRC"; fi
}
trap cleanup EXIT

mkdir -p "$HOME/.anet/skills/team-echo" "$HOME/.anet/skills/kept-local" "$HOME/.claude/skills/kept-local"
printf '%s' "$BODY" >"$HOME/.anet/skills/team-echo/SKILL.md"
printf '%s' 'TEAM-KEPT' >"$HOME/.anet/skills/kept-local/SKILL.md"
printf '%s' 'LOCAL-BYTES' >"$HOME/.claude/skills/kept-local/SKILL.md"

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok 'real Hub booted'

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test9763@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'

mint() {
  local alias="$1" id="$2"
  curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET\",\"node_name\":\"$alias\",\"node_id\":\"$id\"}" | jq -r '.token // empty'
}

NODE_ID="node_test9763_$(date +%s%N | sha256sum | head -c 12)"
NTOK=$(mint "$ALIAS" "$NODE_ID")
[[ "$NTOK" == ntok_* ]] || fail 'node token mint'
ok 'network-scoped node token minted'

cat >"$WORK/node/config.json" <<JSON
{"alias":"$ALIAS","node_id":"$NODE_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET"}
JSON

start_node() {
  NODE_PID=""
  (cd "$WORK/cwd" && exec setsid env ANTHROPIC_API_KEY=test9763-not-used HOME="$HOME" ANET_LOG_LEVEL=info \
    bun "$CLI_SRC" --alias "$ALIAS" --config "$WORK/node/config.json" >"$WORK/node.log" 2>&1) &
  NODE_PID=$!
}
stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}

mcp_call() {
  local name="$1" args_json="$2" body raw data
  body=$(jq -nc --arg n "$name" --argjson a "$args_json" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw=$(curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' -d "$body")
  data=$(sed -n 's/^data: //p' <<<"$raw" | head -1)
  [[ -z "$data" ]] && data="$raw"
  jq -r '.result.content[0].text // empty' <<<"$data"
}
node_id() {
  curl -fsS "$BASE/api/nodes" -H "Authorization: Bearer $UTOK" | jq -r --arg a "$ALIAS" '.nodes[]? | select(.alias==$a) | .node_id // empty'
}
status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)'
}
dump_diag() {
  echo "---- node.log (tail 80) ----" >&2; tail -80 "$WORK/node.log" >&2 || true
  echo "---- hub.log (tail 30) ----" >&2; tail -30 "$WORK/hub.log" >&2 || true
}
wait_node_registered() {
  for _ in $(seq 1 240); do
    local id; id=$(node_id || true)
    if [[ -n "$id" ]] && [[ -n "$(status_row || true)" ]]; then printf '%s\n' "$id"; return 0; fi
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
  printf '%s\n' "$res"
  return 1
}

start_node
SEEN_ID=$(wait_node_registered) || { dump_diag; fail 'node never registered'; }
[[ "$SEEN_ID" == "$NODE_ID" ]] || fail "hub shows node_id $SEEN_ID, expected pre-assigned $NODE_ID"
ok "real agent-node registered as $ALIAS"

skills_log() { grep -F '[skills]' "$1" || true; }
LOGS=$(skills_log "$WORK/node.log")
[[ -n "$LOGS" ]] || { dump_diag; fail 'no [skills] log'; }
grep -F '团队技能 team-echo 已链到 ~/.claude/skills（全机生效，本机所有 claude 节点）' <<<"$LOGS" >/dev/null \
  || fail "missing machine-wide log: $LOGS"
grep -F '未覆盖 ~/.claude/skills/kept-local' <<<"$LOGS" >/dev/null || fail "missing conflict warning: $LOGS"
if grep -F "$HOME" <<<"$LOGS" >/dev/null; then fail 'skills log contains the home path'; fi
ok 'claude log says 全机生效 and does not overwrite kept-local'

LINK=$(readlink "$HOME/.claude/skills/team-echo")
[[ "$LINK" == "$HOME/.anet/skills/team-echo" ]] || fail "team-echo link target: ${LINK:-missing}"
cmp -s "$HOME/.anet/skills/team-echo/SKILL.md" "$HOME/.claude/skills/team-echo/SKILL.md" || fail 'linked bytes differ from the team source'
[[ ! -L "$HOME/.claude/skills/kept-local" ]] || fail 'kept-local was replaced with a link'
cmp -s <(printf '%s' 'LOCAL-BYTES') "$HOME/.claude/skills/kept-local/SKILL.md" || fail 'kept-local bytes changed'
ok 'link target is the team dir; pre-existing dest kept'

ARGS=$(jq -nc --arg id "$NODE_ID" --arg n "$NET" '{node_id:$id,network_id:$n}')
ENQ=$(mcp_call list_node_skills "$ARGS")
RID=$(jq -r '.request_id // empty' <<<"$ENQ"); [[ "$RID" == rf_* ]] || fail "list enqueue: $ENQ"
RES=$(wait_result "$RID") || { dump_diag; fail "list never finished: $RES"; }
jq -e '
  .status=="done" and .file_name=="skills"
  and ((.content|fromjson|.skills[]|select(.name=="team-echo")) | .origin=="team" and .scope=="user")
  and ((.content|fromjson|.skills[]|select(.name=="kept-local")|has("origin")) == false)
  and ((.content|fromjson|.roots) == [".claude/skills","~/.claude/skills"])
  and ((.content|fromjson|.warnings|map(select(contains("未覆盖")))) | length==1)
' >/dev/null <<<"$RES" || fail "skills_list: $RES"
ok 'skills_list: team-echo origin=team, kept-local has no origin, roots and warning present'

ENQ=$(mcp_call read_node_skill "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" '{node_id:$id,network_id:$n,name:"team-echo"}')")
RID=$(jq -r '.request_id // empty' <<<"$ENQ"); [[ "$RID" == rf_* ]] || fail "read enqueue: $ENQ"
RES=$(wait_result "$RID") || { dump_diag; fail "read never finished: $RES"; }
jq -e --arg b "$BODY" '.status=="done" and (.content|fromjson|.origin=="team") and (.content|fromjson|.content==$b)' >/dev/null <<<"$RES" \
  || fail "skill_read: $RES"
ok 'skill_read bytes match the team SKILL.md'

start_codex() {
  local alias="$1" id="$2" dir="$3" home_dir="$4" log="$5" tok
  tok=$(mint "$alias" "$id")
  [[ "$tok" == ntok_* ]] || fail "codex token for $alias"
  mkdir -p "$dir"
  cat >"$dir/config.json" <<JSON
{"alias":"$alias","node_id":"$id","runtime":"codex-sdk","model":"gpt-5","hub":"$BASE","token":"$tok","network_id":"$NET","codexHome":"$home_dir"}
JSON
  (cd "$WORK/cwd" && exec setsid env HOME="$HOME" CODEX_HOME="$WORK/inherited" ANET_LOG_LEVEL=info \
    bun "$CLI_SRC" --alias "$alias" --config "$dir/config.json" >"$log" 2>&1) &
  CODEX_PIDS+=("$!")
}
wait_codex_log() {
  local log="$1"
  for _ in $(seq 1 240); do
    if grep -F '$CODEX_HOME/skills（仅本节点）' "$log" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}
start_codex "skill-codex-a" "node_test9763_a" "$WORK/codex-a" "$WORK/codex-a/own" "$WORK/codex-a.log"
start_codex "skill-codex-b" "node_test9763_b" "$WORK/codex-b" "$WORK/codex-b/own" "$WORK/codex-b.log"
wait_codex_log "$WORK/codex-a.log" || { tail -80 "$WORK/codex-a.log" >&2 || true; fail 'codex A did not log a per-node link'; }
wait_codex_log "$WORK/codex-b.log" || { tail -80 "$WORK/codex-b.log" >&2 || true; fail 'codex B did not log a per-node link'; }
for pid in "${CODEX_PIDS[@]}"; do stop_group "$pid" || true; done
[[ "$(readlink "$WORK/codex-a/own/skills/team-echo")" == "$HOME/.anet/skills/team-echo" ]] || fail 'codex A link missing'
[[ "$(readlink "$WORK/codex-b/own/skills/team-echo")" == "$HOME/.anet/skills/team-echo" ]] || fail 'codex B link missing'
[[ ! -e "$HOME/.codex/skills/team-echo" ]] || fail 'shared ~/.codex/skills was linked'
[[ ! -e "$WORK/inherited/skills/team-echo" ]] || fail 'inherited CODEX_HOME was linked'
for log in "$WORK/codex-a.log" "$WORK/codex-b.log"; do
  lines=$(skills_log "$log")
  if grep -F '全机生效' <<<"$lines" >/dev/null; then fail "codex log must not say 全机生效: $lines"; fi
  if grep -F "$HOME" <<<"$lines" >/dev/null; then fail 'codex skills log contains the home path'; fi
  if grep -F "$WORK/inherited" <<<"$lines" >/dev/null; then fail 'codex skills log contains the inherited path'; fi
done
ok 'two codex homes link only their own skills dir'

# 变异:只换掉那一行安装调用。先删掉已经链上的 team-echo,再重启,确认它不会回来。
stop_node
cp "$CLI_SRC" "$WORK/cli.ts.orig"
mutate drop-install "$CLI_SRC" env CLI_SRC="$CLI_SRC" node --input-type=module -e '
import fs from "node:fs";
const p = process.env.CLI_SRC;
const old = "  await installTeamSkills(RUNTIME, { workDir: process.cwd(), codexHome: NODE_CODEX_HOME }, { log, warn }); // board-team-skills-install\n";
const next = "  await Promise.resolve(); // board-team-skills-install\n";
const text = fs.readFileSync(p, "utf8");
const n = text.split(old).length - 1;
if (n !== 1) { console.error("anchor count " + n); process.exit(1); }
fs.writeFileSync(p, text.replace(old, next));
'
rm -f "$HOME/.claude/skills/team-echo"
: >"$WORK/node.log"
start_node
SEEN_ID=$(wait_node_registered) || { dump_diag; fail 'mutated node never registered'; }
ENQ=$(mcp_call list_node_skills "$ARGS")
RID=$(jq -r '.request_id // empty' <<<"$ENQ"); [[ "$RID" == rf_* ]] || fail "mutated list enqueue: $ENQ"
RES=$(wait_result "$RID") || { dump_diag; fail "mutated list never finished: $RES"; }
if jq -e '(.content|fromjson|.skills|map(.name)|index("team-echo")) != null' >/dev/null <<<"$RES"; then
  fail "mutation still lists team-echo: $RES"
fi
[[ ! -e "$HOME/.claude/skills/team-echo" ]] || fail 'mutation recreated the team-echo link'
ok 'without the install call, team-echo is not linked and not listed'

echo "RESULT pass=$PASS fail=0 source=$TEST9763_SOURCE_COMMIT"
