#!/usr/bin/env bash
# qa-claude-code-node-id — claude-code-cli 节点的 node_id 端到端:真 hub + 真 node-server 产物。
#
# 缺陷:claude-code-cli 节点的 MCP 通道(.anet/node-server.js)在 report_status 里从不带 node_id,
# 尽管 `anet node create` 早把 node_id 写进了节点配置。hub 只在带 node_id 时写 nodes 表,
# 而定时任务(以及桌面端「选择执行节点」)只能选 nodes 表里的节点 ⇒ 这一族在线也选不到。
#
# 这里验单测验不了的那几条:
#   - 构建出来的 node-server 产物(与 dist/src/node-server.js 同一条 bun build)真的把 node_id 报上去,
#     /api/status 的会话行和 /api/nodes 都能看到;
#   - 生产里的旧形状:token 铸造时**没**绑 node_id(RFC-036 之前的节点),只有配置里有;
#   - 配置里没有 node_id 时照旧不报,且**不**读 COMMHUB_NODE_ID 环境变量;
#   - 用户视角的结果:能对它建定时任务,run-now 的任务真的送进这个 node-server;
#   - SSE 重连后的 reregister() 也带 node_id(hub 重启 + 清掉会话的 node_id,再看它回来);
#   - 正控:去掉 node_id 的旧产物在同一判据下是红的(判据看得见缺陷)。
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/qa-claude-code-node-id}"
PORT="${PORT:-9767}"
BASE="http://127.0.0.1:$PORT"
ADMIN="cc_node_id_admin"
PASSWORD="Cc-Node-Id-Strong-1!"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; dump_diag; exit 1; }

test "${QA_CC_NODE_ID_SOURCE_COMMIT:-unknown}" != unknown
echo "source_commit=${QA_CC_NODE_ID_SOURCE_COMMIT}"
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj/.anet/nodes" "$WORK/old/.anet/nodes"
export HOME="$WORK/home"

HUB_PID=""
declare -A NODE_PIDS=()
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
cleanup() {
  for p in "${NODE_PIDS[@]}"; do stop_group "$p" || true; done
  stop_group "$HUB_PID" || true
  rm -f "$REPO/agent-network/src/node-server.qa-control.ts"
}
trap cleanup EXIT

dump_diag() {
  echo "---- hub.log (tail 30) ----" >&2; tail -30 "$WORK/hub.log" >&2 2>/dev/null || true
  for f in "$WORK"/node-*.log; do [[ -f "$f" ]] || continue; echo "---- $f (tail 20) ----" >&2; tail -20 "$f" >&2 || true; done
}

start_hub() {
  (cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >>"$WORK/hub.log" 2>&1) &
  HUB_PID=$!
  for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && return 0; sleep 0.25; done
  return 1
}
start_hub || fail 'hub boot'
ok 'real Hub booted on a throwaway port + DB'

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"qa-cc-node-id@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
ok 'admin registered'

rand() { date +%s%N | sha256sum | head -c 8; }
LEGACY_ALIAS="cc-legacy-node";  LEGACY_ID="n_$(rand)"
BOUND_ALIAS="cc-bound-node";    BOUND_ID="n_$(rand)"
NOID_ALIAS="cc-no-id-node";     DECOY_ID="n_decoy$(rand)"
OLD_ALIAS="cc-old-bundle-node"; OLD_ID="n_$(rand)"

# 生产里 claude-code 节点的 token 多数是 RFC-036 之前铸的:**不带** node_id(未绑定)。
mint() {
  local name="$1" nid="${2:-}" body
  if [[ -n "$nid" ]]; then body="{\"network_id\":\"$NET\",\"node_name\":\"$name\",\"node_id\":\"$nid\"}"
  else body="{\"network_id\":\"$NET\",\"node_name\":\"$name\"}"; fi
  curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' -d "$body" | jq -r '.token // empty'
}
LEGACY_TOK=$(mint "$LEGACY_ALIAS")
BOUND_TOK=$(mint "$BOUND_ALIAS" "$BOUND_ID")
NOID_TOK=$(mint "$NOID_ALIAS")
OLD_TOK=$(mint "$OLD_ALIAS")
for t in "$LEGACY_TOK" "$BOUND_TOK" "$NOID_TOK" "$OLD_TOK"; do [[ "$t" == ntok_* ]] || fail 'node token mint'; done
ok 'four node tokens minted (three unbound legacy-shape, one bound)'

