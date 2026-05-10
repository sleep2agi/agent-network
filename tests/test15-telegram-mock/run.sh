#!/bin/bash

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
TMP="/tmp/test15"
CHANNEL_DIR="${TMP}/telegram"
NODE_DIR="${TMP}/.anet/nodes/tg-bot"
NODE_LOG="${TMP}/agent-node.log"
MOCK_LOG="${TMP}/mock-telegram.log"
MOCK_SENT="${TMP}/sent-messages.log"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "${TMP}" "${CHANNEL_DIR}" "${NODE_DIR}"

echo "127.0.0.1 api.telegram.org file.telegram.org" >> /etc/hosts

cat > "${TMP}/mock_telegram.py" <<'PY'
import json
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

STATE = {
    "updates_served": False,
    "messages": [],
    "reactions": [],
}

UPDATES = [
    {
        "update_id": 1001,
        "message": {
            "message_id": 11,
            "chat": {"id": 111},
            "from": {"id": 111, "username": "blockeduser"},
            "text": "blocked task"
        }
    },
    {
        "update_id": 1002,
        "message": {
            "message_id": 12,
            "chat": {"id": 999},
            "from": {"id": 999, "username": "alloweduser"},
            "text": "telegram task from mock"
        }
    }
]

def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

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
        parsed = urlparse(self.path)
        if parsed.path.endswith("/getUpdates"):
            if not STATE["updates_served"]:
                STATE["updates_served"] = True
                self._send({"ok": True, "result": UPDATES})
            else:
                self._send({"ok": True, "result": []})
            return
        if parsed.path.startswith("/file/"):
            self.send_response(404)
            self.end_headers()
            return
        self._send({"ok": True, "result": []})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except Exception:
            body = {}
        if parsed.path.endswith("/getMe"):
            self._send({"ok": True, "result": {"id": 42, "username": "mockbot", "first_name": "Mock Bot"}})
            return
        if parsed.path.endswith("/sendMessage"):
            STATE["messages"].append(body)
            write_json("/tmp/test15/sent-messages.log", STATE["messages"])
            self._send({"ok": True, "result": {"message_id": 501}})
            return
        if parsed.path.endswith("/setMessageReaction"):
            STATE["reactions"].append(body)
            write_json("/tmp/test15/reactions.log", STATE["reactions"])
            self._send({"ok": True, "result": True})
            return
        if parsed.path.endswith("/getFile"):
            self._send({"ok": True, "result": {"file_path": "unused"}})
            return
        self._send({"ok": True, "result": True})

