#!/usr/bin/env bash
# qa-cli-02-network-create — CLI 视角的 network 创建 + 列表 + 信息流
# 用户故事（getting-started.md 第二步）：
#   anet login → anet network create <name> → anet network ls 能看到
#
# 测的是 CLI binary 这一层 — 输出格式 + 本地 config 落地 + REST 调用。
# REST 本身已被 qa-hub-05 覆盖，这条专测 CLI 包装层。
set -euo pipefail
# 绑了还要看得见（#1092）：报告里没有这一行，就没法把这次运行钉到某个提交上。
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"
NET_NAME="qa-cli02-net"

cleanup() {
  for p in "${HUB_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
  pkill -KILL -f 'commhub-server' 2>/dev/null || true
}
trap cleanup EXIT

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub"
safe_rm_rf "$HOME/.anet" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$HUB_BASE/health" >/dev/null

echo "[1] anet login (non-interactive, --username/--password, retry against bootstrap race)"
# admin bootstrap can lag /health 200 by 1-3s — same race R6/R8 saw on REST
# login. Retry CLI login up to ~10s.
LOGIN_OUT=""
for i in {1..20}; do
  LOGIN_OUT=$(anet login --hub "$HUB_BASE" --username admin --password "$ADMIN_PW" 2>&1 || true)
  echo "$LOGIN_OUT" | grep -qE "Logged in as admin" && break
  sleep 0.5
done
echo "$LOGIN_OUT" | head -3 | sed 's/^/  /'
echo "$LOGIN_OUT" | grep -qE "Logged in as admin" \
  || { echo "FAIL: anet login did not confirm after retry. Output:"; echo "$LOGIN_OUT"; echo "--- hub.log tail ---"; tail -30 /tmp/hub.log; exit 1; }

echo "[2] config file written"
CFG="$HOME/.anet/config.json"
[[ -f "$CFG" ]] || { echo "FAIL: config not at $CFG"; ls -la "$HOME/.anet/" || true; exit 1; }
HUB_IN_CFG=$(jq -r '.hub // empty' "$CFG")
TOK_IN_CFG=$(jq -r '.token // empty' "$CFG")
[[ "$HUB_IN_CFG" == "$HUB_BASE" ]] || { echo "FAIL: hub in config '$HUB_IN_CFG' != '$HUB_BASE'"; exit 1; }
[[ "$TOK_IN_CFG" == utok_* ]] || { echo "FAIL: token not utok_ in config: $TOK_IN_CFG"; exit 1; }
echo "  ✓ config hub + utok_ persisted"

echo "[3] anet network create — CLI output contract"
CREATE_OUT=$(anet network create "$NET_NAME" 2>&1)
echo "$CREATE_OUT" | sed 's/^/  /'
# Pin the exact message shape:  '[anet] Network "<name>" created (<id>)'
echo "$CREATE_OUT" | grep -qE "^\[anet\] Network \"$NET_NAME\" created \(net_[a-f0-9]+\)\$" \
  || { echo "FAIL: create output shape mismatch"; exit 1; }
NET_ID=$(echo "$CREATE_OUT" | sed -n "s/.*created (\(net_[a-f0-9]*\)).*/\1/p")
[[ -n "$NET_ID" ]] || { echo "FAIL: could not extract network_id"; exit 1; }

echo "[4] REST confirms — network landed in /api/networks via utok auth"
NETS=$(curl -fsS "$HUB_BASE/api/networks" -H "Authorization: Bearer $TOK_IN_CFG")
echo "$NETS" | jq -e --arg n "$NET_NAME" \
  '.networks[] | select(.network_name == $n)' >/dev/null \
  || { echo "FAIL: network not visible via REST"; echo "$NETS"; exit 1; }

echo "[5] anet network ls — CLI lists it"
LS_OUT=$(anet network ls 2>&1)
echo "$LS_OUT" | head -10 | sed 's/^/  /'
echo "$LS_OUT" | grep -q "$NET_NAME" \
  || { echo "FAIL: anet network ls missing '$NET_NAME'"; echo "$LS_OUT"; exit 1; }

echo "[6] anet network create — duplicate name rejection (CLI)"
DUP_OUT=$(anet network create "$NET_NAME" 2>&1 || true)
echo "$DUP_OUT" | sed 's/^/  /'
echo "$DUP_OUT" | grep -qiE "(already|name|taken|duplicate|exists)" \
  || { echo "FAIL: duplicate not rejected on CLI; output: $DUP_OUT"; exit 1; }

echo "[7] anet whoami — using persisted utok"
WHOAMI=$(anet whoami 2>&1)
echo "$WHOAMI" | grep -qiE "admin" \
  || { echo "FAIL: anet whoami did not name admin: $WHOAMI"; exit 1; }

echo "PASS qa-cli-02 network-create (login → config persist → create → ls → dup-reject → whoami)"
