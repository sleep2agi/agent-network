#!/bin/bash
# E2E test: anet create with params (non-interactive)
set -e
TMPDIR=$(mktemp -d)

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../tests/lib/safe-rm.sh"
cd "$TMPDIR"
mkdir -p .anet

echo "=== Test 1: anet create with params ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" create 测试牛 --runtime codex-sdk --model gpt-5.4
[ -f .anet/nodes/测试牛/config.json ] && echo "✅ config.json created" || echo "❌ config.json missing"
grep -Eq '"node_id": "n_[0-9a-f]{8}"' .anet/nodes/测试牛/config.json && echo "✅ node_id created" || echo "❌ node_id missing"
grep -q '"node_name": "测试牛"' .anet/nodes/测试牛/config.json && echo "✅ node_name correct" || echo "❌ node_name wrong"
grep -q "codex-sdk" .anet/nodes/测试牛/config.json && echo "✅ runtime correct" || echo "❌ runtime wrong"
grep -q "gpt-5.4" .anet/nodes/测试牛/config.json && echo "✅ model correct" || echo "❌ model wrong"
NODE_ID=$(sed -n 's/.*"node_id": "\(n_[0-9a-f]\{8\}\)".*/\1/p' .anet/nodes/测试牛/config.json)

echo ""
echo "=== Test 2: invalid node name ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" create "bad/name" --runtime codex-sdk 2>&1 | grep -q "invalid" && echo "✅ invalid name rejected" || echo "❌ should reject invalid name"

echo ""
echo "=== Test 3: duplicate create ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" create 测试牛 --runtime codex-sdk 2>&1 | grep -q "already exists" && echo "✅ duplicate rejected" || echo "❌ should reject duplicate"

echo ""
echo "=== Test 4: anet -v ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" -v 2>&1 | grep -q "anet v" && echo "✅ version output" || echo "❌ version missing"

echo ""
echo "=== Test 5: channel add ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" channel add telegram "$NODE_ID" --bot-token test123 --allow 999999999
[ -f .anet/nodes/测试牛/channels/telegram/.env ] && echo "✅ telegram .env created" || echo "❌ telegram .env missing"
stat -c %a .anet/nodes/测试牛/channels/telegram/.env 2>/dev/null | grep -q "600" && echo "✅ .env chmod 600" || echo "❌ .env not 600"
grep -q "telegram" .anet/nodes/测试牛/config.json && echo "✅ config updated with telegram" || echo "❌ config not updated"

echo ""
echo "=== Test 6: rename ==="
node "${ANET_CLI:-../../dist/bin/cli.js}" rename "$NODE_ID" 新测试牛
[ -f .anet/nodes/新测试牛/config.json ] && echo "✅ renamed config exists" || echo "❌ renamed config missing"
grep -q '"node_name": "新测试牛"' .anet/nodes/新测试牛/config.json && echo "✅ renamed node_name saved" || echo "❌ renamed node_name missing"
grep -Eq "\"node_id\": \"$NODE_ID\"" .anet/nodes/新测试牛/config.json && echo "✅ node_id preserved" || echo "❌ node_id changed"

echo ""
echo "=== Cleanup ==="
safe_rm_rf "$TMPDIR"
echo "Done."
