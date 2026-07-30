#!/usr/bin/env bash
# P0 #180 rename ghost — reproduction e2e.
#
# Two cases, direct comparison per 通信龙 3cc53bdc:
#   CASE A (foreground): anet node start <alias> in the background of THIS
#          shell (no tmux). rename --force from a separate anet call.
#          If ghost reproduces here → H1/H4 (rescan race / silent SIGKILL fail).
#   CASE B (tmux): anet node start <alias> via `tmux new-session -d` (the
#          path `anet project up` uses). rename --force from a separate anet
#          call. If ghost reproduces ONLY here → H3 (tmux wrapper respawn).
#
# Both cases use a mock 'claude' binary that heart-beats to the local hub
# (so /api/status can be queried for ghost detection) and ignores SIGTERM
# for 15s (simulating slow-shutdown TUI, so the 8s SIGTERM window elapses).
#
# Numbers to capture per case:
#   1. Old claude PID(s) BEFORE rename (pgrep -af claude, filtered by --alias)
#   2. Rename command exit code + stderr
#   3. Old claude PID(s) AFTER rename settles (kill-0 alive check)
#   4. New claude PID(s) BEFORE / AFTER rename
#   5. /api/status ghost check: is old alias still in the sessions list?

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9239
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-180-hub.db
WORK=/tmp/qa-180-work
ADMIN_USER="qa180admin"
ADMIN_PW="qa180_TestPass_1234!"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
raw()  { printf "  · %s\n" "$*"; }

# #526 — emit the PASS=N FAIL=N trailer on EVERY exit path.
# The CI gate parses `PASS=X FAIL=Y` from stdout; an early `exit 1`
# (missing binary / bailout / preflight fail) that skips this line
# makes the gate report "no trailer → treat as regression", which
# fails-closed but masks the real cause (see #526 log analysis).
# A trap catches early exits so the gate always gets a truthy verdict.
emit_trailer() {
  printf "\n────────────────────────────────────────────\n"
  printf "issue #180 rename ghost e2e — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
  printf "  (FAIL count = ghost/reproductions; higher = worse)\n"
  printf "────────────────────────────────────────────\n"
}
trap emit_trailer EXIT

# #526 — preflight: each dependency asserts itself and reports its own
# failure reason (not "the harness didn't produce a trailer"). Docker /
# image / disk are the workflow's job before invoking this script;
# these are the in-container prereqs the harness itself relies on.
preflight() {
  note "preflight — assert each dependency separately"
  local missing=0
  local disk_avail
  disk_avail=$(df -Pk /tmp 2>/dev/null | awk 'NR==2{print $4}')
  # 200 MiB floor — mock hub db + logs + fixtures easily fit; anything
  # less risks weird failure modes (sqlite write fails silently).
  if [ -z "${disk_avail:-}" ] || [ "$disk_avail" -lt 204800 ]; then
    bad "preflight: /tmp free space too low (need ≥ 200 MiB, got ${disk_avail:-unknown} KiB)"
    missing=$((missing+1))
  else
    ok "preflight: /tmp free space ok (${disk_avail} KiB)"
  fi
  # `script` (util-linux) — the CASE A PTY wrapper needs it.
  if ! command -v script >/dev/null 2>&1; then
    bad "preflight: 'script' (util-linux) missing — CASE A PTY wrapper cannot run"
    missing=$((missing+1))
  else
    ok "preflight: 'script' present ($(command -v script))"
  fi
  # tmux — CASE B pattern uses tmux new-session -d.
  if ! command -v tmux >/dev/null 2>&1; then
    bad "preflight: 'tmux' missing — CASE B (tmux-detached start) cannot run"
    missing=$((missing+1))
  else
    ok "preflight: 'tmux' present"
  fi
  # anet — the CLI under test.
  if ! command -v anet >/dev/null 2>&1; then
    bad "preflight: 'anet' missing — the CLI under test is not installed"
    missing=$((missing+1))
  else
    ok "preflight: 'anet' present ($(anet --version 2>/dev/null | head -1 || echo 'no version'))"
  fi
  # bun — server + node runtime.
  if ! command -v bun >/dev/null 2>&1; then
    bad "preflight: 'bun' missing — hub cannot start"
    missing=$((missing+1))
  else
    ok "preflight: 'bun' present"
  fi
  # mock claude binary — CI installs to /usr/local/bin/claude, dev
  # runs may symlink elsewhere. Fail-clear rather than let downstream
  # ps grep silently return empty.
  if ! command -v claude >/dev/null 2>&1; then
    bad "preflight: 'claude' missing — mock claude binary not on PATH"
    missing=$((missing+1))
  else
    ok "preflight: 'claude' present ($(command -v claude))"
  fi
  # Basic auxiliaries. Each on its own line so a red preflight names
  # the exact one that is missing.
  for tool in curl jq python3 sqlite3 pgrep ps kill; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      bad "preflight: '$tool' missing"
      missing=$((missing+1))
    fi
  done
  [ "$missing" -eq 0 ] && ok "preflight: all auxiliaries present (curl, jq, python3, sqlite3, pgrep, ps, kill)"
  if [ "$missing" -gt 0 ]; then
    printf "\n::error::preflight failed with %d missing prerequisites — refusing to run the harness (see individual ✗ lines above).\n" "$missing"
    exit 1
  fi
}
preflight

