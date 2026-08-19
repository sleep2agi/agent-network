#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
ANET="bun /app/agent-network/bin/cli.ts"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  npm Install New User Flow"
echo "========================================="
echo ""

echo "1. Package versions..."
commhub-server --help 2>&1 | head -5 >/tmp/commhub-help.txt || true
PKG_VER=$(npm list -g @sleep2agi/commhub-server --depth=0 2>/dev/null | awk -F'@sleep2agi/commhub-server@' '/@sleep2agi\/commhub-server@/ {print $2; exit}')
# 🔴 原来这里是逐字相等：[ "$PKG_VER" = "0.5.0-preview.28" ]。
# Dockerfile 装的是移动 tag @preview，所以这个钉子必然随发版腐烂 ——
# 实测已经是 0.9.0-preview.29，包正常前进反而把门打红。
# 版本类断言要写成【地板/形状】而不是逐字相等，否则「变好」也会红。
# 这个套件的真实意图是「npm 包装得上且能用」，不是「必须是某一版」。
[[ "$PKG_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] \
  && pass "commhub-server installed (version=$PKG_VER)" \
  || fail "commhub-server version unusable: ${PKG_VER:-missing}"
$ANET -v 2>&1 | grep -q "anet v" && pass "anet version available" || fail "anet version missing"
agent-node --version 2>&1 | grep -q "agent-node" && pass "agent-node version available" || fail "agent-node version missing"
echo ""

echo "2. Start server..."
# 🔴 原来是 `bunx @sleep2agi/commhub-server` —— 它在【运行时】再去拉一份，
# 而 Dockerfile 第 6 行已经 `npm i -g` 装好了。本套件要验的正是「装上的那份能用」，
# bunx 反而把被测对象换成了另一份（且依赖运行时网络）。改用已安装的二进制。
# 实测：用已安装的 commhub-server 起，/health 返回 200，banner 打出 v0.9.0-preview.29。
commhub-server --port 9200 > /tmp/npm-install-server.log 2>&1 &
# 🔴 原来是固定 sleep 4。改成轮询就绪，而且判据是 /health 的响应体，不是启动横幅
#（横幅先于就绪打印）。最多等 30s。
for _ in $(seq 1 30); do
  curl -s "$BASE/health" 2>/dev/null | grep -q '"ok":true' && break
  sleep 1
done
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started from npm package" || { tail -5 /tmp/npm-install-server.log; fail "server failed to start"; }
echo ""

echo "3. anet init..."
INIT=$(printf "\n" | $ANET init --hub http://127.0.0.1:9200 2>&1 || true)
echo "$INIT" | grep -Eqi "saved|configured|initialized|hub" && pass "anet init --hub" || { echo "$INIT"; fail "anet init failed"; }
echo ""

echo "4. anet register..."
REGISTER=$($ANET register --username testuser --password pass123456 2>&1 || true)
echo "$REGISTER" | grep -Eqi "registered|created|success|already exists" && pass "anet register" || { echo "$REGISTER"; fail "anet register failed"; }
echo ""

echo "5. anet login..."
LOGIN=$($ANET login --username testuser --password pass123456 2>&1 || true)
echo "$LOGIN" | grep -Eqi "logged in|login successful|token|network" && pass "anet login" || { echo "$LOGIN"; fail "anet login failed"; }
echo ""

echo "6. anet create..."
# 🔴 原来是 --runtime http-api。产品已经不支持它，报错原文：
#   [anet] Refusing to create node: unsupported runtime "http-api"; expected one of:
#   claude-agent-sdk, claude-code-cli, codex-sdk, codex-app-server,
#   grok-build-acp, grok-build-cli, opencode-cli
# 不是回归 —— 产品加了运行时白名单、套件写在它之前（同 #1106 那两条的形状）。
# 换成受支持且 create 阶段不需要外部二进制的 claude-agent-sdk（实测 rc=0）。
# 注意别把它改成「随便什么都算过」：产品对未知 runtime 是硬拒的，
# 所以这条断言仍然会在白名单再次变动时变红，这正是我们要的。
CREATE=$($ANET create test-bot --runtime claude-agent-sdk 2>&1 || true)
echo "$CREATE" | grep -Eqi "created|config.json|test-bot" && pass "anet node create test-bot --runtime claude-agent-sdk" || { echo "$CREATE"; fail "anet node create failed"; }
echo ""

echo "7. anet network ls..."
NETS=$($ANET network ls 2>&1 || true)
echo "$NETS" | grep -Eqi "default|network|owner|member" && pass "anet network ls" || { echo "$NETS"; fail "anet network ls failed"; }
echo ""

echo "8. anet doctor..."
DOCTOR=$($ANET doctor 2>&1 || true)
echo "$DOCTOR" | grep -Eqi "server|health|ok|license|auth" && pass "anet doctor" || { echo "$DOCTOR"; fail "anet doctor failed"; }
echo ""

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1
