#!/usr/bin/env bash
# RFC-026 P2 PR1 (#338) — `anet daemon` CLI e2e.
# Proves: from zero, a user runs `anet daemon init` → config.json gets
# role=host_supervisor + defaults (NO manual edit) → `anet daemon start`
# registers → hub /api/nodes returns role=host_supervisor → dashboard
# can discover it via the post-#337 role-based path.

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9244
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-anet-daemon.db
WORK=/tmp/qa-anet-daemon-work
ADMIN_USER="anetdmnadmin"
ADMIN_PW="anetdmn_TestPass_1234!"
DAEMON_NAME="my-daemon"

PASS=0; FAIL=0
note(){ printf "\n=== %s ===\n" "$*"; }
ok()  { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad() { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── Stage 0 — hub + admin user
note "Stage 0 — isolated hub :$HUB_PORT + admin user"
safe_rm_rf "$WORK" 2>/dev/null || true
rm -f "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null
mkdir -p "$WORK"
COMMHUB_DB="$HUB_DB" PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test \
  bun run /app/server/src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..30}; do sleep 0.5; curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; done
curl -fsS "$HUB_BASE/health" >/dev/null && ok "hub /health 200" || { bad "hub failed to start"; tail -20 /tmp/hub.log; exit 1; }

R=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"display_name\":\"A\"}")
UTOK=$(echo "$R" | jq -r .token); NET=$(echo "$R" | jq -r .network_id)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted (net=${NET:0:12})" || { bad "register: $R"; exit 1; }

# Point anet CLI at this hub for the duration of the test (writes ~/.anet/config.json)
cd "$WORK"
mkdir -p "$HOME/.anet"
cat > "$HOME/.anet/config.json" <<EOF
{
  "hub": "$HUB_BASE",
  "token": "$UTOK",
  "network_id": "$NET"
}
EOF
ok "~/.anet/config.json wired to test hub"

# ── A — anet daemon list (empty) on fresh install
note "A. anet daemon list on fresh install"
OUT=$(anet daemon list 2>&1)
echo "$OUT" | grep -q "No host_supervisor daemons" && ok "empty list reports no daemons" || bad "unexpected list output: $OUT"

# ── B — anet daemon init <name> creates config WITHOUT manual edit
note "B. anet daemon init $DAEMON_NAME — zero manual config.json edit"
anet daemon init "$DAEMON_NAME" 2>&1 | tee /tmp/init.log >/dev/null
[[ -f "$WORK/.anet/nodes/$DAEMON_NAME/config.json" ]] && ok "config.json materialized" || { bad "config.json missing"; tail /tmp/init.log; exit 1; }

