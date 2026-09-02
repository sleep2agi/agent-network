#!/usr/bin/env bash
# test1755 — app#225 规则文件端到端：真 hub + 真 agent-node（claude-agent-sdk，
# 无真实 key）+ 桌面端同款 tools/call 调用。验的是 #225 验收里单测验不了的那几条：
#   - 远端节点可用：请求经 hub 落表 + SSE 门铃，节点自己读写
#   - 保存真的落到节点工作目录（这里 = 节点进程 cwd）的那一个文件
#   - 目录里只多出那一个文件（没有别的路径被写）
#   - witnessed-red：把节点侧文件名映射改掉，套件必须红
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/test1755}"
PORT="${PORT:-9755}"
BASE="http://127.0.0.1:$PORT"
ALIAS="rules-file-node"
ADMIN="rules_file_admin"
PASSWORD="Rules-File-Strong-1!"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

test "${TEST1755_SOURCE_COMMIT:-unknown}" != unknown
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
RULES_SRC="$REPO/agent-node/src/runtime/rules-file.ts"
cleanup() {
  stop_group "$NODE_PID" || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/rules-file.ts.orig" ]]; then cp "$WORK/rules-file.ts.orig" "$RULES_SRC"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok 'real Hub booted'

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test1755@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
# 🔴 节点只有在 config 里带 node_id 时才会在 hub 的 nodes 表里有一行(report_status 里
# `if (node_id) upsertNodeWithSec1Guard`);没有这一行,桌面端拿不到权威 node_id,
# 规则文件工具也定位不到它。所以像 qa-rfc024 那样预先指定一个,并绑进 token。
NODE_ID="node_test1755_$(date +%s%N | sha256sum | head -c 12)"
NTOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || fail 'node token mint'
ok 'network-scoped node token minted'

CFG="$WORK/node/config.json"
cat >"$CFG" <<JSON
{"alias":"$ALIAS","node_id":"$NODE_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET"}
JSON

start_node() {
  NODE_PID=""
  # 🔴 cwd 就是规则文件的落点。节点从 $WORK/cwd 启动,文件必须出现在这里。
  (cd "$WORK/cwd" && exec setsid env ANTHROPIC_API_KEY=test1755-not-used HOME="$HOME" \
    bun "$REPO/agent-node/src/cli.ts" --alias "$ALIAS" --config "$CFG" >"$WORK/node.log" 2>&1) &
  NODE_PID=$!
}
stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}

# 桌面端同款:stateless tools/call 信封(agent-network-app src/api.ts callHubTool)。
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
  echo "---- /api/status ----" >&2; curl -sS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | head -c 800 >&2 || true; echo >&2
  echo "---- /api/nodes ----" >&2; curl -sS "$BASE/api/nodes" -H "Authorization: Bearer $UTOK" | head -c 800 >&2 || true; echo >&2
}
# 先等 report_status 把会话行报上来(同 test185 的判据),再取权威 node_id。60s 上限:
# 节点冷启动要加载 SDK,CI 机器慢。
wait_node_registered() {
  for _ in $(seq 1 240); do
    local id; id=$(node_id || true)
    if [[ -n "$id" ]] && [[ -n "$(status_row || true)" ]]; then printf '%s\n' "$id"; return 0; fi
    sleep 0.25
  done
  return 1
}
# 轮询到终态;打印终态 JSON。超时(本地 30s)返回 1 —— hub 自己的 timeout 是 60s,
# 这里更短是为了让「节点没响应」在套件里读起来是失败而不是 hub 的 timeout 文案。
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
ok "real agent-node registered as $ALIAS with the pre-assigned node_id"
ARGS=$(jq -nc --arg id "$NODE_ID" --arg n "$NET" '{node_id:$id,network_id:$n}')

# ── 1. 读:文件还不存在 → exists:false,content 空,文件名按 claude 运行时 = CLAUDE.md ──
ENQ=$(mcp_call read_node_rules_file "$ARGS")
RID=$(jq -r '.request_id // empty' <<<"$ENQ"); [[ "$RID" == rf_* ]] || fail "read enqueue: $ENQ"
RES=$(wait_result "$RID") || { tail -60 "$WORK/node.log"; fail "read never reached a terminal state: $RES"; }
jq -e '.status=="done" and .file_name=="CLAUDE.md" and .exists==false and .content==""' >/dev/null <<<"$RES" || fail "first read: $RES"
ok 'read before any file: done / CLAUDE.md / exists=false (claude runtime picks CLAUDE.md)'

