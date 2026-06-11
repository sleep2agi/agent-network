#!/usr/bin/env bash
set -euo pipefail

PORT=19319
BASE="http://127.0.0.1:$PORT"
DB="/tmp/commhub-login-guard.db"
LOG="/tmp/commhub-login-guard.log"
rm -f "$DB" "$LOG"

cleanup() {
  set +e
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

post_login() {
  local ip="$1" username="$2" password="$3" out="$4"
  curl -sS -o "$out" -D "$out.headers" -w '%{http_code}' \
    -X POST "$BASE/api/auth/login" \
    -H "X-Forwarded-For: $ip" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$password\"}"
}

echo "[0] start local hub with short test lock window"
(
  cd /app/server
  PORT="$PORT" HOST=127.0.0.1 COMMHUB_DB="$DB" \
  COMMHUB_LOGIN_LOCK_BASE_MS=1200 COMMHUB_LOGIN_LOCK_MAX_MS=1200 \
  bun run src/index.ts
) >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$BASE/health" >/dev/null

echo "[1] register user"
curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"guarduser","password":"StrongPassw0rd"}' >/tmp/register.json
BOOT_TOKEN=$(jq -r '.token' /tmp/register.json)
[[ "$BOOT_TOKEN" == utok_* ]] || { echo "FAIL: register token"; cat /tmp/register.json; exit 1; }

echo "[2] IP login rate limit: 10/min allowed, 11th returns 429 + Retry-After (XFF last-hop keyed)"
for i in $(seq 1 10); do
  code=$(post_login "198.51.100.$i, 203.0.113.10" "guarduser" "StrongPassw0rd" "/tmp/ip-$i.json")
  [[ "$code" == "200" ]] || { echo "FAIL: login attempt $i expected 200 got $code"; cat "/tmp/ip-$i.json"; exit 1; }
done
code=$(post_login "198.51.100.99, 203.0.113.10" "guarduser" "StrongPassw0rd" /tmp/ip-11.json)
[[ "$code" == "429" ]] || { echo "FAIL: 11th login expected 429 got $code"; cat /tmp/ip-11.json; exit 1; }
jq -e '.ok == false and .error == "rate_limited" and (.retry_after_ms > 0)' /tmp/ip-11.json >/dev/null
grep -qi '^Retry-After:' /tmp/ip-11.json.headers || { echo "FAIL: missing Retry-After header"; cat /tmp/ip-11.json.headers; exit 1; }

echo "[3] token-auth endpoint is unaffected by login rate limit"
status_code=$(curl -sS -o /tmp/status.json -w '%{http_code}' "$BASE/api/status" \
  -H "Authorization: Bearer $BOOT_TOKEN" \
  -H "X-Forwarded-For: 198.51.100.10")
[[ "$status_code" == "200" ]] || { echo "FAIL: /api/status expected 200 got $status_code"; cat /tmp/status.json; exit 1; }

echo "[4] username failure lock: 5 wrong passwords, then correct password is still 429"
for i in $(seq 1 5); do
  code=$(post_login "198.51.100.20" "guarduser" "wrong-$i" "/tmp/fail-$i.json")
  [[ "$code" == "401" ]] || { echo "FAIL: wrong password $i expected 401 got $code"; cat "/tmp/fail-$i.json"; exit 1; }
done
code=$(post_login "198.51.100.20" "guarduser" "StrongPassw0rd" /tmp/locked.json)
[[ "$code" == "429" ]] || { echo "FAIL: locked correct login expected 429 got $code"; cat /tmp/locked.json; exit 1; }
jq -e '.ok == false and .error == "login_locked" and (.retry_after_ms > 0)' /tmp/locked.json >/dev/null
grep -qi '^Retry-After:' /tmp/locked.json.headers || { echo "FAIL: missing lock Retry-After header"; cat /tmp/locked.json.headers; exit 1; }
grep -q 'login locked for username=guarduser' "$LOG" || { echo "FAIL: server log missing lock event"; tail -120 "$LOG"; exit 1; }

echo "[5] after lock expires, correct password succeeds and clears failures"
sleep 1.5
code=$(post_login "198.51.100.20" "guarduser" "StrongPassw0rd" /tmp/recovered.json)
[[ "$code" == "200" ]] || { echo "FAIL: recovered login expected 200 got $code"; cat /tmp/recovered.json; tail -120 "$LOG"; exit 1; }
jq -e '.ok == true and (.token | startswith("utok_"))' /tmp/recovered.json >/dev/null

echo "PASS qa-hub-19 login guard"
