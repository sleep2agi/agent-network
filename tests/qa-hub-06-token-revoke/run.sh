#!/usr/bin/env bash
# qa-hub-06-token-revoke — utok/ntok 撤销契约
# 用户故事：管理员撤销用户后，用户的 utok 立即失效；
# 用户也可以单独撤销自己的 ntok。
# L1 contract test，纯黑盒。
set -euo pipefail

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
BOB_PW="BobPassw0rd1"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() { kill "${HUB_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub"
safe_rm_rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$HUB_BASE/health" >/dev/null

echo "[1] register bob + login → UTOK_BOB"
curl -fsS -X POST "$HUB_BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"$BOB_PW\"}" >/dev/null
UTOK_BOB=$(curl -fsS -X POST "$HUB_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"$BOB_PW\"}" | jq -r '.token')
[[ "$UTOK_BOB" == utok_* ]] || { echo "FAIL: bob utok shape"; exit 1; }

echo "[2] bob creates network → NET_ID"
NET_RESP=$(curl -sS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK_BOB" -H 'Content-Type: application/json' \
  -d '{"name":"bob-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
if [[ -z "$NET_ID" ]]; then
  echo "FAIL: no net id. raw response:"; echo "$NET_RESP"; exit 1
fi

echo "[3] bob mints NTOK_BOB"
NTOK_RESP=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK_BOB" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"bob-node\"}")
NTOK_BOB=$(echo "$NTOK_RESP" | jq -r '.token')
NTOK_BOB_ID=$(echo "$NTOK_RESP" | jq -r '.token_id // .id // empty')
[[ "$NTOK_BOB" == ntok_* ]] || { echo "FAIL: bob ntok shape"; exit 1; }

# node-token endpoint doesn't return token_id, find it via /api/auth/tokens.
# Note: register() auto-creates a default network + default-network ntok for
# new users, so bob actually has 2 ntoks. Filter by name "node:bob-node" (the
# stable name we passed at mint) to disambiguate.
if [[ -z "$NTOK_BOB_ID" ]]; then
  NTOK_BOB_ID=$(curl -fsS "$HUB_BASE/api/auth/tokens" \
    -H "Authorization: Bearer $UTOK_BOB" \
    | jq -r '.tokens[] | select(.name=="node:bob-node") | .token_id' | head -1)
fi
[[ -n "$NTOK_BOB_ID" && "$NTOK_BOB_ID" != "null" ]] || { echo "FAIL: cannot find NTOK_BOB token_id"; exit 1; }
echo "  NTOK_BOB token_id=$NTOK_BOB_ID (name=node:bob-node)"

echo "[4] sanity: both tokens currently work"
curl -fsS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK_BOB" >/dev/null \
  || { echo "FAIL: utok pre-revoke not working"; exit 1; }
curl -fsS "$HUB_BASE/api/networks" -H "Authorization: Bearer $NTOK_BOB" >/dev/null \
  || { echo "FAIL: ntok pre-revoke not working"; exit 1; }

echo "[5] admin reset-user bob (revokes bob's utok via CLI)"
anet hub admin reset-user --username bob >/tmp/reset.log
grep -q "new password:" /tmp/reset.log || { echo "FAIL: reset-user did not run"; cat /tmp/reset.log; exit 1; }
BOB_NEW_UTOK=$(grep "new token:" /tmp/reset.log | awk '{print $NF}')
[[ "$BOB_NEW_UTOK" == utok_* ]] || { echo "FAIL: new utok shape"; exit 1; }

echo "[6] assert OLD UTOK_BOB now 401"
CODE=$(curl -s -o /tmp/me.json -w '%{http_code}' "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK_BOB")
if [[ "$CODE" != "401" ]]; then
  echo "FAIL: old utok should be 401 after reset-user, got $CODE"; cat /tmp/me.json; exit 1
fi

echo "[7] CONTRACT PIN: NTOK_BOB survives reset-user (current behavior)"
# This pins the current implementation: revokeOtherUserTokens() in
# server/src/auth.ts deletes only api_tokens rows where network_id IS NULL.
# ntok rows have network_id set → they survive. If the security model
# requires cascade, change auth.ts and flip this assertion.
CODE=$(curl -s -o /tmp/n1.json -w '%{http_code}' "$HUB_BASE/api/networks" -H "Authorization: Bearer $NTOK_BOB")
if [[ "$CODE" != "200" ]]; then
  echo "UNEXPECTED: NTOK_BOB returned $CODE after reset-user (was expected 200 per current code)"; cat /tmp/n1.json; exit 1
fi
echo "  → ntok still works (pinned). If undesired, file as security bug + update auth.ts."

echo "[8] bob (new utok) directly revokes the lingering ntok via DELETE /api/auth/tokens/<id>"
curl -fsS -X DELETE "$HUB_BASE/api/auth/tokens/$NTOK_BOB_ID" \
  -H "Authorization: Bearer $BOB_NEW_UTOK" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: token DELETE did not return ok"; exit 1; }

echo "[9] assert NTOK_BOB now 401"
CODE=$(curl -s -o /tmp/n2.json -w '%{http_code}' "$HUB_BASE/api/networks" -H "Authorization: Bearer $NTOK_BOB")
if [[ "$CODE" != "401" ]]; then
  echo "FAIL: ntok should be 401 after explicit DELETE, got $CODE"; cat /tmp/n2.json; exit 1
fi

echo "PASS qa-hub-06 token-revoke (utok via reset; ntok via explicit DELETE; cascade gap pinned)"
