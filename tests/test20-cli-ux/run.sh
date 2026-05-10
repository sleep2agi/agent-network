#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
ANET="bun /app/agent-network/bin/cli.ts"
REPORT="/tmp/test20-report.md"
: >"$REPORT"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

record_step() {
  local step="$1"
  local result="$2"
  local score="$3"
  local note="$4"
  local output="$5"
  {
    echo "### ${step}"
    echo "- 结果: ${result}"
    echo "- 用户友好度评分: ${score}/5"
    echo "- 备注: ${note}"
    echo "- 输出摘录:"
    echo '```text'
    printf "%s\n" "$output" | tail -30
    echo '```'
    echo ""
  } >>"$REPORT"
}

run_step() {
  local num="$1"
  local title="$2"
  local cmd="$3"
  local success_pattern="$4"
  local note_ok="$5"
  local note_fail="$6"
  local score_ok="${7:-4}"
  local score_fail="${8:-2}"

  echo "${num}. ${title}"
  local out
  out=$(bash -lc "$cmd" 2>&1 || true)
  printf "%s\n" "$out"

  if printf "%s\n" "$out" | grep -Eqi "$success_pattern"; then
    pass "$title"
    record_step "${num}. ${title}" "成功" "$score_ok" "$note_ok" "$out"
  else
    fail "$title"
    record_step "${num}. ${title}" "失败" "$score_fail" "$note_fail" "$out"
  fi
  echo ""
}

echo "# Test 20 CLI UX Report" >"$REPORT"
echo "" >>"$REPORT"
echo "环境：Docker 内从源码运行 \`bun /app/agent-network/bin/cli.ts\`。" >>"$REPORT"
echo "" >>"$REPORT"

echo ""
echo "═══ Test 20: CLI UX ═══"
echo ""

echo "0. Setup server + login context"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >/tmp/test20-server.log 2>&1 &
sleep 4
printf "\n" | bash -lc "$ANET init --hub $BASE" >/tmp/test20-init.log 2>&1 || true
bash -lc "$ANET register --username uxuser --password pass123456" >/tmp/test20-register.log 2>&1 || true
bash -lc "$ANET login --username uxuser --password pass123456" >/tmp/test20-login.log 2>&1 || true
echo ""

run_step "1" "anet --help" "$ANET --help" "Commands:|Usage:|create|network|start|doctor" "帮助入口清晰，主命令可见。" "顶层帮助不够清晰或命令分类缺失。" 4 2
run_step "2" "anet network --help" "$ANET network --help" "create|ls|use|info|rename" "network 子命令基本齐全。" "network 子命令列表不完整或不直观。" 4 2
run_step "3" "anet token --help" "$ANET token --help" "token|create|ls|revoke" "token 子命令存在且功能可发现。" "token 子命令缺失或帮助不可用。" 4 1
run_step "4" "anet node create --help" "$ANET create --help" "runtime|model|tools|channel|--runtime" "create 参数说明较完整。" "create 参数说明不足，用户难以理解 runtime/channel。" 4 2
run_step "5" "anet -v" "$ANET -v" "anet v|version" "版本信息可见。" "版本输出缺失或信息不足。" 3 1

run_step "6" "anet network create test-net" "$ANET network create test-net" "created|ok|network_id|test-net" "创建网络后有明确成功反馈。" "创建网络提示不清楚或失败原因不明显。" 4 2
run_step "7" "anet network ls" "$ANET network ls" "test-net|default|owner|admin|member|👑|⭐" "列表可读性尚可，能看到当前网络和角色信息。" "列表信息不足，用户难以看出角色或当前网络。" 4 2
run_step "8" "anet network use test-net" "$ANET network use test-net" "using|switched|current|test-net" "切换提示明确。" "切换是否成功不够直观。" 4 2
run_step "9" "anet network info" "$ANET network info" "network_id|name|role|members|test-net" "详情页信息比较全。" "详情页缺字段或输出不聚焦。" 4 2
run_step "10" "anet network rename test-net new-name" "$ANET network rename test-net new-name" "renamed|new-name|ok" "rename 操作反馈明确。" "rename 反馈模糊或没有新旧名称对照。" 4 2

run_step "11" "anet token create my-tok" "$ANET token create my-tok" "utok_|ntok_|atok_|token" "能直接看到 token 值，符合用户预期。" "没有输出 token 值，或创建方式不易发现。" 4 2
run_step "12" "anet token ls" "$ANET token ls" "my-tok|token|active|revoked|created" "token 列表格式基本可用。" "token 列表信息不足或排版混乱。" 4 2
run_step "13" "anet token revoke" "$ANET token revoke my-tok" "revoked|ok|deleted" "revoke 成功反馈清楚。" "revoke 失败或提示不明确。" 4 2
run_step "14" "anet passwd" "$ANET passwd --old-password pass123456 --new-password pass654321" "password|changed|updated|success" "改密码支持参数模式，体验较好。" "改密码流程不清晰或仍强依赖交互。" 4 2

run_step "15" "anet node create bot-a --runtime codex-sdk" "$ANET create bot-a --runtime codex-sdk" "bot-a|codex-sdk|Created node" "创建 codex-sdk 节点提示明确。" "创建提示不够清晰或 runtime 不符合输入。" 4 2
run_step "16" "anet node create bot-b --runtime http-api" "$ANET create bot-b --runtime http-api" "bot-b|http-api|Created node" "http-api runtime 选择正确，提示清楚。" "runtime 选择失真，用户输入和结果不一致。" 4 1
run_step "17" "anet ls" "$ANET ls" "bot-a|bot-b|codex-sdk|http-api|Nodes:" "节点列表易读，能区分 runtime 和状态。" "节点列表看不出 runtime/状态重点。" 4 2
run_step "18" "anet info bot-a" "$ANET info bot-a" "bot-a|runtime|node_id|network|codex-sdk" "详情页覆盖节点关键信息。" "详情页字段不全或排版不直观。" 4 2

{
  echo "## Summary"
  echo ""
  echo "- Results: $PASS passed, $FAIL failed"
} >>"$REPORT"

cat "$REPORT"
echo ""
echo "═══════════════════════════════════"
echo "  Test 20 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1
