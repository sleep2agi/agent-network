#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-published.sh"
mkdir -p "$HOME" /tmp/work
cd /tmp/work

# Every failure path keeps its logs (CI copies $ARTIFACT_DIR out of the container). Before
# 2026-10-05 nothing was written there, so a red here showed no output and no artifact at all.
ARTIFACT_DIR=${ARTIFACT_DIR:-/tmp/art}
mkdir -p "$ARTIFACT_DIR"
save_logs() { cp -f /tmp/npm-install.log /tmp/hub.log /tmp/dashboard.log /tmp/reset-user.log "$ARTIFACT_DIR/" 2>/dev/null || true; }
trap save_logs EXIT

echo "[0] install selftest: the just-published window (local fake registry)"
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/selftest.sh"

# @preview is a MOVING tag that release.yml publishes into. Right after a publish the tag can
# point at a version whose tarball is not servable yet; a bare `npm install -g …@preview` then
# 404s (npm does not retry 404) — that was both 2026-10-05 reds. Resolve, wait, install exact.
echo "[0] install @sleep2agi/agent-network@preview"
install_published @sleep2agi/agent-network preview /tmp/npm-install.log
anet -v

ADMIN_PW="StrongPassw0rd"
NEW_ADMIN_PW="BetterPassw0rd"

echo "[1] fresh hub bootstrap without COMMHUB_AUTH_TOKEN"
safe_rm_rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port 9200 --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS http://127.0.0.1:9200/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:9200/health >/dev/null
for i in {1..30}; do test -f "$HOME/.anet/server/admin-utok.json" && break; sleep 1; done
test -f "$HOME/.anet/server/admin-utok.json"
test "$(stat -c %a "$HOME/.anet/server/admin-utok.json")" = "600"
bun -e 'const f=process.env.HOME+"/.anet/server/admin-utok.json"; const c=await Bun.file(f).json(); if(!String(c.token||"").startsWith("utok_")) process.exit(1); console.log("admin-utok ok")'

echo "[2] password change rotates current token and revokes other utok"
T1=$(curl -fsS -X POST http://127.0.0.1:9200/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" | bun -e 'const x=await new Response(Bun.stdin.stream()).json(); process.stdout.write(x.token)')
T2=$(curl -fsS -X POST http://127.0.0.1:9200/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" | bun -e 'const x=await new Response(Bun.stdin.stream()).json(); process.stdout.write(x.token)')
NEW_T=$(curl -fsS -X POST http://127.0.0.1:9200/api/auth/password -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"old_password\":\"$ADMIN_PW\",\"new_password\":\"$NEW_ADMIN_PW\"}" | bun -e 'const x=await new Response(Bun.stdin.stream()).json(); if(!x.ok||!x.token) { console.error(JSON.stringify(x)); process.exit(1); } process.stdout.write(x.token)')
curl -fsS http://127.0.0.1:9200/api/auth/me -H "Authorization: Bearer $NEW_T" >/dev/null
if curl -fsS http://127.0.0.1:9200/api/auth/me -H "Authorization: Bearer $T2" >/dev/null 2>&1; then
  echo "old second token still valid"
  exit 1
fi

echo "[3] weak passwords rejected"
curl -sS -X POST http://127.0.0.1:9200/api/auth/register -H 'Content-Type: application/json' -d '{"username":"weak1","password":"password"}' | grep -q '"ok":false'
curl -sS -X POST http://127.0.0.1:9200/api/auth/register -H 'Content-Type: application/json' -d '{"username":"weak2","password":"123456"}' | grep -q '"ok":false'

echo "[4] admin reset-user revokes target utok and writes audit"
curl -fsS -X POST http://127.0.0.1:9200/api/auth/register -H 'Content-Type: application/json' -d '{"username":"bob","password":"BobPassw0rd"}' >/tmp/bob-register.json
BOB_T=$(curl -fsS -X POST http://127.0.0.1:9200/api/auth/login -H 'Content-Type: application/json' -d '{"username":"bob","password":"BobPassw0rd"}' | bun -e 'const x=await new Response(Bun.stdin.stream()).json(); process.stdout.write(x.token)')
anet hub admin reset-user --username bob >/tmp/reset-user.log
grep -q "new password:" /tmp/reset-user.log
if curl -fsS http://127.0.0.1:9200/api/auth/me -H "Authorization: Bearer $BOB_T" >/dev/null 2>&1; then
  echo "bob old token still valid"
  exit 1
fi
bun -e 'import { Database } from "bun:sqlite"; const db=new Database(process.env.HOME+"/.commhub/commhub.db"); const r=db.query("SELECT 1 FROM audit_log WHERE action = ?1").get("password_reset_by_admin"); if(!r) process.exit(1); console.log("audit ok")'

echo "[5] dashboard package starts with cookie-forwarding build"
timeout 25 anet hub dashboard >/tmp/dashboard.log 2>&1 || true
grep -q "Dashboard auth token loaded from admin-utok.json" /tmp/dashboard.log

kill "$HUB_PID" >/dev/null 2>&1 || true
echo "PASS test30 v0.8 auth deprecation"
