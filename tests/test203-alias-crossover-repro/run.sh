#!/usr/bin/env bash
# P0 #203 alias 串号 — post-fix e2e.
#
# Scope: server-side attribution logic exposed by a real hub, driven with
# raw MCP calls that mimic what agent-node / node-server.ts do. NO agent-node
# runtime spawn here — we probe the wire shape and DB state directly.
#
# Scenarios exercised (per the 通信龙 PASS spec):
#   S1: node A + node B, both alive, each reports_status with its own alias
#       via its own ntok, then B sends send_task to A. Expect from=B.
#   S2: node B's runtime accidentally reports_status with alias=A while
#       holding ntok_B (the "client alias drift" vector). Post-fix: server
#       returns alias_identity_mismatch, token binding stays 'node:grokB',
#       no 串号 inbox row is written.
#   S2b: after the rejected mismatch, ntok_B recovers normally (self-heal
#       on correct alias). Confirms the guard doesn't wedge the token.
#   S3: `anet node delete A` scenario — old ntok_A still valid on hub; new
#       ntok minted for name grokA behaves independently.
#   S4: from_session spoofing sanity — client-supplied from_session that
#       differs from token-bound alias must be rejected (test198 fix, kept).
#   S5: fresh token first-time report_status (通信龙's review-point catch —
#       must NOT be rejected by the new guard). The ntok is minted with
#       api_tokens.name='node:<alias>', and the runtime's first heartbeat
#       matches → guard skipped → OK.
#   S6: agent-network launcher env-leak defense — cli.ts was hardened to
#       strip stale COMMHUB_NODE_ID from spawn env when profile.node_id is
#       falsy. Sanity-grep the source change so a future regression
#       (someone reverting the `delete`) doesn't silently reintroduce the
#       drift seed. This is a shape-pin, not a runtime e2e.
#   S7: agent-node --alias vs fileConfig.alias mismatch — verify the
#       promoted warn→error at agent-node/src/cli.ts exits non-zero.
#       ANET_ALLOW_ALIAS_MISMATCH=1 escape hatch stays working.
#
# Numbers are dumped into report.txt for PR body citation. Every scenario
# emits a `PASS` / `FAIL` verdict. Overall pass gate at end.