httpd = HTTPServer(("0.0.0.0", 443), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tmp/test15/mock.crt", "/tmp/test15/mock.key")
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
httpd.serve_forever()
PY

echo ""
echo "========================================="
echo "  Telegram Mock Integration Test"
echo "========================================="
echo ""

echo "1. Start CommHub server..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 3
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "CommHub server started" || fail "server start failed"
echo ""

echo "2. Register user + create ntok_..."
REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"telegramuser","password":"test123456"}')
echo "$REG" | grep -q '"ok":true' && pass "user registered" || fail "user register failed"
UTOK=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
NET_ID=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('network_id',''))")
NODE_TOKEN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer ${UTOK}" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"tg-bot\"}")
NTOK=$(echo "$NODE_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
echo "$NTOK" | grep -q '^ntok_' && pass "ntok created" || { echo "$NODE_TOKEN"; fail "ntok creation failed"; }
echo ""

echo "3. Prepare Telegram mock server + channel config..."
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "${TMP}/mock.key" \
  -out "${TMP}/mock.crt" \
  -days 1 \
  -subj "/CN=api.telegram.org" \
  -addext "subjectAltName=DNS:api.telegram.org,DNS:file.telegram.org" >/dev/null 2>&1
cat > "${CHANNEL_DIR}/.env" <<EOF
TELEGRAM_BOT_TOKEN=mock-token
EOF
cat > "${CHANNEL_DIR}/access.json" <<EOF
{"allowFrom":["999"]}
EOF
pass "telegram channel files written"
python3 "${TMP}/mock_telegram.py" >"${MOCK_LOG}" 2>&1 &
sleep 1
pass "mock Telegram HTTPS server started"
echo ""

echo "4. Write agent-node config..."
cat > "${NODE_DIR}/config.json" <<EOF
{
  "alias": "tg-bot",
  "node_name": "tg-bot",
  "node_id": "n_test15tg",
  "runtime": "http-api",
  "model": "gpt-4o-mini",
  "hub": "http://127.0.0.1:9200",
  "token": "${NTOK}",
  "network_id": "${NET_ID}",
  "channels": ["telegram:${CHANNEL_DIR}"]
}
EOF
[ -f "${NODE_DIR}/config.json" ] && pass "agent-node config written" || fail "agent-node config missing"
echo ""

echo "5. Start real agent-node with Telegram channel..."
cd "${TMP}"
NODE_TLS_REJECT_UNAUTHORIZED=0 timeout 12 agent-node --config "${NODE_DIR}/config.json" >"${NODE_LOG}" 2>&1 &
AGENT_PID=$!
sleep 5
grep -q "Telegram bot: @mockbot" "${NODE_LOG}" && pass "agent-node validated Telegram bot token" || { cat "${NODE_LOG}"; fail "telegram getMe missing"; }
grep -q "Telegram polling" "${NODE_LOG}" && pass "agent-node started Telegram polling" || fail "telegram polling missing"
echo ""

echo "6. Verify allowed Telegram message processed..."
grep -q "telegram:alloweduser" "${NODE_LOG}" && pass "allowed Telegram message reached processing flow" || fail "allowed Telegram message missing"
grep -q "http-api 错误\|需要设置 ANTHROPIC_API_KEY\|OPENAI_API_KEY\|MINIMAX_CODING_API_KEY" "${NODE_LOG}" && pass "http-api path executed for Telegram task" || fail "http-api path missing"
echo ""

echo "7. Verify blocked user ignored by allowFrom..."
if grep -q "telegram:blockeduser" "${NODE_LOG}"; then
  fail "blocked Telegram user should not be processed"
else
  pass "blocked Telegram user ignored"
fi
echo ""

echo "8. Verify reply sent back through Telegram mock..."
sleep 2
python3 - <<'PY'
import json, sys
try:
    msgs = json.load(open("/tmp/test15/sent-messages.log", "r", encoding="utf-8"))
except Exception:
    print("FAIL")
    raise SystemExit(0)
ok = any(str(m.get("chat_id")) == "999" for m in msgs)
print("PASS" if ok else "FAIL")
PY
if [ "$?" = "0" ]; then :; fi
python3 - <<'PY'
import json
try:
    msgs = json.load(open("/tmp/test15/sent-messages.log", "r", encoding="utf-8"))
except Exception:
    print("FAIL")
    raise SystemExit(0)
ok = any(str(m.get("chat_id")) == "999" and "错误" in str(m.get("text", "")) for m in msgs)
print("PASS" if ok else "FAIL")
PY
if [ "$(python3 - <<'PY'
import json
try:
    msgs = json.load(open("/tmp/test15/sent-messages.log", "r", encoding="utf-8"))
except Exception:
    print("FAIL")
    raise SystemExit(0)
ok = any(str(m.get("chat_id")) == "999" and ("错误" in str(m.get("text", "")) or "API_KEY" in str(m.get("text", ""))) for m in msgs)
print("PASS" if ok else "FAIL")
PY
)" = "PASS" ]; then
  pass "Telegram mock captured reply to allowed user"
else
  [ -f "${MOCK_SENT}" ] && cat "${MOCK_SENT}"
  fail "Telegram reply not captured"
fi
echo ""

echo "9. Verify agent online/offline in CommHub..."
STATUS_ON=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "http://127.0.0.1:9200/api/status?network_id=${NET_ID}" | python3 -c "
import sys, json
doc = json.load(sys.stdin)
s = next((x for x in doc.get('sessions', []) if x.get('alias') == 'tg-bot'), None)
print(s.get('status', '') if s else '')
")
[ "$STATUS_ON" = "idle" ] && pass "tg-bot online in CommHub" || fail "tg-bot not online"
wait "${AGENT_PID}" || true
sleep 1
STATUS_OFF=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "http://127.0.0.1:9200/api/status?network_id=${NET_ID}" | python3 -c "
import sys, json
doc = json.load(sys.stdin)
s = next((x for x in doc.get('sessions', []) if x.get('alias') == 'tg-bot'), None)
print(s.get('status', '') if s else '')
")
[ "$STATUS_OFF" = "offline" ] && pass "tg-bot offline after stop" || fail "tg-bot not offline"
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[ "${FAIL}" -eq 0 ]