# alias_pgrep — list PIDs of claude processes matching --alias/-n <name>
alias_pgrep() {
  # Matches how findNodeProcessesByAlias parses argv (require binary name +
  # -n/--alias flag). Just checking `pgrep claude` isn't enough — the mock
  # heartbeat curl child + shell wrappers would false-positive.
  ps -eww -o pid=,args= 2>/dev/null | while read -r pid args; do
    for tok in $args; do
      base="${tok##*/}"
      if [[ "$base" == "claude" ]]; then
        # scan for -n <alias> in the same argv
        prev=""
        for a in $args; do
          if [[ "$prev" == "-n" || "$prev" == "--alias" ]] && [[ "$a" == "$1" ]]; then
            echo "$pid"
            break 2
          fi
          prev="$a"
        done
      fi
    done
  done | sort -u
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

ghost_in_status() {
  local alias="$1"
  curl -sS "$HUB_BASE/api/status" -H "Authorization: Bearer $UTOK" \
    | jq -e --arg a "$alias" '.sessions[] | select(.alias == $a)' >/dev/null 2>&1
}

# ── 0. boot hub + register admin + create utok/network ────────────
note "0. boot hub + admin"
safe_rm_rf "$WORK" 2>/dev/null || true
rm -f "$HUB_DB" "${HUB_DB}-shm" "${HUB_DB}-wal" 2>/dev/null
mkdir -p "$WORK"
cd /app/server
PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" bun run src/index.ts >/tmp/hub-180.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null && ok "hub /health 200 :$HUB_PORT" || { bad "hub did not start"; tail -30 /tmp/hub-180.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"a180@test.local\"}")
UTOK=$(echo "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r .networks[0].network_id)

# anet global config — required for anet node CLI to find hub + token
mkdir -p "$HOME/.anet"
cat > "$HOME/.anet/config.json" <<EOF
{"hub":"$HUB_BASE","token":"$UTOK","network_id":"$NET_ID"}
EOF
ok "anet global config written (hub + utok + net_id)"

# helper — create a node with claude-code-cli runtime + return its dir/alias
create_node() {
  local alias="$1"
  local rid ntok
  cd "$WORK"
  # Mint an ntok for the node (matches wizard flow)
  ntok=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" \
    -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$alias\"}" | jq -r .token)
  local nodeDir="$WORK/.anet/nodes/$alias"
  mkdir -p "$nodeDir"
  local nodeId="node_${alias}_$(date +%s%N | sha256sum | head -c 12)"
  cat > "$nodeDir/config.json" <<EOF
{"node_id":"$nodeId","node_name":"$alias","alias":"$alias","runtime":"claude-code-cli","model":"claude-sonnet-4-6","hub":"$HUB_BASE","token":"$ntok","session":"00000000-0000-0000-0000-000000000000"}
EOF
  raw "created node $alias @ $nodeDir (ntok minted, config written)"
}

