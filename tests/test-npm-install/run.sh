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
[ "$PKG_VER" = "0.5.0-preview.28" ] && pass "commhub-server preview.28 installed" || fail "commhub-server version: ${PKG_VER:-missing}"
$ANET -v 2>&1 | grep -q "anet v" && pass "anet version available" || fail "anet version missing"
agent-node --version 2>&1 | grep -q "agent-node" && pass "agent-node version available" || fail "agent-node version missing"
echo ""

echo "2. Start server..."
bunx @sleep2agi/commhub-server > /tmp/npm-install-server.log 2>&1 &
sleep 4
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started from npm package" || fail "server failed to start"
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
CREATE=$($ANET create test-bot --runtime http-api 2>&1 || true)
echo "$CREATE" | grep -Eqi "created|config.json|test-bot" && pass "anet node create test-bot --runtime http-api" || { echo "$CREATE"; fail "anet node create failed"; }
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