# 节点配置:`anet node create` 写下的形状,路径 = <project>/.anet/nodes/<alias>/config.json。
write_cfg() {
  local proj="$1" alias="$2" nid="$3" tok="$4"
  mkdir -p "$proj/.anet/nodes/$alias"
  if [[ -n "$nid" ]]; then
    printf '{"anet_version":"0.1.0","node_id":"%s","node_name":"%s","runtime":"claude-code-cli","hub":"%s","token":"%s"}\n' "$nid" "$alias" "$BASE" "$tok" >"$proj/.anet/nodes/$alias/config.json"
  else
    printf '{"anet_version":"0.1.0","node_name":"%s","runtime":"claude-code-cli","hub":"%s","token":"%s"}\n' "$alias" "$BASE" "$tok" >"$proj/.anet/nodes/$alias/config.json"
  fi
}
# 同一个项目目录下几个节点共用一份 .anet/node-server.js(生产里多个 claude-code 节点就是这样)。
write_cfg "$WORK/proj" "$LEGACY_ALIAS" "$LEGACY_ID" "$LEGACY_TOK"
write_cfg "$WORK/proj" "$BOUND_ALIAS" "$BOUND_ID" "$BOUND_TOK"
write_cfg "$WORK/proj" "$NOID_ALIAS" "" "$NOID_TOK"
write_cfg "$WORK/old" "$OLD_ALIAS" "$OLD_ID" "$OLD_TOK"

# 与 agent-network 的 build 脚本同一条 bun build(那边之后只多一步混淆)。
(cd "$REPO/agent-network" && bun build src/node-server.ts --target node --minify --outfile "$WORK/proj/.anet/node-server.js" >"$WORK/build.log" 2>&1) \
  || { cat "$WORK/build.log" >&2; fail 'bundle node-server'; }
ok 'node-server bundled the same way as dist/src/node-server.js'

# 正控用的「修复前」产物:把三处载荷里的 node_id 去掉,其它逐字相同。写成同目录的旁路文件
# (相对 import 照样解析),不就地改 node-server.ts —— 中途被打断也不会留下改坏的源码。
CONTROL_SRC="$REPO/agent-network/src/node-server.qa-control.ts"
python3 - "$REPO/agent-network/src/node-server.ts" "$CONTROL_SRC" <<'PY'
import pathlib, re, sys
s = pathlib.Path(sys.argv[1]).read_text()
n = len(re.findall(r"^\s*node_id: NODE_ID,\n", s, re.M))
if n != 3: raise SystemExit(f"expected 3 node_id payload lines, got {n}")
pathlib.Path(sys.argv[2]).write_text(re.sub(r"^\s*node_id: NODE_ID,\n", "", s, flags=re.M))
PY
build_rc=0
(cd "$REPO/agent-network" && bun build "$CONTROL_SRC" --target node --minify --outfile "$WORK/old/.anet/node-server.js" >"$WORK/build-old.log" 2>&1) || build_rc=$?
rm -f "$CONTROL_SRC"
[[ $build_rc -eq 0 ]] || { cat "$WORK/build-old.log" >&2; fail 'bundle pre-fix control'; }
cmp -s "$WORK/proj/.anet/node-server.js" "$WORK/old/.anet/node-server.js" && fail 'pre-fix control bundle is byte-identical (mutation was a no-op)'
ok 'pre-fix control bundle built (node_id removed from the three payloads)'

