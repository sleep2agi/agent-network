#!/usr/bin/env bash
# qa-dash-07-auth-boundary — 未登录访问 dashboard-facing API 必拒
# 用户故事：dashboard 前端把 /api/* 当 protected。
#   - 没 token / 无效 token → 401（永不泄漏数据）
#   - 有效 utok → 200（正常访问）
#   - admin-only 端点对 non-admin → 403
#   - 公共端点（/health / 注册 / 登录）→ 200，无需 auth
#
# 直接 curl hub REST，不起 dashboard 前端。dashboard 视觉 + 路由
# 由 dashboard repo Playwright 在 docker-e2e 里覆盖（保护资产）。
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
USER_PW="UserPassw0rd1"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() {
  for p in "${HUB_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
  pkill -KILL -f 'commhub-server' 2>/dev/null || true
}
trap cleanup EXIT

# Probe HTTP status code without body.
status() {
  local url="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' "$url" "$@"
}

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub"
safe_rm_rf "$HOME/.anet" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done

# Wait for admin user to be ready
UTOK_ADMIN=""
for i in {1..20}; do
  R=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK_ADMIN=$(echo "$R" | jq -r '.token // empty')
  [[ "$UTOK_ADMIN" == utok_* ]] && break
  sleep 0.5
done
[[ "$UTOK_ADMIN" == utok_* ]] || { echo "FAIL: admin login"; exit 1; }

echo "[1] register a non-admin user 'bob' → UTOK_BOB"
curl -fsS -X POST "$HUB_BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"$USER_PW\"}" >/dev/null
UTOK_BOB=$(curl -fsS -X POST "$HUB_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"$USER_PW\"}" | jq -r '.token')
[[ "$UTOK_BOB" == utok_* ]] || { echo "FAIL: bob login"; exit 1; }

# ─────────────── Group A: public endpoints (no auth required) ───────────────
echo "[2] public endpoints — 200 without any auth"
for ep in "/health" "/api/auth/register" "/api/auth/login"; do
  if [[ "$ep" == "/health" ]]; then
    code=$(status "$HUB_BASE$ep")
  else
    # POST endpoints — expect 400/401 *only* for missing body, NOT 401 auth.
    # Use empty body; bad-request is fine, just not 'unauthorized'.
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB_BASE$ep" -H 'Content-Type: application/json' -d '{}')
  fi
  # Public endpoints must not require auth → not 401 with reason "unauthorized" / "auth required"
  if [[ "$code" == "401" ]]; then
    BODY=$(curl -s "$HUB_BASE$ep" -X POST -H 'Content-Type: application/json' -d '{}')
    case "$BODY" in
      *"auth required"*|*"unauthorized"*|*"invalid token"*)
        echo "FAIL: public endpoint $ep returned auth-style 401: $BODY"; exit 1 ;;
    esac
  fi
  echo "  public $ep → HTTP $code (ok, not auth-rejected)"
done

# ─────────────── Group B: protected endpoints reject NO token ───────────────
echo "[3] protected endpoints — 401 WITHOUT Authorization header"
PROTECTED_GETS=(
  "/api/auth/me"
  "/api/networks"
  "/api/auth/tokens"
  "/api/status"
  "/api/tasks"
  "/api/messages"
  "/api/stats"
  "/api/task_events"
  "/api/completions"
  "/api/nodes"
)
FAIL=0
for ep in "${PROTECTED_GETS[@]}"; do
  code=$(status "$HUB_BASE$ep")
  if [[ "$code" != "401" ]]; then
    echo "  ✗ $ep → HTTP $code (expected 401)"
    FAIL=$((FAIL+1))
  else
    echo "  ✓ $ep → 401 (no-auth correctly rejected)"
  fi
done
[[ $FAIL -eq 0 ]] || { echo "FAIL: $FAIL protected GET endpoints leaked w/o auth"; exit 1; }

echo "[4] protected POST/PUT endpoints — 401 WITHOUT Authorization header"
# Use empty JSON body; we only care about the auth verdict, not validation.
for spec in "POST:/api/networks" "POST:/api/task" "POST:/api/broadcast" "PUT:/api/auth/me"; do
  method="${spec%%:*}"; ep="${spec##*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$HUB_BASE$ep" \
    -H 'Content-Type: application/json' -d '{}')
  if [[ "$code" != "401" ]]; then
    echo "FAIL: $method $ep → HTTP $code (expected 401)"; exit 1
  fi
  echo "  ✓ $method $ep → 401"
done

# ─────────────── Group C: invalid token → 401 ───────────────
echo "[5] protected endpoints — 401 with INVALID token (utok_garbage…)"
for ep in "${PROTECTED_GETS[@]}"; do
  code=$(status "$HUB_BASE$ep" -H "Authorization: Bearer utok_garbage_does_not_exist_xxxxxxxx")
  if [[ "$code" != "401" ]]; then
    echo "FAIL: $ep accepted bogus utok (HTTP $code)"; exit 1
  fi
done
echo "  ✓ all ${#PROTECTED_GETS[@]} endpoints reject bogus token"

# ─────────────── Group D: sanity — valid utok → 200 ───────────────
echo "[6] sanity — admin utok → 200 on protected endpoints"
for ep in "/api/auth/me" "/api/networks" "/api/status" "/api/tasks" "/api/messages" "/api/stats"; do
  code=$(status "$HUB_BASE$ep" -H "Authorization: Bearer $UTOK_ADMIN")
  if [[ "$code" != "200" ]]; then
    echo "FAIL: admin utok rejected on $ep (HTTP $code)"; exit 1
  fi
done
echo "  ✓ all 6 endpoints accept valid admin utok"

# ─────────────── Group E: admin-only endpoints reject non-admin utok ───────────────
echo "[7] admin-only — 403 with non-admin utok (bob)"
# /api/server-logs is admin-only (server/src/index.ts requireAdminAuth + role check)
code=$(status "$HUB_BASE/api/server-logs" -H "Authorization: Bearer $UTOK_BOB")
[[ "$code" == "403" ]] || { echo "FAIL: /api/server-logs accepted non-admin utok (HTTP $code)"; exit 1; }
echo "  ✓ /api/server-logs → 403 for non-admin"

# ─────────────── Group F: SSE endpoint requires auth ───────────────
echo "[8] SSE /events/<alias> — 401 without auth"
code=$(status "$HUB_BASE/events/anybody?network_id=anything")
[[ "$code" == "401" ]] || { echo "FAIL: SSE leaked without auth (HTTP $code)"; exit 1; }
echo "  ✓ SSE → 401 without auth"

# ─────────────── Group G: MCP endpoint requires auth ───────────────
echo "[9] MCP /mcp — 401 without auth"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB_BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[[ "$code" == "401" ]] || { echo "FAIL: /mcp leaked without auth (HTTP $code)"; exit 1; }
echo "  ✓ /mcp → 401 without auth"

echo "PASS qa-dash-07 auth-boundary (10 GETs + 4 POST/PUT + invalid-token + admin-only + SSE + MCP)"