# ══════════════════════════════════════════════════════════════════
# CASE A — foreground start (no tmux). Rename from separate anet call.
# ══════════════════════════════════════════════════════════════════
note "A. foreground start — anet node start (no tmux)"
CHILD_A="rename-target-a"
create_node "$CHILD_A"
cd "$WORK"
# Start in the background — mimics user opening a terminal + running the cmd.
# `anet node start` for claude-code-cli runtime enters launchAgent → spawns
# claude → awaits its exit. We background it so the shell continues.
#
# #526 — wrap with `script -q -c ... /dev/null` so `process.stdin.isTTY`
# is true for the child. Claude CLI 2.1.220+ auto-switches to `--print`
# mode without a TTY and refuses to start its interactive session, so
# anet's #494 preflight fail-closes with a clear "requires TTY" error
# and the harness never reaches the trailer. `script` allocates a real
# PTY WITHOUT introducing tmux — CASE A's "foreground no tmux" language
# above is load-bearing (进程树 shape differs, ghost-production
# conditions per case are distinct even though the CLEANUP path
# (`sweepMcpOrphansForAlias`) is common). Do NOT switch to
# `--accept-dev-channels`: that spawns a DETACHED tmux session (see
# `agent-network/bin/cli.ts` L4476/L4499), collapsing CASE A into a
# duplicate of CASE B while the label still claims "no tmux" —
# 通信龙 2026-07-30 hard裁定.
COMMHUB_URL="$HUB_BASE" nohup script -q -c "anet node start '$CHILD_A'" /dev/null >/tmp/anet-start-A.log 2>&1 &
ANET_START_A_PID=$!
raw "anet node start $CHILD_A → wrapper PID $ANET_START_A_PID (backgrounded via script PTY, no tmux)"

# Wait for claude to appear in ps (mock claude prints readiness on stderr).
for i in $(seq 1 30); do
  sleep 1
  if alias_pgrep "$CHILD_A" | grep -q .; then break; fi
done
CLAUDE_A_PIDS_BEFORE=$(alias_pgrep "$CHILD_A" | tr '\n' ',' | sed 's/,$//')
if [[ -n "$CLAUDE_A_PIDS_BEFORE" ]]; then
  ok "A.1 claude spawned under alias=$CHILD_A: pids=[$CLAUDE_A_PIDS_BEFORE]"
else
  bad "A.1 claude never appeared for $CHILD_A after 30s"
  tail -30 /tmp/anet-start-A.log
  # #526 — do NOT exit early. The trailer trap will fire regardless,
  # but the CI gate needs to distinguish "detected ghost" (FAIL>0 from
  # real repro) from "harness bailed" (FAIL≥1 from A.1 bad). Both
  # correctly show as failed, but the log tells operators whether the
  # harness reached its detection code or fell over before it. Skipping
  # the rest of CASE A + CASE B here means we still exit non-zero (FAIL>0)
  # but with a trailer — which is the point of #526.
  #
  # We still short-circuit the rest of CASE A + CASE B because they
  # depend on the CASE A node existing, but we do it via the trap
  # rather than a naked `exit 1` that skipped the trailer.
  exit 1
fi

# Wait for the mock to heart-beat once, so /api/status has a session row.
sleep 5
if ghost_in_status "$CHILD_A"; then
  ok "A.2 /api/status shows alias=$CHILD_A (mock heart-beat working)"