# SHA 绑定。ARG 名须能被 scripts/qa.sh 的 `^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)` 匹配。
[[ "${TEST203_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: TEST203_SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
printf 'source_commit=%s\n' "$TEST203_SOURCE_COMMIT"

set -euo pipefail

export HOME=/tmp/anethome
export COMMHUB_DB=/tmp/qa-203-hub.db
export PORT=9240
BASE="http://127.0.0.1:${PORT}"
REPORT="/repo/docs/tests/p203-alias-crossover/report.txt"
mkdir -p "$(dirname "$REPORT")" "$HOME"

cleanup() { kill "${HUB_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

mcp_call() {
  local token="$1" tool="$2" args="$3"
  local body raw json text
  body=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw=$(curl -sS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2025-03-26" \
    -d "$body")
  json=$(echo "$raw" | sed -n 's/^data: //p' | head -1)
  [[ -z "$json" ]] && json="$raw"
  text=$(echo "$json" | jq -r '.result.content[0].text // empty')
  [[ -n "$text" ]] || { echo "empty MCP response for $tool: $raw" >&2; return 1; }
  echo "$text"
}

json_post() {
  local path="$1" token="$2" body="$3"
  curl -sS -X POST "$BASE$path" \
    ${token:+-H "Authorization: Bearer $token"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

rec() { printf '  %s = %s\n' "$1" "$2" >> "$REPORT"; }
sec() { printf '\n## %s\n\n' "$1" >> "$REPORT"; }

OVERALL_FAIL=0
pass() { rec "$1 verdict" "PASS — $2"; }
fail() { rec "$1 verdict" "FAIL — $2"; OVERALL_FAIL=1; }

: > "$REPORT"
cat >> "$REPORT" <<HDR
# test203-alias-crossover-repro (post-fix)

Isolated hub: port=$PORT db=$COMMHUB_DB (not touching prod).
Server code under test: tools.ts report_status identity guard (Layer 1)
Launcher hardening under test: bin/cli.ts env-leak strip (Layer 2A)
Runtime hardening under test: agent-node cli.ts warn->error (Layer 2B)

HDR

rm -f "$COMMHUB_DB"
bun run server/src/index.ts >/tmp/commhub.log 2>&1 &
HUB_PID=$!
for _ in {1..80}; do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -120 /tmp/commhub.log; exit 1; }

ADMIN=$(json_post "/api/auth/register" "" '{"username":"admin","password":"anethub"}')
UTOK=$(echo "$ADMIN" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] || { echo "register failed: $ADMIN"; exit 1; }

NET=$(json_post "/api/networks" "$UTOK" '{"name":"n-203"}')
NET_ID=$(echo "$NET" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "network failed: $NET"; exit 1; }

mint() {
  local name="$1"
  json_post "/api/auth/node-token" "$UTOK" \
    "{\"network_id\":\"$NET_ID\",\"node_name\":\"$name\"}" | jq -r '.token // empty'
}

TOK_A=$(mint "grokA")
TOK_B=$(mint "grokB")
[[ "$TOK_A" == ntok_* && "$TOK_B" == ntok_* ]] || { echo "mint failed"; exit 1; }
[[ "$TOK_A" != "$TOK_B" ]] || { echo "mint returned same token"; exit 1; }

sec "Setup"
rec "network_id" "$NET_ID"
rec "ntok_A prefix" "${TOK_A:0:12}..."
rec "ntok_B prefix" "${TOK_B:0:12}..."

dump_token_names() {
  sqlite3 -header -column "$COMMHUB_DB" \
    "SELECT substr(token_hash,1,10) AS hash10, name, last_used_at FROM api_tokens ORDER BY created_at" >> "$REPORT"
  echo >> "$REPORT"
}
dump_sessions() {
  sqlite3 -header -column "$COMMHUB_DB" \
    "SELECT resume_id, alias, node_id, network_id FROM sessions ORDER BY updated_at" >> "$REPORT"
  echo >> "$REPORT"
}

# ── S1: honest register + honest send ────────────────────────────────────
sec "S1 honest baseline — A and B each register with own alias via own ntok, B sends to A"

R1A=$(mcp_call "$TOK_A" "report_status" \
  "$(jq -nc --arg net "$NET_ID" '{resume_id:"sdk-nodeA",alias:"grokA",status:"idle",node_id:"n_A00001",network_id:$net}')")
echo "$R1A" | jq -e '.ok==true and .alias=="grokA"' >/dev/null || fail "S1" "A register: $R1A"

R1B=$(mcp_call "$TOK_B" "report_status" \
  "$(jq -nc --arg net "$NET_ID" '{resume_id:"sdk-nodeB",alias:"grokB",status:"idle",node_id:"n_B00001",network_id:$net}')")
echo "$R1B" | jq -e '.ok==true and .alias=="grokB"' >/dev/null || fail "S1" "B register: $R1B"

S1SEND=$(mcp_call "$TOK_B" "send_task" '{"alias":"grokA","task":"S1 honest send from B"}')
echo "$S1SEND" | jq -e '.ok==true' >/dev/null || fail "S1" "B send: $S1SEND"

INBOX_A=$(mcp_call "$TOK_A" "get_inbox" '{"alias":"grokA","limit":5}')
FROM_S1=$(echo "$INBOX_A" | jq -r '.messages[]|select(.content=="S1 honest send from B")|.from_session' | head -1)
rec "S1 A registered as" "$(echo "$R1A" | jq -r .alias)"
rec "S1 B registered as" "$(echo "$R1B" | jq -r .alias)"
rec "S1 inbox from_session" "$FROM_S1"
if [[ "$FROM_S1" == "grokB" ]]; then pass "S1" "honest baseline correctly attributes B"; else fail "S1" "expected grokB, got '$FROM_S1'"; fi

sec "S1 DB dump — api_tokens after honest register"
dump_token_names
sec "S1 DB dump — sessions"
dump_sessions

# ── S2: drift attack — expect REJECTION post-fix ─────────────────────────
sec "S2 drift attack — ntok_B reports_status with alias=grokA (client bug), expect alias_identity_mismatch"

R2=$(mcp_call "$TOK_B" "report_status" \
  "$(jq -nc --arg net "$NET_ID" '{resume_id:"sdk-nodeB",alias:"grokA",status:"idle",node_id:"n_B00001",network_id:$net}')")
rec "S2 report_status resp" "$(echo "$R2" | jq -c '{ok,error,token_alias,reported_alias}')"

sec "S2 DB dump — api_tokens after rejected drift"
dump_token_names

# Token binding for both ntoks should remain untouched (still 'node:grokA'
# and 'node:grokB' respectively). Extract by matching the last_used_at
# sort — the one just used is ntok_B.
NAMES_S2=$(sqlite3 "$COMMHUB_DB" \
  "SELECT GROUP_CONCAT(name, ',') FROM api_tokens WHERE name IN ('node:grokA','node:grokB')")
rec "S2 api_tokens names (grokA/grokB tokens)" "$NAMES_S2"

# Send via ntok_B — because the identity guard blocked the report_status,
# api_tokens.name for ntok_B is still 'node:grokB', so the server will
# authenticate this send as callerAlias=grokB. Without a from_session in
# the payload the defaultFrom() falls through to callerAlias, so any inbox
# row created here should have from_session=grokB (or the send should be
# rejected if the client supplies from_session=grokA). We omit from_session
# to observe pure token-driven attribution.
S2SEND=$(mcp_call "$TOK_B" "send_task" '{"alias":"grokA","task":"S2 post-mismatch send from B"}')
rec "S2 send_task resp after mismatch" "$(echo "$S2SEND" | jq -c '{ok,error,token_alias,requested_from_session}')"

INBOX_A2=$(mcp_call "$TOK_A" "get_inbox" '{"alias":"grokA","limit":10}')
FROM_S2=$(echo "$INBOX_A2" | jq -r '.messages[]|select(.content=="S2 post-mismatch send from B")|.from_session' | head -1)
rec "S2 inbox from_session" "${FROM_S2:-<not delivered>}"

# Verdict: alias_identity_mismatch on report_status + no from=grokA row.
if echo "$R2" | jq -e '.ok==false and .error=="alias_identity_mismatch" and .token_alias=="grokB" and .reported_alias=="grokA"' >/dev/null \
    && [[ "$FROM_S2" != "grokA" ]]; then
  pass "S2" "server rejected drift (alias_identity_mismatch), no 串号 inbox row (from=$FROM_S2)"
else
  fail "S2" "expected mismatch reject + no from=grokA row; got resp=$R2 inbox_from=$FROM_S2"
fi

# ── S2b: after rejection, correct-alias report_status still works ───────
sec "S2b recovery — ntok_B reports_status with correct alias=grokB after mismatch"
R2B=$(mcp_call "$TOK_B" "report_status" \
  "$(jq -nc --arg net "$NET_ID" '{resume_id:"sdk-nodeB",alias:"grokB",status:"idle",node_id:"n_B00001",network_id:$net}')")
rec "S2b report_status resp" "$(echo "$R2B" | jq -c '{ok,alias,error}')"
if echo "$R2B" | jq -e '.ok==true and .alias=="grokB"' >/dev/null; then
  pass "S2b" "correct-alias report_status still works after a rejected mismatch"
else
  fail "S2b" "recovery broken: $R2B"
fi

# ── S3: same-name recreate ────────────────────────────────────────────
sec "S3 recreate — mint ntok_A2 for name grokA again (simulates delete+create)"

TOK_A2=$(mint "grokA")
if [[ "$TOK_A2" == ntok_* && "$TOK_A2" != "$TOK_A" ]]; then
  rec "S3 ntok_A prefix (old)" "${TOK_A:0:12}..."
  rec "S3 ntok_A2 prefix (new)" "${TOK_A2:0:12}..."
else
  fail "S3" "mint failed or dup: $TOK_A2"
fi

sec "S3 DB dump — api_tokens after 2nd mint for name grokA"
dump_token_names

S3OLD=$(mcp_call "$TOK_A" "send_task" '{"alias":"grokB","task":"S3 old-ntok send"}')
rec "S3 old-ntok send resp" "$(echo "$S3OLD" | jq -c '{ok,error}')"
INBOX_B3=$(mcp_call "$TOK_B" "get_inbox" '{"alias":"grokB","limit":5}')
FROM_S3=$(echo "$INBOX_B3" | jq -r '.messages[]|select(.content=="S3 old-ntok send")|.from_session' | head -1)
rec "S3 inbox from_session (old ntok as sender)" "${FROM_S3:-<not delivered>}"
if [[ "$FROM_S3" == "grokA" ]]; then
  pass "S3" "old ntok still attributes to its own alias (grokA) — delete path separate concern"
else
  fail "S3" "unexpected: from=$FROM_S3"
fi

# ── S4: send-side from_session spoof (test198 fix, still in effect) ─────
sec "S4 spoof — ntok_B sends with from_session=grokA (should reject via test198 guard)"
S4=$(mcp_call "$TOK_B" "send_task" '{"alias":"grokA","task":"S4 spoof","from_session":"grokA"}')
rec "S4 resp" "$(echo "$S4" | jq -c '{ok,error,token_alias,requested_from_session}')"
INBOX_A4=$(mcp_call "$TOK_A" "get_inbox" '{"alias":"grokA","limit":30}')
FROM_S4=$(echo "$INBOX_A4" | jq -r '.messages[]|select(.content=="S4 spoof")|.from_session' | head -1)
rec "S4 inbox row after spoof" "${FROM_S4:-<not delivered — good>}"
if echo "$S4" | jq -e '.ok==false and .error=="from_session_identity_mismatch"' >/dev/null && [[ -z "$FROM_S4" ]]; then
  pass "S4" "send-side spoof still rejected"
else
  fail "S4" "test198 protection regressed: $S4 / from=$FROM_S4"
fi

# ── S5: fresh-token first-time report_status ──────────────────────────
sec "S5 fresh token — mint fresh ntok, first-ever report_status. Must NOT be rejected by the new guard."

TOK_FRESH=$(mint "grokFresh")
[[ "$TOK_FRESH" == ntok_* ]] || fail "S5" "mint failed: $TOK_FRESH"
rec "S5 ntok_fresh prefix" "${TOK_FRESH:0:12}..."

R5=$(mcp_call "$TOK_FRESH" "report_status" \
  "$(jq -nc --arg net "$NET_ID" '{resume_id:"sdk-fresh",alias:"grokFresh",status:"idle",node_id:"n_FRESH01",network_id:$net}')")
rec "S5 fresh-token first report_status resp" "$(echo "$R5" | jq -c '{ok,alias,error}')"
if echo "$R5" | jq -e '.ok==true and .alias=="grokFresh"' >/dev/null; then
  pass "S5" "fresh token first heartbeat accepted (no false rejection)"
else
  fail "S5" "fresh-token guard regression: $R5"
fi

S5SEND=$(mcp_call "$TOK_FRESH" "send_task" '{"alias":"grokA","task":"S5 fresh first send"}')
INBOX_A5=$(mcp_call "$TOK_A" "get_inbox" '{"alias":"grokA","limit":30}')
FROM_S5=$(echo "$INBOX_A5" | jq -r '.messages[]|select(.content=="S5 fresh first send")|.from_session' | head -1)
rec "S5 fresh-token send from_session" "$FROM_S5"
[[ "$FROM_S5" == "grokFresh" ]] || fail "S5-send" "fresh-token send mis-attributed: $FROM_S5"

# ── S6: agent-network launcher env-leak strip (Layer 2A shape-pin) ─────
sec "S6 Layer 2A — agent-network launcher env-leak strip"

NODE_GUARD_HITS=$(grep -c "delete (env as Record<string, unknown>).COMMHUB_NODE_ID" /repo/agent-network/bin/cli.ts || true)
rec "S6 delete-COMMHUB_NODE_ID line count in bin/cli.ts" "$NODE_GUARD_HITS"
if [[ "$NODE_GUARD_HITS" -ge 2 ]]; then
  pass "S6" "env-leak strip present in both spawn branches"
else
  fail "S6" "expected >=2 delete-COMMHUB_NODE_ID lines, got $NODE_GUARD_HITS"
fi

# ── S7: agent-node --alias vs config mismatch → hard-fail exit ─────────
sec "S7 Layer 2B — agent-node warn->error on --alias / fileConfig.alias mismatch"

mkdir -p /tmp/s7-conf
cat > /tmp/s7-conf/config.json <<CFG
{
  "node_id": "n_S700001",
  "node_name": "grokConfig",
  "alias": "grokConfig",
  "network_id": "$NET_ID",
  "hub": "$BASE",
  "token": "$TOK_B"
}
CFG

# S7a: no bypass env — expect non-zero exit + '#203 alias mismatch' in stderr.
set +e
OUT=$(cd /repo/agent-node && ANET_ALLOW_ALIAS_MISMATCH= bun run src/cli.ts --config /tmp/s7-conf/config.json --alias grokFlag --runtime claude-agent-sdk 2>&1)
CODE=$?
set -e
rec "S7 exit code (mismatch, no bypass env)" "$CODE"
if [[ $CODE -ne 0 ]] && echo "$OUT" | grep -qE "#203 alias mismatch"; then
  pass "S7" "hard-failed as expected: exit=$CODE"
else
  fail "S7" "expected non-zero exit + '#203 alias mismatch' in stderr; got code=$CODE"
  echo "$OUT" | tail -20 >> "$REPORT"
fi

# S7b: escape hatch — set env=1, look for "continuing" note; kill after 3s
# so we don't spend forever waiting for a real hub connection.
set +e
OUT2=$(cd /repo/agent-node && timeout 3 bash -c 'ANET_ALLOW_ALIAS_MISMATCH=1 bun run src/cli.ts --config /tmp/s7-conf/config.json --alias grokFlag --runtime claude-agent-sdk 2>&1' || true)
set -e
if echo "$OUT2" | grep -qE "ANET_ALLOW_ALIAS_MISMATCH=1"; then
  pass "S7b" "ANET_ALLOW_ALIAS_MISMATCH=1 escape hatch still functional"
else
  fail "S7b" "escape hatch broken; stderr head: $(echo "$OUT2" | head -3)"
fi

sec "Summary"
cat >> "$REPORT" <<EOF
Layers under test:
  Layer 1 (server)    — tools.ts report_status alias_identity_mismatch guard
  Layer 2A (launcher) — agent-network bin/cli.ts spawn env-leak strip (2 branches)
  Layer 2B (runtime)  — agent-node src/cli.ts warn->error on --alias mismatch

Test198 send-side guard (server tools.ts defaultFrom/fromIdentityMismatchReply)
verified still active in S4.

EOF

cat "$REPORT"
echo
if [[ $OVERALL_FAIL -eq 0 ]]; then
  echo "OVERALL: PASS ($REPORT)"
  exit 0
else
  echo "OVERALL: FAIL — see $REPORT"
  exit 1
fi
