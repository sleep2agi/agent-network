#!/usr/bin/env bash
# #517 / PR #519 — MCP write-path network resolution e2e, through the REAL
# auth chain: register → login utok_ (current_network=null) → POST /mcp.
# Layered per AGENTS.md: env → auth → single write → multi-network →
# deleted-network → roles. Exact-match assertions on error AND message
# (accepted set == spec-allowed set).


# SHA 绑定。ARG 名须能被 scripts/qa.sh 的 `^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)` 匹配。
[[ "${TEST517_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: TEST517_SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
printf 'source_commit=%s\n' "$TEST517_SOURCE_COMMIT"

set -uo pipefail

HUB_PORT=9251
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa517-hub.db
U1=qa517owner;  P1='Qa517_Owner_Pass_1!'
U2=qa517viewer; P2='Qa517_Viewer_Pass_2!'
U3=qa517outsider; P3='Qa517_Outsider_Pass_3!'
TARGET=peer-517-e2e

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }

# expect_exact <label> <actual> <expected>
expect_exact() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — got [$2] want [$3]"; fi
}

mcp_init_once() {
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa517","version":"0"}}}' >/dev/null 2>&1 || true
}
# mcp_call <token> <tool> <arguments-json> → inner tool reply JSON
mcp_call() {
  local tok="$1" tool="$2" args="$3"
  local body="{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
  local resp; resp=$(curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body")
  local inner; inner=$(echo "$resp" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
  if [[ -z "$inner" || "$inner" == "null" ]]; then
    inner=$(echo "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  fi
  [[ -z "$inner" || "$inner" == "null" ]] && echo "$resp" || echo "$inner"
}

register_and_login() { # <user> <pass> → token on stdout
  curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
  curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r .token
}
me_json() { curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $1"; }

note "L0 env — hub boot"
rm -f "$HUB_DB" "$HUB_DB-wal" "$HUB_DB-shm"
( cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" bun run src/index.ts >/tmp/qa517-hub.log 2>&1 & )
for i in $(seq 1 30); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200 :$HUB_PORT" \
  || { bad "hub did not start"; tail -40 /tmp/qa517-hub.log; exit 1; }

note "L1 auth — utok with current_network=null (the #517 precondition)"
TOK1=$(register_and_login "$U1" "$P1")
[[ "$TOK1" == utok_* ]] && ok "login issues utok_ token" || bad "expected utok_, got: ${TOK1:0:12}"
ME1=$(me_json "$TOK1")
NET1=$(echo "$ME1" | jq -r '.networks[0].network_id')
[[ -n "$NET1" && "$NET1" != "null" ]] && ok "register auto-created default network ($NET1)" || bad "no default network"
CURNET=$(echo "$ME1" | jq -r '.current_network')
expect_exact "utok current_network is null (issue precondition)" "$CURNET" "null"
mcp_init_once "$TOK1"

note "L2 seed — target agent session inside $NET1 (direct sqlite, no prod)"
sqlite3 "$HUB_DB" "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES ('node_qa517','$TARGET','$TARGET','$NET1','qa517-host',datetime('now'),datetime('now'),'active');"
sqlite3 "$HUB_DB" "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES ('res_qa517','$TARGET','idle','node_qa517','$NET1',datetime('now'),datetime('now'));"
ok "seeded node+session $TARGET in $NET1"

note "L3 single-network utok writes WITHOUT network_id (the fix)"
R=$(mcp_call "$TOK1" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S1 single-net send_task\"}")
expect_exact "S1 send_task ok" "$(echo "$R" | jq -r .ok)" "true"
ROWNET=$(sqlite3 "$HUB_DB" "SELECT network_id FROM tasks WHERE content='qa517 S1 single-net send_task';")
expect_exact "S2 task row scoped to $NET1" "$ROWNET" "$NET1"
R=$(mcp_call "$TOK1" send_message "{\"alias\":\"$TARGET\",\"message\":\"qa517 S3 single-net send_message\"}")
expect_exact "S3 send_message ok (tool previously had NO network_id input)" "$(echo "$R" | jq -r .ok)" "true"

note "L4 multi-network utok — ambiguous without, explicit works"
NET2=$(curl -sS -X POST "$HUB_BASE/api/networks" -H "Authorization: Bearer $TOK1" -H 'Content-Type: application/json' \
  -d '{"name":"qa517-net2"}' | jq -r .network_id)
[[ -n "$NET2" && "$NET2" != "null" ]] && ok "created second network ($NET2)" || bad "network create failed"
R=$(mcp_call "$TOK1" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S4 ambiguous\"}")
expect_exact "S4 error" "$(echo "$R" | jq -r .error)" "network_id_required"
expect_exact "S4 message" "$(echo "$R" | jq -r .message)" "user token spans 2 networks; pass network_id explicitly (see /api/auth/me networks[].network_id)"
R=$(mcp_call "$TOK1" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S5 explicit\",\"network_id\":\"$NET1\"}")
expect_exact "S5 explicit network_id ok" "$(echo "$R" | jq -r .ok)" "true"

note "L5 deleted network — membership cleanup restores auto-resolve"
DEL=$(curl -sS -X DELETE "$HUB_BASE/api/networks/$NET2" -H "Authorization: Bearer $TOK1" | jq -r .ok)
expect_exact "delete second network" "$DEL" "true"
R=$(mcp_call "$TOK1" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S6 post-delete\"}")
expect_exact "S6 auto-resolve works again after delete (no ghost membership)" "$(echo "$R" | jq -r .ok)" "true"

note "L6 viewer role — resolves, then role-denied with viewer wording"
TOK2=$(register_and_login "$U2" "$P2")
NET2OWN=$(me_json "$TOK2" | jq -r '.networks[0].network_id')
curl -sS -X DELETE "$HUB_BASE/api/networks/$NET2OWN" -H "Authorization: Bearer $TOK2" >/dev/null
INV=$(curl -sS -X POST "$HUB_BASE/api/networks/$NET1/invite" -H "Authorization: Bearer $TOK1" -H 'Content-Type: application/json' \
  -d '{"role":"viewer"}' | jq -r .invite_code)
JOINED=$(curl -sS -X POST "$HUB_BASE/api/networks/join" -H "Authorization: Bearer $TOK2" -H 'Content-Type: application/json' \
  -d "{\"invite_code\":\"$INV\"}" | jq -r .ok)
expect_exact "viewer joined $NET1 via invite" "$JOINED" "true"
mcp_init_once "$TOK2"
R=$(mcp_call "$TOK2" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S7 viewer\"}")
expect_exact "S7 error" "$(echo "$R" | jq -r .error)" "permission_denied"
expect_exact "S7 message" "$(echo "$R" | jq -r .message)" "Viewer role cannot send tasks"

note "L7 outsider — explicit foreign network_id"
TOK3=$(register_and_login "$U3" "$P3")
NET3=$(me_json "$TOK3" | jq -r '.networks[0].network_id')
mcp_init_once "$TOK3"
R=$(mcp_call "$TOK3" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S8 outsider\",\"network_id\":\"$NET1\"}")
expect_exact "S8 error" "$(echo "$R" | jq -r .error)" "access_denied"
expect_exact "S8 message" "$(echo "$R" | jq -r .message)" "access denied to requested network (not a member)"

note "L8 zero memberships — after deleting own default network"
curl -sS -X DELETE "$HUB_BASE/api/networks/$NET3" -H "Authorization: Bearer $TOK3" >/dev/null
R=$(mcp_call "$TOK3" send_task "{\"alias\":\"$TARGET\",\"task\":\"qa517 S9 none\"}")
expect_exact "S9 error" "$(echo "$R" | jq -r .error)" "network_id_required"
expect_exact "S9 message" "$(echo "$R" | jq -r .message)" "user token has no network memberships; join or create a network first"
ORPHANS=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM tasks WHERE content LIKE 'qa517 S9%';")
expect_exact "S9 no orphaned task row written" "$ORPHANS" "0"

note "result"
printf "\nPASS=%d FAIL=%d\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] && echo "QA-517 ALL PASS" || echo "QA-517 FAILED"
exit $(( FAIL > 0 ))
