#!/bin/bash
set +e

BASE="http://127.0.0.1:9200"
BASE2="http://127.0.0.1:9300"
ANET="bun run /app/agent-network/bin/cli.ts"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
PASS=0
FAIL=0

record() {
  local n="$1"
  local title="$2"
  local cmd="$3"
  local output="$4"
  local result="$5"
  local note="$6"
  if [ "$result" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  echo "## ${n}. ${title}"
  echo ""
  echo "结果：**${result}**"
  echo ""
  echo "命令："
  echo '```bash'
  echo "$cmd"
  echo '```'
  echo ""
  echo "输出："
  echo '```text'
  printf "%s\n" "$output"
  echo '```'
  echo ""
  echo "说明：${note}"
  echo ""
}

start_source_server() {
  local port="$1"
  cd /app/server
  PORT="$port" COMMHUB_AUTH_TOKEN="$AUTH_TOKEN" bun run src/index.ts >/tmp/test21-server-$port.log 2>&1 &
  local pid=$!
  sleep 4
  echo "$pid"
}

health_ok() {
  local url="$1"
  curl -s "$url/health" | grep -q '"ok":true'
}

json_get() {
  python3 -c 'import json,sys; data=json.load(sys.stdin); path=sys.argv[1].split("."); cur=data
for key in path:
    if isinstance(cur, dict):
        cur=cur.get(key, "")
    elif isinstance(cur, list) and key.isdigit():
        idx=int(key); cur=cur[idx] if idx < len(cur) else ""
    else:
        cur=""
        break
print("" if cur is None else cur)' "$1" 2>/dev/null
}

echo "# Test 21: quickstart / server local UX"
echo ""

SERVER1_PID=$(start_source_server 9200)

QSHOME=/tmp/test21-qs-home
QSPROJ=/tmp/test21-qs-proj
rm -rf "$QSHOME" "$QSPROJ"
mkdir -p "$QSPROJ"

QS_CMD="anet quickstart --username qs1 --password pass123456 --agent qs-agent"
QS_OUT=$(cd "$QSPROJ" && printf '\n' | HOME="$QSHOME" $ANET quickstart --username qs1 --password pass123456 --agent qs-agent 2>&1)
if echo "$QS_OUT" | grep -q "设置完成" && [ -f "$QSHOME/.anet/config.json" ]; then
  record 1 "quickstart 非交互模式全流程" "$QS_CMD" "$QS_OUT" "PASS" "命令能自动完成 hub、注册/登录、创建首个 agent。"
else
  record 1 "quickstart 非交互模式全流程" "$QS_CMD" "$QS_OUT" "FAIL" "quickstart 没能完整走完。"
fi

CFG_PATH="$QSHOME/.anet/config.json"
CFG_SUMMARY=$(cat "$CFG_PATH" 2>/dev/null)
CFG_HUB=$(cat "$CFG_PATH" | json_get "hub")
CFG_TOKEN=$(cat "$CFG_PATH" | json_get "token")
CFG_NET=$(cat "$CFG_PATH" | json_get "network_id")
if [ "$CFG_HUB" = "$BASE" ] && echo "$CFG_TOKEN" | grep -q '^utok_' && echo "$CFG_NET" | grep -q '^net_'; then
  record 2 "quickstart 后 ~/.anet/config.json 正确" "cat ~/.anet/config.json" "$CFG_SUMMARY" "PASS" "hub、token、network_id 都已写入。"
else
  record 2 "quickstart 后 ~/.anet/config.json 正确" "cat ~/.anet/config.json" "$CFG_SUMMARY" "FAIL" "config 缺少关键字段或字段值不对。"
fi

WHOAMI_OUT=$(HOME="$QSHOME" $ANET whoami 2>&1)
if echo "$WHOAMI_OUT" | grep -q "qs1"; then
  record 3 "quickstart 后 anet whoami 可用" "anet whoami" "$WHOAMI_OUT" "PASS" "登录态和用户信息可直接使用。"
else
  record 3 "quickstart 后 anet whoami 可用" "anet whoami" "$WHOAMI_OUT" "FAIL" "whoami 没拿到用户信息。"
fi

NETLS_OUT=$(HOME="$QSHOME" $ANET network ls 2>&1)
if echo "$NETLS_OUT" | grep -q "default"; then
  record 4 "quickstart 后 anet network ls 显示 default 网络" "anet network ls" "$NETLS_OUT" "PASS" "默认网络能显示出来。"
else
  record 4 "quickstart 后 anet network ls 显示 default 网络" "anet network ls" "$NETLS_OUT" "FAIL" "没有看到 default 网络。"
fi

DOCTOR_OUT=$(HOME="$QSHOME" $ANET doctor 2>&1)
if ! echo "$DOCTOR_OUT" | grep -q "❌" && ! echo "$DOCTOR_OUT" | grep -q "⚠"; then
  record 5 "quickstart 后 anet doctor 全绿" "anet doctor" "$DOCTOR_OUT" "PASS" "当前环境下 doctor 没报错也没 warning。"
else
  record 5 "quickstart 后 anet doctor 全绿" "anet doctor" "$DOCTOR_OUT" "FAIL" "doctor 仍有 warning / error，这说明 quickstart 后环境还不是全就绪。"
fi

kill "$SERVER1_PID" >/dev/null 2>&1
wait "$SERVER1_PID" >/dev/null 2>&1

LOCALHOME=/tmp/test21-local-home
rm -rf "$LOCALHOME"
LOCAL_CMD="anet hub start --username local1 --password pass123456"
HOME="$LOCALHOME" $ANET server local --username local1 --password pass123456 >/tmp/test21-server-local.out 2>&1 &
LOCAL_PID=$!
sleep 8
LOCAL_OUT=$(cat /tmp/test21-server-local.out 2>/dev/null)

if echo "$LOCAL_OUT" | grep -q 'Logged in as "local1"'; then
  record 6 "server local 自动注册+登录" "$LOCAL_CMD" "$LOCAL_OUT" "PASS" "命令能起服务并自动完成注册登录。"
else
  record 6 "server local 自动注册+登录" "$LOCAL_CMD" "$LOCAL_OUT" "FAIL" "输出里没有看到自动登录成功。"
fi

HEALTH_OUT=$(curl -s "$BASE/health" 2>&1)
if echo "$HEALTH_OUT" | grep -q '"ok":true'; then
  record 7 "server local 启动后 health check 通过" "curl $BASE/health" "$HEALTH_OUT" "PASS" "服务在前台运行时健康检查正常。"
else
  record 7 "server local 启动后 health check 通过" "curl $BASE/health" "$HEALTH_OUT" "FAIL" "health check 未通过。"
fi

STATUS_OUT=$(HOME="$LOCALHOME" $ANET status 2>&1)
if echo "$STATUS_OUT" | grep -q "CommHub: http://127.0.0.1:9200"; then
  record 8 "server local 启动后另一个终端能 anet status" "anet status" "$STATUS_OUT" "PASS" "同一用户配置下，另一个终端能直接连上本地服务。"
else
  record 8 "server local 启动后另一个终端能 anet status" "anet status" "$STATUS_OUT" "FAIL" "status 没能连上本地服务。"
fi

kill -INT "$LOCAL_PID" >/dev/null 2>&1
sleep 3
POST_KILL_HEALTH=$(curl -s "$BASE/health" 2>&1)
if ! echo "$POST_KILL_HEALTH" | grep -q '"ok":true'; then
  record 9 "Ctrl+C 后 server 停止" "Ctrl+C / SIGINT anet hub start" "$POST_KILL_HEALTH" "PASS" "SIGINT 后健康检查失败，说明服务已停止。"
else
  record 9 "Ctrl+C 后 server 停止" "Ctrl+C / SIGINT anet hub start" "$POST_KILL_HEALTH" "FAIL" "SIGINT 后服务仍然存活。"
fi

SERVER2_PID=$(start_source_server 9200)

QS2_OUT=$(cd "$QSPROJ" && printf '\n' | HOME="$QSHOME" $ANET quickstart --username qs1 --password pass123456 --agent qs-agent 2>&1)
if echo "$QS2_OUT" | grep -q "已登录" && echo "$QS2_OUT" | grep -q 'Agent "qs-agent" 已存在'; then
  record 10 "跑两次 quickstart 第二次识别已登录并跳过" "$QS_CMD" "$QS2_OUT" "PASS" "第二次 quickstart 能识别登录态和已存在 agent。"
else
  record 10 "跑两次 quickstart 第二次识别已登录并跳过" "$QS_CMD" "$QS2_OUT" "FAIL" "重复 quickstart 没有清楚识别已登录或已存在 agent。"
fi

CREATE_DUP_OUT=$(cd "$QSPROJ" && HOME="$QSHOME" $ANET create qs-agent --runtime codex-sdk 2>&1)
if echo "$CREATE_DUP_OUT" | grep -q 'already exists'; then
  record 11 "跑两次 anet node create same-name 重复提示" "anet node create qs-agent --runtime codex-sdk" "$CREATE_DUP_OUT" "PASS" "重复创建会明确提示节点已存在。"
else
  record 11 "跑两次 anet node create same-name 重复提示" "anet node create qs-agent --runtime codex-sdk" "$CREATE_DUP_OUT" "FAIL" "重复创建提示不明确。"
fi

SERVER3_PID=$(start_source_server 9300)
INIT_SWAP_OUT=$(HOME="$QSHOME" $ANET init --hub "$BASE2" --token "$AUTH_TOKEN" 2>&1)
if echo "$INIT_SWAP_OUT" | grep -q "Saved to" && echo "$INIT_SWAP_OUT" | grep -q "$BASE2"; then
  record 12 "登录后再 anet init 换 hub 提示清楚" "anet init --hub $BASE2 --token $AUTH_TOKEN" "$INIT_SWAP_OUT" "PASS" "能成功切换 hub，但不会提醒旧 token / network 语义是否变化，这一点仍可优化。"
else
  record 12 "登录后再 anet init 换 hub 提示清楚" "anet init --hub $BASE2 --token $AUTH_TOKEN" "$INIT_SWAP_OUT" "FAIL" "切换 hub 时提示不清楚或操作失败。"
fi

kill "$SERVER2_PID" >/dev/null 2>&1
wait "$SERVER2_PID" >/dev/null 2>&1
kill "$SERVER3_PID" >/dev/null 2>&1
wait "$SERVER3_PID" >/dev/null 2>&1

cat <<EOF
## Summary

- Passed: ${PASS}
- Failed: ${FAIL}

观察：

- \`quickstart\` 在非交互模式下可以把账号、网络、agent 初始化串起来，但 \`doctor\` 是否全绿取决于 runtime 依赖是否完整，不一定能天然满足。
- \`server local\` 的核心体验是对的：起服、自动登录、另一个终端可用、Ctrl+C 能停；但它强依赖 \`bunx @sleep2agi/commhub-server\` 拉起服务。
- 重复操作的幂等体验总体不错，尤其是 \`quickstart\` 二次执行和重复 \`create\`。
- \`init\` 换 hub 时目前更像“静默覆盖配置”，如果能明确提示“将切换当前 hub / 可能影响已登录状态”，体验会更稳。

EOF