# ── 2. 写:内容逐字落到节点 cwd 的 CLAUDE.md,目录里只多出这一个文件 ──
BODY=$'# 规则\n\n- 不碰生产 DB\n- 不往生产 IM 发探针\n'
ENQ=$(mcp_call write_node_rules_file "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --arg c "$BODY" '{node_id:$id,network_id:$n,content:$c}')")
RID=$(jq -r '.request_id // empty' <<<"$ENQ"); [[ "$RID" == rf_* ]] || fail "write enqueue: $ENQ"
RES=$(wait_result "$RID") || { tail -60 "$WORK/node.log"; fail "write never reached a terminal state: $RES"; }
jq -e '.status=="done" and .file_name=="CLAUDE.md" and (.content==null)' >/dev/null <<<"$RES" || fail "write result: $RES"
[[ -f "$WORK/cwd/CLAUDE.md" ]] || fail 'CLAUDE.md not written into node cwd'
# 🔴 逐字节比:`$(cat …)` 会吃掉末尾换行,而末尾换行也是文件的一部分。
printf '%s' "$BODY" >"$WORK/expected.md"
cmp -s "$WORK/cwd/CLAUDE.md" "$WORK/expected.md" || fail "CLAUDE.md bytes differ from what was sent: $(od -c "$WORK/cwd/CLAUDE.md" | tail -3 | tr '\n' ' ')"
# 节点自己会在 cwd 下建 .anet/(日志目录),所以分开看:非隐藏项只能是规则文件,
# 隐藏项只能是 .anet —— 任何别的东西(含隐藏的)都算「写到了别处」。
LISTING=$(ls "$WORK/cwd" | sort | tr '\n' ' ')
HIDDEN=$(ls -A "$WORK/cwd" | grep '^\.' | sort | tr '\n' ' ')
[[ "$LISTING" == "CLAUDE.md " ]] || fail "node cwd has more than the rules file: $LISTING"
[[ "$HIDDEN" == ".anet " || -z "$HIDDEN" ]] || fail "unexpected hidden entries in node cwd: $HIDDEN"
ok 'write lands verbatim in node cwd as CLAUDE.md and nothing else appears'

# ── 3. 再读:回传逐字相同 ──
ENQ=$(mcp_call read_node_rules_file "$ARGS"); RID=$(jq -r '.request_id' <<<"$ENQ")
RES=$(wait_result "$RID") || fail "re-read: $RES"
jq -e --arg b "$BODY" '.content == $b' >/dev/null <<<"$RES" || fail "re-read content differs: $(jq -c '.content' <<<"$RES" | head -c 200)"
jq -e '.exists==true' >/dev/null <<<"$RES" || fail "re-read exists flag"
ok 'read after write returns the exact content'

# ── 4. 节点离线:60s 内 hub 自己给出 timeout,文案说清两种可能 ──
stop_node
ENQ=$(mcp_call read_node_rules_file "$ARGS"); RID=$(jq -r '.request_id' <<<"$ENQ")
# 把请求做旧,省掉真等 60s(hub 判 timeout 只看 created_at/pulled_at 龄)。
sqlite3 "$WORK/hub.db" "UPDATE node_rules_requests SET created_at = created_at - 120000 WHERE request_id = '$RID';" 2>/dev/null \
  || (cd "$REPO/server" && bun -e "const {Database}=require('bun:sqlite');const db=new Database(process.argv[1]);db.run(\"UPDATE node_rules_requests SET created_at = created_at - 120000 WHERE request_id = ?\",[process.argv[2]])" "$WORK/hub.db" "$RID")
RES=$(mcp_call get_rules_file_result "$(jq -nc --arg r "$RID" --arg n "$NET" '{request_id:$r,network_id:$n}')")
jq -e '.status=="timeout" and (.error|test("did not answer"))' >/dev/null <<<"$RES" || fail "offline node should time out: $RES"
ok 'offline node → hub flips the request to timeout with a readable reason'

# ── 5. witnessed-red:节点侧文件名映射被改成 pwned.md,套件的第 2 步必须红 ──
cp "$RULES_SRC" "$WORK/rules-file.ts.orig"
node "$REPO/tests/test1755-rules-file-e2e/mutate-filename.mjs" "$RULES_SRC"
safe_rm_rf "$WORK/cwd"; mkdir -p "$WORK/cwd"
start_node
wait_node_registered >/dev/null || { dump_diag; fail 'mutated node never registered'; }
ENQ=$(mcp_call write_node_rules_file "$(jq -nc --arg id "$NODE_ID" --arg n "$NET" --arg c "$BODY" '{node_id:$id,network_id:$n,content:$c}')")
RID=$(jq -r '.request_id' <<<"$ENQ")
RES=$(wait_result "$RID") || fail "mutated write never terminal: $RES"
stop_node
cp "$WORK/rules-file.ts.orig" "$RULES_SRC"
MUT_LISTING=$(ls "$WORK/cwd" | sort | tr '\n' ' ')
[[ "$MUT_LISTING" != "CLAUDE.md " ]] || fail 'mutation stayed green: cwd still only has CLAUDE.md'
[[ -f "$WORK/cwd/pwned.md" ]] || fail "mutation did not do what it claims (no pwned.md): $MUT_LISTING"
ok "witnessed-red: with the filename mapping mutated, step 2's assertion would fail (cwd = $MUT_LISTING)"

(cd "$REPO/agent-node" && bun test src/runtime/rules-file.test.ts)
ok 'agent-node rules-file unit gates pass'
(cd "$REPO/server" && COMMHUB_DB="$WORK/unit.db" bun test src/rules-file-transport.test.ts)
ok 'hub transport unit gates pass'

printf 'source_commit=%s\n' "$TEST1755_SOURCE_COMMIT"
printf 'RESULT: PASS (%s checks)\n' "$PASS"
