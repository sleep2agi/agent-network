#!/bin/bash

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：scripts/qa.sh 缺 ARG 时
# **不传且不报错**，断言写在这里才会让缺失显形。
[[ "${TEST17_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST17_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST17_SOURCE_COMMIT"


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
# 🔴 原来是 --runtime http-api。产品已把它移出白名单，报错原文：
#   [anet] Refusing to create node: unsupported runtime "http-api"; expected one of:
#   claude-agent-sdk, claude-code-cli, codex-sdk, codex-app-server,
#   grok-build-acp, grok-build-cli, opencode-cli
# 不是回归 —— 产品加了运行时白名单，套件写在它之前（同 #1112③、#1116⑥）。
# 换成受支持的 claude-agent-sdk（create 阶段不需要外部二进制）。
# 断言的正则同步跟着换，否则文案能过而断言仍在等 http-api —— 那种绿是假的。
run_step "9" "anet node create my-first-bot --runtime claude-agent-sdk" "anet node create my-first-bot --runtime claude-agent-sdk" "一般" "runtime 需要用户自己理解，不算纯新手友好。" 'Created node "my-first-bot".*claude-agent-sdk|my-first-bot.*claude-agent-sdk'
run_step "10" "anet ls" "anet ls" "是" "如果列表为空但 create 成功，会很困惑。" 'my-first-bot'
run_step "11" "anet status" "anet status" "一般" "状态页概念对新手略抽象，需要看输出是否直观。" 'CommHub:|Agents:|Tasks:'
run_step "12" "anet doctor" "anet doctor" "是" "诊断通常是新手最能理解的反馈。" 'System Diagnostic|Result:'
# 🔴 原断言等的是 'Agent Network Dashboard|Server:' —— 那是 anet demo 的【旧行为】
# （起一个 dashboard/server）。产品已改成【列出可用演示】并 rc=0，实测输出：
#     Available demos:
#       ● debate          辩论赛 — 6 agent ...
#       ● socialmedia     社交媒体内容工厂 — 4 agent ...
#       ● pr-review       代码 PR 审查室 — 4 agent ...
# 不是回归，是产品前进、套件写在它之前。
# 🔴 断言换成【现在真实的契约】而不是放宽成"有输出就算过"：
#    匹配一条【目录条目行】—— 演示名 + 其描述里的 agent 字样。
#    这样 demo 目录被清空/改名时它仍会红，而不是"有输出就算过"。
# ⚠️ run_step 用的是 `grep -Eqi`：**逐行 + POSIX ERE**。
#    所以 \s 不受支持、跨行断言也不可能命中 —— 我第一版写了 'Available demos[\s\S]*(...)'，
#    它从一开始就匹配不到任何东西，而失败长得跟原来那条一模一样。
run_step "13" "anet demo" "timeout 5 anet demo" "一般" "列出可用演示；交互/TUI 部分在 Docker 里只能验到这一层。" '(debate|socialmedia|pr-review)[[:space:]]+.+agent'

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
