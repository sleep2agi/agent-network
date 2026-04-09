#!/bin/bash
# E2E test: anet create with params (non-interactive)
set -e
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
mkdir -p .anet

echo "=== Test 1: anet create with params ==="
node /home/vansin/agent-orchestra/agent-network/dist/bin/cli.js create 测试牛 --runtime codex-sdk --model gpt-5.4
[ -f .anet/nodes/测试牛/config.json ] && echo "✅ config.json created" || echo "❌ config.json missing"
grep -q "codex-sdk" .anet/nodes/测试牛/config.json && echo "✅ runtime correct" || echo "❌ runtime wrong"
grep -q "gpt-5.4" .anet/nodes/测试牛/config.json && echo "✅ model correct" || echo "❌ model wrong"

echo ""
echo "=== Test 2: invalid node name ==="
node /home/vansin/agent-orchestra/agent-network/dist/bin/cli.js create "bad/name" --runtime codex-sdk 2>&1 | grep -q "invalid" && echo "✅ invalid name rejected" || echo "❌ should reject invalid name"

echo ""
echo "=== Test 3: duplicate create ==="
node /home/vansin/agent-orchestra/agent-network/dist/bin/cli.js create 测试牛 --runtime codex-sdk 2>&1 | grep -q "already exists" && echo "✅ duplicate rejected" || echo "❌ should reject duplicate"

echo ""
echo "=== Test 4: anet -v ==="
node /home/vansin/agent-orchestra/agent-network/dist/bin/cli.js -v 2>&1 | grep -q "anet v" && echo "✅ version output" || echo "❌ version missing"

echo ""
echo "=== Test 5: channel add ==="
node /home/vansin/agent-orchestra/agent-network/dist/bin/cli.js channel add telegram 测试牛 --bot-token test123 --allow 7612221352
[ -f .anet/nodes/测试牛/channels/telegram/.env ] && echo "✅ telegram .env created" || echo "❌ telegram .env missing"
stat -c %a .anet/nodes/测试牛/channels/telegram/.env 2>/dev/null | grep -q "600" && echo "✅ .env chmod 600" || echo "❌ .env not 600"
grep -q "telegram" .anet/nodes/测试牛/config.json && echo "✅ config updated with telegram" || echo "❌ config not updated"

echo ""
echo "=== Cleanup ==="
rm -rf "$TMPDIR"
echo "Done."