else
  raw "A.2 /api/status doesn't show $CHILD_A yet (mock heartbeat may still be ramping)"
fi

# ── the actual repro attempt ──
NEW_A="renamed-a"
raw "A.3 firing: anet node rename $CHILD_A $NEW_A --force"
RENAME_START=$(date +%s)
anet node rename "$CHILD_A" "$NEW_A" --force >/tmp/anet-rename-A.log 2>&1 || true
RENAME_END=$(date +%s)
RENAME_EXIT=$?
raw "A.3 rename exit code=$RENAME_EXIT wall=$((RENAME_END - RENAME_START))s"
tail -8 /tmp/anet-rename-A.log | sed 's/^/    · /'

# Give the system a moment to settle
sleep 3

# ── ghost detection ──
CLAUDE_A_PIDS_AFTER=$(alias_pgrep "$CHILD_A" | tr '\n' ',' | sed 's/,$//')
if [[ -z "$CLAUDE_A_PIDS_AFTER" ]]; then
  ok "A.4 pgrep alias=$CHILD_A AFTER rename → NONE (no ghost in this case)"
else
  bad "A.4 GHOST DETECTED: pgrep alias=$CHILD_A AFTER rename → pids=[$CLAUDE_A_PIDS_AFTER]"
  for pid in $(echo "$CLAUDE_A_PIDS_AFTER" | tr ',' ' '); do
    if pid_alive "$pid"; then
      raw "  · pid=$pid kill-0 OK (alive)"
    fi
  done
fi
CLAUDE_NEW_A_PIDS=$(alias_pgrep "$NEW_A" | tr '\n' ',' | sed 's/,$//')
[[ -n "$CLAUDE_NEW_A_PIDS" ]] \
  && ok "A.5 new alias=$NEW_A has claude pids=[$CLAUDE_NEW_A_PIDS]" \
  || raw "A.5 new alias=$NEW_A has no claude yet (may still be starting)"

# ── /api/status ghost check ──
# The MCP subprocess (mock-mcp) heart-beats every 2s. Give it a
# generous window to post AT LEAST ONE beat after rename settles,
# so a surviving subprocess is guaranteed to reflect in /api/status.
sleep 5
if ghost_in_status "$CHILD_A"; then
  bad "A.6 /api/status STILL shows $CHILD_A alias (ghost heart-beating)"
else
  ok "A.6 /api/status no longer shows $CHILD_A (clean)"
fi
# Direct pgrep for the MCP subprocess (which findNodeProcessesByAlias does NOT match)
# Specific: ONLY match ghost heart-beats carrying the OLD alias (fresh new-alias
# MCP subprocesses are legitimate + should be preserved). This is the exact
# ghost class that #180 fix (sweepMcpOrphansForAlias) is supposed to catch.
MCP_A_OLD_GHOSTS=$(pgrep -af "ALIAS='$CHILD_A'" 2>/dev/null | wc -l)
if [[ "$MCP_A_OLD_GHOSTS" -gt 0 ]]; then
  bad "A.6b GHOST DETECTED: $MCP_A_OLD_GHOSTS MCP subprocess(es) still heart-beating with OLD alias=$CHILD_A"
  pgrep -af "ALIAS='$CHILD_A'" 2>/dev/null | sed 's/^/    · /' || true
else
  ok "A.6b no MCP subprocess heart-beating OLD alias=$CHILD_A (sweepMcpOrphansForAlias caught them)"
fi
# Diagnostic: also show total mock-mcp count (helps distinguish ghost from
# legit new-alias MCP + inspection process itself)
raw "A.6c diagnostic total pgrep mock-mcp count = $(pgrep -af mock-mcp 2>/dev/null | wc -l)"
if ghost_in_status "$NEW_A"; then
  ok "A.7 /api/status shows new alias $NEW_A (rename completed)"
else
  raw "A.7 /api/status doesn't yet show $NEW_A (new node still starting)"
