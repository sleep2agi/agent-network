#!/usr/bin/env bash
# Case 9 — rename → dashboard SSE: new alias appears immediately, no reload.
# Probes the canonical /api/status snapshot the dashboard polls + uses SSE
# clients endpoint (subscriber count visible in /health).
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-09"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 9: rename → dashboard sees new alias immediately (SSE Map rebind)"

anet node create dash-old --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
nohup anet node start dash-old > "$ART_DIR/start-old.log" 2>&1 &
P=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-old.log" 2>/dev/null && break; sleep 1; done

# Pre-rename: dashboard sees dash-old
PRE=$(curl -sf -H "Authorization: Bearer $UTOK" "$HUB/api/status" | jq -c '[.sessions[]?|select(.alias=="dash-old")][0]|.alias')
[ "$PRE" = '"dash-old"' ] && record_check "pre-rename: /api/status has dash-old" PASS "" || record_check "pre-rename: /api/status has dash-old" FAIL "alias=$PRE"

# Subscriber count (sse_connections in /health)
PRE_SSE=$(curl -sf "$HUB/health" | jq -r '.sse_connections // 0')
LOG "pre-rename sse_connections=$PRE_SSE"

kill -TERM "$P" 2>/dev/null; sleep 2
anet node rename dash-old dash-new --force > "$ART_DIR/rename.log" 2>&1
record_check "rename ok" PASS "rc=$?"

# Start under new alias
nohup anet node start dash-new > "$ART_DIR/start-new.log" 2>&1 &
P2=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-new.log" 2>/dev/null && break; sleep 1; done

# Post-rename: /api/status reflects NEW alias immediately
POST=$(curl -sf -H "Authorization: Bearer $UTOK" "$HUB/api/status" | jq -c '[.sessions[]?|select(.alias=="dash-new")][0]|.alias')
[ "$POST" = '"dash-new"' ] && record_check "post-rename: /api/status has dash-new" PASS "" || record_check "post-rename: /api/status has dash-new" FAIL "alias=$POST"

# OLD alias should NOT be visible as a separate session
STALE=$(curl -sf -H "Authorization: Bearer $UTOK" "$HUB/api/status" | jq -c '[.sessions[]?|select(.alias=="dash-old")]|length')
[ "$STALE" = "0" ] && record_check "old alias dash-old NOT in /api/status" PASS "no ghost" || record_check "old alias dash-old NOT in /api/status" FAIL "stale ghost session count=$STALE"

# SSE Map should be rebuilt — sse_connections >= 1 (the dash-new client)
POST_SSE=$(curl -sf "$HUB/health" | jq -r '.sse_connections // 0')
LOG "post-rename sse_connections=$POST_SSE (was $PRE_SSE)"

kill -TERM "$P2" 2>/dev/null
stop_hub
case_verdict 9 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
