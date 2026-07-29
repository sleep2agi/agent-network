#!/usr/bin/env bash
# #498 hard gate — verify the send_reply tool description AND warning
# field REACH THE LLM, not just "改了文件".
#
# Runs against an isolated hub started from ../../../server (fresh
# COMMHUB_DB + UPLOADS_DIR + HOME, no touch of production). Uses a Bun
# MCP client (./mcp-inspect.ts) to hit tools/list and tools/call.
#
# What this verifies (that unit tests do NOT):
#   1. The description string in server/src/tools.ts is actually served
#      via the MCP tools/list response — i.e. the LLM sees it.
#   2. The warning branch fires for a real agent alias AND stays silent
#      for hub/api aliases — end-to-end through the MCP transport.
#
# What unit tests do that this does NOT: witnessed-red regression
# coverage (server/src/send-reply-agent-warning.test.ts). Run both.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
ISO="${TMPDIR:-/tmp}/anet-498-hardgate.$$"
rm -rf "$ISO"; mkdir -p "$ISO/hub-home/.commhub" "$ISO/uploads"

export PORT="${PORT:-9261}"
export HOST=127.0.0.1
export COMMHUB_DB="$ISO/hub-home/.commhub/iso.db"
export COMMHUB_UPLOADS_DIR="$ISO/uploads"
export HOME="$ISO/hub-home"

echo "=== Boot isolated hub on :$PORT (from $REPO/server) ==="
cd "$REPO/server"
nohup bun run src/index.ts >"$ISO/hub.log" 2>&1 &
HUB_PID=$!
trap 'kill "$HUB_PID" 2>/dev/null || true; rm -rf "$ISO"' EXIT
for _ in $(seq 1 20); do
  sleep 0.5
  curl -sS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true' && break
done
curl -sS "http://127.0.0.1:$PORT/health" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("hub up, version",d.get("version"))'

echo ""
echo "=== Register admin, capture ntok_ ==="
REG=$(curl -sS -X POST "http://127.0.0.1:$PORT/api/auth/register" \
  -H "Content-Type: application/json" -d '{"username":"iso498","password":"IsoTest123!"}')
UTOK=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
NTOK=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("network_token",""))')
NETID=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("network_id",""))')
echo "utok=${UTOK:0:12}...  ntok=${NTOK:0:12}...  netid=$NETID"

echo ""
echo "=== Seed fake agent session + tasks ==="
python3 - <<PY
import sqlite3, uuid, os
c = sqlite3.connect(os.environ["COMMHUB_DB"])
cur = c.cursor()
netid = cur.execute("SELECT network_id FROM networks LIMIT 1").fetchone()[0]
cur.execute("""INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
               VALUES (?,?,?,?,?,datetime('now'),datetime('now'))""",
            ("res_peer", "test-agent-peer", "idle", "n_peer", netid))
cur.execute("""INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, created_at, updated_at)
               VALUES (?,?,?,?,?,datetime('now'),datetime('now'))""",
            ("n_peer", "test-agent-peer", "test-agent-peer", "claude", netid))
for to in ("test-agent-peer", "hub", "api"):
    tid = "t_" + uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO tasks (task_id, from_name, to_name, status, priority, content, network_id, created_at)
                   VALUES (?,?,?,?,?,?,?,datetime('now'))""",
                (tid, "dispatcher", to, "delivered", "normal", f"task to {to}", netid))
    print(f"TID_{to.upper().replace('-','_')}={tid}")
c.commit(); c.close()
PY

# Read TIDs from output
eval "$(python3 - <<PY
import sqlite3, os
c = sqlite3.connect(os.environ["COMMHUB_DB"])
for to in ("test-agent-peer","hub","api"):
    r = c.execute("SELECT task_id FROM tasks WHERE to_name=? ORDER BY created_at DESC LIMIT 1",(to,)).fetchone()
    key = to.upper().replace('-','_')
    print(f"TID_{key}={r[0]}")
PY
)"
echo "TID_TEST_AGENT_PEER=$TID_TEST_AGENT_PEER  TID_HUB=$TID_HUB  TID_API=$TID_API"

echo ""
echo "=== Drive MCP client ==="
export HUB="http://127.0.0.1:$PORT" UTOK="$NTOK"
export AGENT_TASK_ID="$TID_TEST_AGENT_PEER" HUB_TASK_ID="$TID_HUB"
# ntok is auto-bound to a node whose alias equals the registered username
# (auto-created "node:<username>" token). Pass that alias so send_reply's
# from_session identity check passes.
export FROM_SESSION="iso498"
bun run "$HERE/mcp-inspect.ts"