# 像 claude 那样起它:cwd = 项目目录,`bun .anet/node-server.js`(.mcp.json 里的命令),stdin 保持打开。
start_cc() {
  local proj="$1" alias="$2" tok="$3"; shift 3
  (cd "$proj" && exec setsid env "$@" HOME="$HOME" COMMHUB_URL="$BASE" COMMHUB_ALIAS="$alias" COMMHUB_TOKEN="$tok" \
    bash -c 'sleep infinity | bun .anet/node-server.js' >"$WORK/node-$alias.log" 2>&1) &
  NODE_PIDS[$alias]=$!
}
start_cc "$WORK/proj" "$LEGACY_ALIAS" "$LEGACY_TOK" -u COMMHUB_NODE_ID
start_cc "$WORK/proj" "$BOUND_ALIAS" "$BOUND_TOK" -u COMMHUB_NODE_ID
# 继承来的 COMMHUB_NODE_ID(claude 常从别的节点的 shell 里起)不能被当成自己的身份。
start_cc "$WORK/proj" "$NOID_ALIAS" "$NOID_TOK" COMMHUB_NODE_ID="$DECOY_ID"
start_cc "$WORK/old" "$OLD_ALIAS" "$OLD_TOK" -u COMMHUB_NODE_ID

status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$1" '[.sessions[]? | select(.alias==$a)][0] // empty'
}
nodes_json() { curl -fsS "$BASE/api/nodes" -H "Authorization: Bearer $UTOK"; }
session_node_id() { status_row "$1" | jq -r '.node_id // empty'; }
wait_session() {
  for _ in $(seq 1 120); do [[ -n "$(status_row "$1" || true)" ]] && return 0; sleep 0.25; done
  return 1
}
for a in "$LEGACY_ALIAS" "$BOUND_ALIAS" "$NOID_ALIAS" "$OLD_ALIAS"; do
  wait_session "$a" || fail "session row for $a never appeared"
  grep -q "registered as \"$a\"" "$WORK/node-$a.log" || fail "$a node-server did not log a successful register"
done
ok 'all four node-server processes registered with the Hub'

[[ "$(session_node_id "$LEGACY_ALIAS")" == "$LEGACY_ID" ]] || fail "legacy-token node: /api/status node_id=$(session_node_id "$LEGACY_ALIAS") want $LEGACY_ID"
ok 'unbound-token node: /api/status carries the node_id from its config'
[[ "$(session_node_id "$BOUND_ALIAS")" == "$BOUND_ID" ]] || fail "bound-token node: /api/status node_id=$(session_node_id "$BOUND_ALIAS") want $BOUND_ID"
ok 'bound-token node: /api/status carries the node_id from its config'

NODES=$(nodes_json)
[[ "$(jq -r --arg id "$LEGACY_ID" '[.nodes[] | select(.node_id==$id) | .alias][0] // empty' <<<"$NODES")" == "$LEGACY_ALIAS" ]] \
  || fail 'unbound-token node has no /api/nodes row (what the schedule picker lists)'
ok 'unbound-token node: /api/nodes has its row (the schedule picker source)'
[[ "$(jq -r --arg id "$BOUND_ID" '[.nodes[] | select(.node_id==$id) | .alias][0] // empty' <<<"$NODES")" == "$BOUND_ALIAS" ]] \
  || fail 'bound-token node has no /api/nodes row'
ok 'bound-token node: /api/nodes has its row'
[[ "$(jq -r --arg id "$LEGACY_ID" '[.nodes[] | select(.node_id==$id) | .runtime][0] // empty' <<<"$NODES")" == "claude-code" ]] \
  || fail 'nodes row runtime is not the claude-code agent label'
ok 'nodes row records the claude-code runtime label'

[[ -z "$(session_node_id "$NOID_ALIAS")" ]] || fail "config without node_id still reported one: $(session_node_id "$NOID_ALIAS")"
ok 'config without node_id: nothing reported (no invented id)'
[[ -z "$(jq -r --arg a "$NOID_ALIAS" '.nodes[] | select(.alias==$a) | .node_id' <<<"$NODES")" ]] || fail 'config without node_id produced a nodes row'
[[ -z "$(jq -r --arg id "$DECOY_ID" '.nodes[] | select(.node_id==$id) | .node_id' <<<"$NODES")" ]] || fail 'inherited COMMHUB_NODE_ID claimed a nodes row'
ok 'inherited COMMHUB_NODE_ID env is ignored (no row claimed)'

# 正控:修复前的产物,同一判据 ⇒ 红(node_id 空、nodes 表没有它)。
[[ -z "$(session_node_id "$OLD_ALIAS")" ]] || fail 'pre-fix control unexpectedly reported node_id — the check cannot see the defect'
[[ -z "$(jq -r --arg id "$OLD_ID" '.nodes[] | select(.node_id==$id) | .node_id' <<<"$NODES")" ]] || fail 'pre-fix control has a nodes row'
ok 'positive control: pre-fix bundle leaves node_id null and no nodes row (the production symptom)'

