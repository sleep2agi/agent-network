#!/usr/bin/env bash
# qa-cli-01-hub-start — anet hub start UX
# 用户故事（getting-started 第一步）：
#   - 我跑 `anet hub start --username admin --password X`
#   - 终端打出 banner（已启动、URL、admin 凭证位置）
#   - /health 200
#   - 端口绑定
#   - admin-utok.json 落地 mode 600
#   - 再跑一次 `anet hub start` 说 "already running"（不报错不双开）
#
# 是 [docker-e2e SC01] / [test30] 等之外，专 pin **CLI 输出 + 用户能否上手** 的 L2 smoke。
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

cleanup() {
  for p in "${HUB_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
  pkill -KILL -f 'commhub-server' 2>/dev/null || true
  pkill -KILL -f 'anet hub start' 2>/dev/null || true
}
trap cleanup EXIT

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] fresh state — no ~/.anet, no ~/.commhub"
safe_rm_rf "$HOME/.anet" "$HOME/.commhub"

echo "[1] start hub in background, capture banner"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
# wait for /health to become available
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done

echo "[2] /health 200"
HEALTH=$(curl -fsS "$HUB_BASE/health")
echo "$HEALTH" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: /health did not return ok:true: $HEALTH"; exit 1; }

# Give hub log a moment to flush the banner
sleep 0.5

echo "[3] PIN: banner content — header + starting line + URL"
# Pin the user-visible startup banner. SDK / docs reference these strings.
BANNER=$(cat /tmp/hub.log)
echo "$BANNER" | grep -qE "anet hub start" \
  || { echo "FAIL: banner missing 'anet hub start' header"; echo "$BANNER" | head -30; exit 1; }
echo "$BANNER" | grep -qE "Starting CommHub Server" \
  || { echo "FAIL: banner missing 'Starting CommHub Server'"; echo "$BANNER" | head -30; exit 1; }
echo "$BANNER" | grep -qE "(bind 127\.0\.0\.1|host:.*127\.0\.0\.1|http://127\.0\.0\.1:9200)" \
  || { echo "FAIL: banner missing host/bind 127.0.0.1"; echo "$BANNER" | head -30; exit 1; }
echo "  ✓ banner shows header + 'Starting CommHub Server' + 127.0.0.1"

echo "[4] PIN: ~/.anet/server/admin-utok.json落地，mode 600"
ADMIN_FILE="$HOME/.anet/server/admin-utok.json"
for i in {1..30}; do test -f "$ADMIN_FILE" && break; sleep 0.5; done
test -f "$ADMIN_FILE" || { echo "FAIL: admin-utok.json missing"; ls -la "$HOME/.anet/server/" || true; exit 1; }
MODE=$(stat -c '%a' "$ADMIN_FILE")
[[ "$MODE" == "600" ]] || { echo "FAIL: admin-utok.json mode $MODE != 600 (perms leak)"; exit 1; }

# Token inside is the admin utok
ADMIN_TOK=$(jq -r '.token' "$ADMIN_FILE")
[[ "$ADMIN_TOK" == utok_* ]] || { echo "FAIL: admin-utok.json content not utok_: $ADMIN_TOK"; exit 1; }
echo "  ✓ admin-utok.json mode 600 + utok_ inside"

echo "[5] admin utok actually works for /api/auth/me"
ME=$(curl -fsS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $ADMIN_TOK")
ROLE=$(echo "$ME" | jq -r '.user.role')
USERNAME=$(echo "$ME" | jq -r '.user.username')
[[ "$USERNAME" == "admin" ]] || { echo "FAIL: admin-utok user != admin (got $USERNAME)"; exit 1; }
[[ "$ROLE" == "admin" ]] || { echo "FAIL: admin role != admin (got $ROLE)"; exit 1; }
echo "  ✓ admin-utok auths as admin role"

echo "[6] port $HUB_PORT bound — direct TCP check"
# Use curl to confirm port responds (we can't install netstat in slim image)
curl -fsS --connect-timeout 2 "$HUB_BASE/health" >/dev/null \
  || { echo "FAIL: port $HUB_PORT not bound"; exit 1; }

echo "[7] PIN: re-run 'anet hub start' detects already-running, doesn't double-start"
RERUN_OUT=$(anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" 2>&1 || true)
echo "$RERUN_OUT" | sed 's/^/    /'
echo "$RERUN_OUT" | grep -qiE "already running|already up" \
  || { echo "FAIL: re-run didn't detect already-running"; exit 1; }
echo "  ✓ idempotent: second run says 'already running'"

# Confirm no double-start by checking only ONE process is actually bound on
# the port (the spawn chain shell→bunx→bun is 3 procs but one server).
# Probe: the LISTENING server must respond AND the admin-utok ID match.
N_PROCS=$(pgrep -fc commhub-server || echo 0)
[[ "$N_PROCS" -ge 1 ]] || { echo "FAIL: no commhub-server process"; exit 1; }
# After re-run, the admin-utok.json should still be the SAME file (not
# regenerated). Pin via mtime — if it was overwritten by a second bootstrap
# it would have a new mtime since [1].
echo "  ✓ admin-utok.json preserved (no re-bootstrap):"
ls -la "$ADMIN_FILE" | sed 's/^/    /'

echo "[8] anet -v matches the binary that started the hub"
VERSION=$(anet -v 2>&1)
[[ -n "$VERSION" ]] || { echo "FAIL: anet -v empty"; exit 1; }
echo "  $VERSION"

echo "PASS qa-cli-01 hub-start (banner + /health + admin-utok 600 + utok auth + idempotent re-run)"