fi

# Cleanup for CASE A — kill everything anet-related to give CASE B a clean slate.
pkill -f "anet node start" 2>/dev/null || true
pkill -f "^/usr/local/bin/claude" 2>/dev/null || true
pkill -f "^claude " 2>/dev/null || true
sleep 2
kill -9 "$ANET_START_A_PID" 2>/dev/null || true
kill -9 $(alias_pgrep "$CHILD_A" | tr '\n' ' ') 2>/dev/null || true
kill -9 $(alias_pgrep "$NEW_A" | tr '\n' ' ') 2>/dev/null || true
sleep 1

# ══════════════════════════════════════════════════════════════════
# CASE B — tmux-detached start (mimics `anet project up`)
# ══════════════════════════════════════════════════════════════════
note "B. tmux-detached start — startNodeTmuxSession pattern"
CHILD_B="rename-target-b"
create_node "$CHILD_B"

# Mirror the exact tmux invocation used by agent-network/bin/cli.ts:41.
cd "$WORK"
tmux new-session -d -s "$CHILD_B" -e COMMHUB_URL="$HUB_BASE" "anet node start $CHILD_B" 2>&1 | sed 's/^/    · /'
raw "B.1 tmux new-session -d -s $CHILD_B 'anet node start $CHILD_B' fired"

# Wait for claude to appear
for i in $(seq 1 30); do
  sleep 1
  if alias_pgrep "$CHILD_B" | grep -q .; then break; fi
done
CLAUDE_B_PIDS_BEFORE=$(alias_pgrep "$CHILD_B" | tr '\n' ',' | sed 's/,$//')
if [[ -n "$CLAUDE_B_PIDS_BEFORE" ]]; then
  ok "B.1 claude spawned under alias=$CHILD_B: pids=[$CLAUDE_B_PIDS_BEFORE]"
  # Dump process-tree for diagnostic — see if there's a supervisor above claude
  raw "  process tree:"
  for pid in $(echo "$CLAUDE_B_PIDS_BEFORE" | tr ',' ' '); do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    pppid=$(ps -o ppid= -p "$ppid" 2>/dev/null | tr -d ' ')
    raw "    claude pid=$pid ← parent pid=$ppid ($(ps -o comm= -p "$ppid" 2>/dev/null)) ← grandparent pid=$pppid ($(ps -o comm= -p "$pppid" 2>/dev/null))"
  done
else
  bad "B.1 claude never appeared for $CHILD_B after 30s"
  tmux capture-pane -t "$CHILD_B" -p 2>/dev/null | sed 's/^/    · /'
  raw "SKIP rest of B due to no claude"
  # #526 — trailer is now emitted via the EXIT trap, no need to print
  # it manually here (avoids double-emission when the trap fires on
  # exit 1). Trap catches EVERY exit path.
  exit 1
fi

sleep 5
if ghost_in_status "$CHILD_B"; then
  ok "B.2 /api/status shows alias=$CHILD_B (mock heart-beat working)"
fi

# ── the actual repro attempt ──
NEW_B="renamed-b"
raw "B.3 firing: anet node rename $CHILD_B $NEW_B --force"
RENAME_START=$(date +%s)
anet node rename "$CHILD_B" "$NEW_B" --force >/tmp/anet-rename-B.log 2>&1 || true
RENAME_END=$(date +%s)
RENAME_EXIT=$?
raw "B.3 rename exit code=$RENAME_EXIT wall=$((RENAME_END - RENAME_START))s"
tail -12 /tmp/anet-rename-B.log | sed 's/^/    · /'

sleep 3

# ── ghost detection ──
CLAUDE_B_PIDS_AFTER=$(alias_pgrep "$CHILD_B" | tr '\n' ',' | sed 's/,$//')
if [[ -z "$CLAUDE_B_PIDS_AFTER" ]]; then
  ok "B.4 pgrep alias=$CHILD_B AFTER rename → NONE (no ghost in this case either)"