# 用户视角:能对它建定时任务;对修复前的那个不能。
mk_schedule() {
  curl -sS -X POST "$BASE/api/scheduled-tasks" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET\",\"name\":\"$2\",\"task\":\"$3\",\"target_node_id\":\"$1\",\"schedule\":{\"type\":\"daily\",\"time\":\"03:00\"},\"timezone\":\"UTC\"}"
}
MARK="qa-cc-node-id-run-$(rand)"
SCH=$(mk_schedule "$LEGACY_ID" "cc legacy" "$MARK")
SCHED_ID=$(jq -r '.schedule.id // .schedule.schedule_id // .id // .schedule_id // empty' <<<"$SCH")
[[ -n "$SCHED_ID" ]] || fail "schedule create against the claude-code node failed: $SCH"
ok 'a scheduled task can be created against the claude-code node'
OLD_SCH=$(mk_schedule "$OLD_ID" "cc old" "never")
grep -q 'target_node_not_found' <<<"$OLD_SCH" || fail "pre-fix control: expected target_node_not_found, got $OLD_SCH"
ok 'positive control: the pre-fix node cannot be targeted (target_node_not_found)'

RUN=$(curl -sS -X POST "$BASE/api/scheduled-tasks/$SCHED_ID/run-now" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' -d '{}')
jq -e '.ok != false' <<<"$RUN" >/dev/null || fail "run-now failed: $RUN"
delivered=0
for _ in $(seq 1 80); do
  if grep -q "injected task .* from scheduler: $MARK" "$WORK/node-$LEGACY_ALIAS.log"; then delivered=1; break; fi
  sleep 0.25
done
[[ $delivered -eq 1 ]] || fail 'run-now task never reached the claude-code node-server'
ok 'run-now task was delivered into the claude-code node-server'

# reregister():hub 重启 + 把会话的 node_id 清掉(只动这个一次性 DB),SSE 重连后它必须带回来。
stop_group "$HUB_PID"; HUB_PID=""
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
const r = db.run("UPDATE sessions SET node_id = NULL WHERE alias IN (?1, ?2)", [process.argv[2], process.argv[3]]);
if (r.changes !== 2) { console.error("cleared", r.changes); process.exit(1); }
db.close();
' "$WORK/hub.db" "$LEGACY_ALIAS" "$BOUND_ALIAS" || fail 'clear session node_id in throwaway DB'
start_hub || fail 'hub reboot'
back=0
for _ in $(seq 1 240); do
  if [[ "$(session_node_id "$LEGACY_ALIAS" || true)" == "$LEGACY_ID" && "$(session_node_id "$BOUND_ALIAS" || true)" == "$BOUND_ID" ]]; then back=1; break; fi
  sleep 0.25
done
[[ $back -eq 1 ]] || fail 'node_id did not come back after SSE reconnect (reregister path)'
grep -q "re-registered as \"$LEGACY_ALIAS\" after SSE reconnect" "$WORK/node-$LEGACY_ALIAS.log" || fail 'no reregister log line — node_id came back by another path'
ok 'SSE reconnect reregister() restores node_id'

# 下线上报不带 node_id,hub 侧 COALESCE 不能把它抹掉。
stop_group "${NODE_PIDS[$LEGACY_ALIAS]}"; unset 'NODE_PIDS[$LEGACY_ALIAS]'
gone=0
for _ in $(seq 1 80); do [[ "$(status_row "$LEGACY_ALIAS" | jq -r '.status // empty')" == offline ]] && { gone=1; break; }; sleep 0.25; done
[[ $gone -eq 1 ]] || fail 'node-server shutdown did not report offline'
[[ "$(session_node_id "$LEGACY_ALIAS")" == "$LEGACY_ID" ]] || fail 'offline report wiped the session node_id'
ok 'offline report keeps the node_id (still targetable while offline)'

[[ ! -e "$REPO/agent-network/src/node-server.qa-control.ts" ]] || fail 'control source left behind'
ok 'control source removed after the control build'

echo "RESULT: PASS ($PASS checks)"