# Assert the new config has role=host_supervisor + defaults (the actual unblocker)
ROLE=$(jq -r '.role' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$ROLE" == "host_supervisor" ]] && ok "config.role == host_supervisor (no vim required)" || bad "role='$ROLE' expected host_supervisor"

RUNTIMES=$(jq -r '.runtimes_supported | join(",")' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$RUNTIMES" == "claude-agent-sdk,codex-sdk,grok-build-acp" ]] && ok "runtimes_supported defaults set" || bad "runtimes_supported='$RUNTIMES'"

ALLOWED=$(jq -r '.allowed_secret_keys | length' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$ALLOWED" == "0" ]] && ok "allowed_secret_keys fail-closed (empty by default per §9.7)" || bad "allowed_secret_keys length=$ALLOWED expected 0"

NODE_ID=$(jq -r '.node_id' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$NODE_ID" == node_daemon_* ]] && ok "node_id prefix node_daemon_ (P1 #24 fallback compat)" || bad "node_id='$NODE_ID' not prefixed"

TOK=$(jq -r '.token' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$TOK" == ntok_* ]] && ok "ntok minted + persisted" || bad "token='$TOK' not ntok_"

# ── C — re-init same daemon is idempotent (no destructive)
note "C. re-init idempotence"
TOK_BEFORE="$TOK"
NID_BEFORE="$NODE_ID"
OUT=$(anet daemon init "$DAEMON_NAME" 2>&1)
echo "$OUT" | grep -q "already a host_supervisor" && ok "init reports 'already a daemon' on second run" || bad "re-init didn't surface idempotence: $OUT"
TOK_AFTER=$(jq -r '.token' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
NID_AFTER=$(jq -r '.node_id' "$WORK/.anet/nodes/$DAEMON_NAME/config.json")
[[ "$TOK_BEFORE" == "$TOK_AFTER" ]] && ok "token NOT re-minted on idempotent init (no churn)" || bad "token churned despite idempotence"
[[ "$NID_BEFORE" == "$NID_AFTER" ]] && ok "node_id preserved on idempotent init" || bad "node_id churned"

# ── D — refuse to overwrite non-daemon node without --force
note "D. refuse to overwrite non-daemon node without --force"
mkdir -p "$WORK/.anet/nodes/regular-node"
echo '{"node_id":"node_regular","node_name":"regular-node","runtime":"claude-agent-sdk","role":"member"}' \
  > "$WORK/.anet/nodes/regular-node/config.json"
OUT=$(anet daemon init "regular-node" 2>&1)
RC=$?
[[ "$RC" -ne 0 ]] && ok "exit code non-zero on conflict (was $RC)" || bad "exited 0 despite role conflict"
echo "$OUT" | grep -q '"member"' && ok "error names the conflicting role" || bad "error missing role mention: $OUT"
# Verify the regular-node config WAS NOT overwritten
EXISTING_ROLE=$(jq -r '.role' "$WORK/.anet/nodes/regular-node/config.json")
[[ "$EXISTING_ROLE" == "member" ]] && ok "regular-node config untouched (no destructive write)" || bad "regular-node role mutated to '$EXISTING_ROLE'"

# ── E — --force overwrite mints new token but PRESERVES node_id
note "E. --force overwrite preserves node_id, re-mints token"
NID_REGULAR=$(jq -r '.node_id' "$WORK/.anet/nodes/regular-node/config.json")
anet daemon init "regular-node" --force 2>&1 >/tmp/force.log
NEW_ROLE=$(jq -r '.role' "$WORK/.anet/nodes/regular-node/config.json")
NEW_NID=$(jq -r '.node_id' "$WORK/.anet/nodes/regular-node/config.json")
[[ "$NEW_ROLE" == "host_supervisor" ]] && ok "--force flipped role to host_supervisor" || bad "--force didn't flip role (got '$NEW_ROLE')"
[[ "$NEW_NID" == "$NID_REGULAR" ]] && ok "--force preserved node_id ($NID_REGULAR)" || bad "node_id changed (was $NID_REGULAR, now $NEW_NID)"

# ── F — anet daemon list shows the daemons
note "F. anet daemon list shows the 2 daemons"
LIST=$(anet daemon list 2>&1)
echo "$LIST" | grep -q "$DAEMON_NAME" && ok "list shows '$DAEMON_NAME'" || bad "list missing '$DAEMON_NAME'"
echo "$LIST" | grep -q "regular-node" && ok "list shows 'regular-node' (newly --force'd into daemon)" || bad "list missing 'regular-node'"
COUNT=$(echo "$LIST" | grep -E "node_id=" | wc -l)
[[ "$COUNT" -ge 2 ]] && ok "list count >= 2 ($COUNT)" || bad "list count $COUNT expected >=2"

# ── G — anet daemon start + register + hub /api/nodes returns role
note "G. anet daemon start → register → hub /api/nodes returns role=host_supervisor"
# Use the original daemon (not the --force'd one)
nohup anet daemon start "$DAEMON_NAME" > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!
REG=""
for i in {1..30}; do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes?node_id=$NID_AFTER" -H "Authorization: Bearer $UTOK")
  if echo "$R" | jq -e ".nodes[0].node_id == \"$NID_AFTER\"" >/dev/null 2>&1; then REG=yes; break; fi
done
[[ -n "$REG" ]] && ok "daemon registered with hub (node_id=$NID_AFTER)" || { bad "daemon never registered"; tail -30 /tmp/daemon.log; exit 1; }

# CRITICAL: post-#337, hub /api/nodes returns role field extracted from config_snapshot.
# This is the integration that unblocks the dashboard's role-based daemon discovery (#24).
HUB_ROLE=$(curl -sS "$HUB_BASE/api/nodes?node_id=$NID_AFTER" -H "Authorization: Bearer $UTOK" | jq -r '.nodes[0].role')
[[ "$HUB_ROLE" == "host_supervisor" ]] && ok "hub /api/nodes returns role=host_supervisor (post-#337 integration真)" || bad "hub role='$HUB_ROLE' expected host_supervisor"

# Dashboard-style discovery: rows.find(r => r.role === 'host_supervisor') succeeds
DASHBOARD_FOUND=$(curl -sS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK" | jq -r '[.nodes[] | select(.role=="host_supervisor")] | length')
[[ "$DASHBOARD_FOUND" -ge 1 ]] && ok "dashboard-style discovery succeeds (≥1 daemon found)" || bad "dashboard discovery would still fail"

# ── H — daemon up (init+start one-shot) works on a fresh name
note "H. anet daemon up oneshot — init+start in single command"
kill "$DAEMON_PID" 2>/dev/null
sleep 1
nohup anet daemon up "oneshot-daemon" > /tmp/oneshot.log 2>&1 &
DAEMON_PID=$!
ONESHOT_REG=""
for i in {1..30}; do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes?alias=oneshot-daemon" -H "Authorization: Bearer $UTOK")
  if echo "$R" | jq -e '.nodes[0].alias == "oneshot-daemon"' >/dev/null 2>&1; then ONESHOT_REG=yes; break; fi
done
[[ -n "$ONESHOT_REG" ]] && ok "daemon up registered 'oneshot-daemon' end-to-end" || { bad "oneshot never registered"; tail -30 /tmp/oneshot.log; }

printf "\n────────────────────────────────────────────\n"
printf "anet daemon CLI e2e — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]