else
  bad "B.4 GHOST DETECTED: pgrep alias=$CHILD_B AFTER rename → pids=[$CLAUDE_B_PIDS_AFTER]"
  for pid in $(echo "$CLAUDE_B_PIDS_AFTER" | tr ',' ' '); do
    if pid_alive "$pid"; then
      # Show whether it's the same PID as before (survived) or a new one (respawn)
      if echo ",$CLAUDE_B_PIDS_BEFORE," | grep -q ",$pid,"; then
        raw "  · pid=$pid: SAME as before (SIGTERM/SIGKILL didn't reach it)"
      else
        raw "  · pid=$pid: NEW PID (something respawned claude — H3 candidate)"
        # Dump parent for the new one to see who respawned it
        newppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        raw "    ↑ new claude parent pid=$newppid comm=$(ps -o comm= -p "$newppid" 2>/dev/null)"
      fi
    fi
  done
fi
CLAUDE_NEW_B_PIDS=$(alias_pgrep "$NEW_B" | tr '\n' ',' | sed 's/,$//')
[[ -n "$CLAUDE_NEW_B_PIDS" ]] \
  && ok "B.5 new alias=$NEW_B has claude pids=[$CLAUDE_NEW_B_PIDS]" \
  || raw "B.5 new alias=$NEW_B has no claude yet"

sleep 5
if ghost_in_status "$CHILD_B"; then
  bad "B.6 /api/status STILL shows $CHILD_B alias (ghost heart-beating)"
else
  ok "B.6 /api/status no longer shows $CHILD_B (clean)"
fi
MCP_B_OLD_GHOSTS=$(pgrep -af "ALIAS='$CHILD_B'" 2>/dev/null | wc -l)
if [[ "$MCP_B_OLD_GHOSTS" -gt 0 ]]; then
  bad "B.6b GHOST DETECTED: $MCP_B_OLD_GHOSTS MCP subprocess(es) still heart-beating with OLD alias=$CHILD_B"
  pgrep -af "ALIAS='$CHILD_B'" 2>/dev/null | sed 's/^/    · /' || true
else
  ok "B.6b no MCP subprocess heart-beating OLD alias=$CHILD_B (sweepMcpOrphansForAlias caught them)"
fi
raw "B.6c diagnostic total pgrep mock-mcp count = $(pgrep -af mock-mcp 2>/dev/null | wc -l)"
if ghost_in_status "$NEW_B"; then
  ok "B.7 /api/status shows new alias $NEW_B (rename completed)"
else
  raw "B.7 /api/status doesn't yet show $NEW_B"
fi

# Diagnostic: dump the tmux pane content to see if the shell inside is doing
# something weird (respawn, exit-with-restart, etc.)
if tmux has-session -t "$CHILD_B" 2>/dev/null; then
  raw "B.8 tmux session '$CHILD_B' STILL RUNNING — pane content:"
  tmux capture-pane -t "$CHILD_B" -p 2>/dev/null | tail -15 | sed 's/^/    · /'
else
  raw "B.8 tmux session '$CHILD_B' gone"
fi
if tmux has-session -t "$NEW_B" 2>/dev/null; then
  raw "B.8 tmux session '$NEW_B' running (auto-restart under new alias)"
fi

# ── cleanup ──────────────────────────────────────────────────────
kill "$HUB_PID" 2>/dev/null || true
tmux kill-server 2>/dev/null || true
pkill -f "^/usr/local/bin/claude" 2>/dev/null || true
sleep 1

# #526 — trailer is emitted by the `trap emit_trailer EXIT` at the top;
# don't print it here or it would double-emit on normal completion.
# Final rc = FAIL count. The gate reads it as `runner exit code` (must
# be 0) alongside the trailer.
[[ "$FAIL" -eq 0 ]]
