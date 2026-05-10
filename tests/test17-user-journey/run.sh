#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
REPORT="/tmp/test17-report.log"
: >"$REPORT"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

record_step() {
  local step="$1"
  local success="$2"
  local friendly="$3"
  local confusing="$4"
  local output="$5"
  {
    echo "### ${step}"
    echo "- 结果: ${success}"
    echo "- 输出是否用户友好: ${friendly}"
    echo "- 困惑点: ${confusing}"
    echo "- 输出摘录:"
    echo '```text'
    printf "%s\n" "$output" | tail -20
    echo '```'
    echo ""
  } >>"$REPORT"
}

run_step() {
  local num="$1"
  local title="$2"
  local cmd="$3"
  local friendly="$4"
  local confusing="$5"
  local success_pattern="$6"

  echo "${num}. ${title}"
  local out
  out=$(bash -lc "$cmd" 2>&1 || true)
  printf "%s\n" "$out"

  if printf "%s\n" "$out" | grep -Eqi "$success_pattern"; then
    pass "$title"
    record_step "${num}. ${title}" "成功" "$friendly" "$confusing" "$out"
  else
    fail "$title"
    record_step "${num}. ${title}" "失败" "$friendly" "$confusing" "$out"
  fi
  echo ""
}

echo ""
echo "═══ Test 17: Real User Journey ═══"
echo ""

echo "# Test 17 User Journey Report" >"$REPORT"
echo "" >>"$REPORT"
echo "环境：Docker 内 npm 全新安装，按真实用户顺序操作。" >>"$REPORT"
echo "" >>"$REPORT"

echo "1. npm packages installed"
commhub-server --help >/dev/null 2>&1 && anet --help >/dev/null 2>&1 && agent-node --help >/dev/null 2>&1
if [ $? -eq 0 ]; then
  pass "npm install -g 三个包"
  record_step "1. npm i -g 三个包（preview）" "成功" "是" "无。安装后命令可直接用。" "commhub-server / anet / agent-node commands available"
else
  fail "npm install -g 三个包"
  record_step "1. npm i -g 三个包（preview）" "失败" "否" "安装后命令不可用。" "package commands missing"
fi
echo ""

echo "2. Start server"
bunx @sleep2agi/commhub-server >/tmp/test17-server.log 2>&1 &
sleep 4
HC=$(curl -s "$BASE/health" || true)
if echo "$HC" | grep -q '"ok":true'; then
  pass "bunx server start"
  record_step "2. bunx @sleep2agi/commhub-server &" "成功" "一般" "需要用户自己猜端口和等待时间。" "$HC"
else
  fail "bunx server start"
  record_step "2. bunx @sleep2agi/commhub-server &" "失败" "否" "server 启动失败时没有更上层引导。" "$(cat /tmp/test17-server.log)"
fi
echo ""

run_step "3" "health check" "curl -s $BASE/health" "一般" "需要用户手动知道 health URL。" '"ok":true'
run_step "4" "anet init --hub http://127.0.0.1:9200" "printf '\n' | anet init --hub http://127.0.0.1:9200" "一般" "仍会提示 Auth token（即使可以留空），新手会疑惑。" 'Saved to '
run_step "5" "anet register --username newbie --password pass123456" "anet register --username newbie --password pass123456" "否" "如果仍进入交互或提示额外字段，新手会卡住。" 'registered|created|success|network_token|utok_'
run_step "6" "anet login --username newbie --password pass123456" "anet login --username newbie --password pass123456" "一般" "依赖上一步是否真正注册成功。" 'logged in|login successful|token|utok_'
run_step "7" "anet whoami" "anet whoami" "是" "如果失败，通常说明登录态没有写清楚。" 'newbie|username'
run_step "8" "anet network ls" "anet network ls" "是" "默认网络命名若不明显，用户会不知道下一步怎么选。" 'default|network_id|owner'
run_step "9" "anet node create my-first-bot --runtime http-api" "anet node create my-first-bot --runtime http-api" "一般" "runtime/http-api 需要用户自己理解，不算纯新手友好。" 'Created node "my-first-bot".*http-api|my-first-bot.*http-api'
run_step "10" "anet ls" "anet ls" "是" "如果列表为空但 create 成功，会很困惑。" 'my-first-bot'
run_step "11" "anet status" "anet status" "一般" "状态页概念对新手略抽象，需要看输出是否直观。" 'CommHub:|Agents:|Tasks:'
run_step "12" "anet doctor" "anet doctor" "是" "诊断通常是新手最能理解的反馈。" 'System Diagnostic|Result:'
run_step "13" "anet demo" "timeout 5 anet demo" "一般" "如果是交互/TUI，Docker 里可能难以验证，只能看是否能启动。" 'Agent Network Dashboard|Server:'

{
  echo "## Summary"
  echo ""
  echo "- Results: $PASS passed, $FAIL failed"
} >>"$REPORT"

cat "$REPORT"
echo ""
echo "═══════════════════════════════════"
echo "  Test 17 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1
