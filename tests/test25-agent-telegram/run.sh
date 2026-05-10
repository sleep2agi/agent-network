#!/bin/bash

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
BASE="http://127.0.0.1:9200"
WORKDIR="/tmp/test25"
HOME_DIR="${WORKDIR}/home"
NODE_LOG="${WORKDIR}/agent-node.log"
MOCK_LOG="${WORKDIR}/mock-telegram.log"
REAL_HOME="$(node -p "require('os').homedir()")"
NODE_BASE="/app/.anet/nodes/tg-bot"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

json_get() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)" 2>/dev/null
}

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "${WORKDIR}" "${HOME_DIR}"
export HOME="${HOME_DIR}"

echo "127.0.0.1 api.telegram.org file.telegram.org" >> /etc/hosts

cat > "${WORKDIR}/mock_telegram.py" <<'PY'
import json
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def _send(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path.endswith("/getUpdates"):
            self._send({"ok": True, "result": []})
            return
        if self.path.startswith("/file/"):
            self.send_response(404)
            self.end_headers()
            return
        self._send({"ok": True, "result": []})

    def do_POST(self):
        if self.path.endswith("/getMe"):
            self._send({"ok": True, "result": {"id": 42, "username": "fakebot", "first_name": "Fake Bot"}})
            return
        if self.path.endswith("/setMessageReaction"):
            self._send({"ok": True, "result": True})
            return
        if self.path.endswith("/sendMessage"):
            self._send({"ok": True, "result": {"message_id": 501}})
            return
        self._send({"ok": True, "result": True})

httpd = HTTPServer(("0.0.0.0", 443), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tmp/test25/mock.crt", "/tmp/test25/mock.key")
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
httpd.serve_forever()
PY

echo ""
echo "========================================="
echo "  agent-node + Telegram Config Test"
echo "========================================="
echo ""

echo "1. Start server..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${WORKDIR}/server.log" 2>&1 &
sleep 3
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server failed"
echo ""

echo "2. Register user + create ntok_..."
REG=$(curl -s -X POST "${BASE}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"tguser","password":"pass123456","email":"tg@example.com"}')
UTOK=$(echo "$REG" | json_get "data.get('token','')")
NET_ID=$(echo "$REG" | json_get "data.get('network_id','')")
echo "$REG" | grep -q '"ok":true' && [ -n "$UTOK" ] && [ -n "$NET_ID" ] && pass "user registered" || { echo "$REG"; fail "register failed"; }
NODE_TOKEN=$(curl -s -X POST "${BASE}/api/auth/node-token" \
  -H "Authorization: Bearer ${UTOK}" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"tg-bot\"}")
NTOK=$(echo "$NODE_TOKEN" | json_get "data.get('token','')")
echo "$NTOK" | grep -q '^ntok_' && pass "ntok created" || { echo "$NODE_TOKEN"; fail "ntok failed"; }
mkdir -p "${HOME}/.anet" "${REAL_HOME}/.anet"
cat > "${HOME}/.anet/config.json" <<EOF
{
  "hub": "${BASE}",
  "token": "${UTOK}",
  "user": { "username": "tguser" },
  "network_id": "${NET_ID}",
  "network_name": "default"
}
EOF
cp "${HOME}/.anet/config.json" "${REAL_HOME}/.anet/config.json"
echo ""

echo "3. Create node with source anet CLI..."
cd /app
bun agent-network/bin/cli.ts create tg-bot --runtime http-api >"${WORKDIR}/create.log" 2>&1
grep -q 'Created node "tg-bot"' "${WORKDIR}/create.log" && pass "anet node create tg-bot succeeded" || { cat "${WORKDIR}/create.log"; fail "anet node create failed"; }
echo ""

echo "4. Add telegram channel with source anet CLI..."
bun agent-network/bin/cli.ts channel add telegram tg-bot --bot-token fake-token-123 --allow 999 >"${WORKDIR}/channel.log" 2>&1
grep -q 'telegram channel added' "${WORKDIR}/channel.log" && pass "anet channel add telegram succeeded" || { cat "${WORKDIR}/channel.log"; fail "channel add failed"; }
echo ""

TG_DIR="${NODE_BASE}/channels/telegram"
CFG="${NODE_BASE}/config.json"

echo "5. Verify .env exists + mode 600..."
[ -f "${TG_DIR}/.env" ] && pass ".env exists" || fail ".env missing"
MODE=$(stat -c "%a" "${TG_DIR}/.env" 2>/dev/null || true)
[ "${MODE}" = "600" ] && pass ".env mode is 600" || fail ".env mode is ${MODE:-missing}"
echo ""

echo "6. Verify access.json whitelist..."
python3 - <<PY
import json
doc = json.load(open("${TG_DIR}/access.json", "r", encoding="utf-8"))
ok = doc.get("allowFrom") == ["999"]
print("PASS" if ok else "FAIL")
PY
if [ "$(python3 - <<PY
import json
doc = json.load(open("${TG_DIR}/access.json", "r", encoding="utf-8"))
print("PASS" if doc.get("allowFrom") == ["999"] else "FAIL")
PY
)" = "PASS" ]; then
  pass "access.json contains allowlist"
else
  fail "access.json allowlist incorrect"
fi
echo ""

echo "7. Verify config.json channels contains telegram..."
python3 - <<PY
import json
doc = json.load(open("${CFG}", "r", encoding="utf-8"))
print("PASS" if "telegram" in doc.get("channels", []) else "FAIL")
PY
if [ "$(python3 - <<PY
import json
doc = json.load(open("${CFG}", "r", encoding="utf-8"))
print("PASS" if "telegram" in doc.get("channels", []) else "FAIL")
PY
)" = "PASS" ]; then
  pass "config.json channels includes telegram"
else
  fail "config.json missing telegram channel"
fi

# overwrite with the explicit ntok_ created in step 2, to make startup deterministic
python3 - <<PY
import json
path = "${CFG}"
doc = json.load(open(path, "r", encoding="utf-8"))
doc["token"] = "${NTOK}"
doc["network_id"] = "${NET_ID}"
open(path, "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
PY
echo ""

echo "8. Start source agent-node and verify Telegram logs..."
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "${WORKDIR}/mock.key" \
  -out "${WORKDIR}/mock.crt" \
  -days 1 \
  -subj "/CN=api.telegram.org" \
  -addext "subjectAltName=DNS:api.telegram.org,DNS:file.telegram.org" >/dev/null 2>&1
python3 "${WORKDIR}/mock_telegram.py" >"${MOCK_LOG}" 2>&1 &
sleep 1
NODE_TLS_REJECT_UNAUTHORIZED=0 timeout 10 bun agent-node/src/cli.ts --config "${CFG}" --alias tg-bot >"${NODE_LOG}" 2>&1 &
sleep 5
grep -q "Telegram bot: @fakebot" "${NODE_LOG}" && grep -q "Telegram polling" "${NODE_LOG}" && pass "agent-node startup log shows telegram" || { cat "${NODE_LOG}"; fail "telegram startup log missing"; }
echo ""

echo "9. Verify /api/status shows tg-bot online + channels info..."
STATUS=$(curl -s -H "Authorization: Bearer ${UTOK}" "${BASE}/api/status?network_id=${NET_ID}")
STATUS_STATE=$(echo "$STATUS" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
s = next((x for x in doc.get("sessions", []) if x.get("alias") == "tg-bot"), None)
if not s:
    print("missing")
else:
    channels = str(s.get("channels", ""))
    ok = s.get("status") == "idle" and "telegram" in channels
    print("ok" if ok else "{}|{}".format(s.get("status", "?"), channels))
')
[ "$STATUS_STATE" = "ok" ] && pass "status shows tg-bot online with telegram channel" || { echo "$STATUS"; fail "status missing online/channel info (${STATUS_STATE})"; }
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[ "${FAIL}" -eq 0 ]
