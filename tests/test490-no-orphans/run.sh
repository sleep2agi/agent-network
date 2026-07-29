#!/usr/bin/env bash
set -euo pipefail

CLI_SOURCE="${CLI_SOURCE:-worktree}"
REPORT="${REPORT:-docs/tests/report-test490-no-orphans.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"

log() {
  echo "$*" | tee -a "$REPORT"
}

make_cli() {
  local dest="$1"
  if [[ "$CLI_SOURCE" == "head" ]]; then
    git config --global --add safe.directory /repo >/dev/null 2>&1 || true
    git show HEAD:agent-network/bin/cli.ts > "$dest"
  else
    cp agent-network/bin/cli.ts "$dest"
  fi
}

make_fixture() {
  local work="$1"
  local alias="$2"
  mkdir -p "$work/.anet/nodes/$alias" "$work/bin" "$work/state"
  cat > "$work/.anet/nodes/$alias/config.json" <<EOF
{"alias":"$alias","node_id":"$alias","hub":"http://127.0.0.1:9","token":"ntok_test","runtime":"claude-code-cli","channels":[],"flags":{}}
EOF
  cat > "$work/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
marker=${P490_MARKER:?}
echo $$ > state/parent.pid
bash -c 'trap "exit 0" TERM INT HUP; sleep "${P486_TREE_SLEEP:-120}"' normal-child-$marker &
echo $! > state/child.pid
setsid bash -c 'trap "exit 0" TERM INT HUP; sleep "${P486_TREE_SLEEP:-120}"' setsid-child-$marker &
echo $! > state/setsid.pid
if [[ "${P490_WAIT_FOR_STOP:-0}" == "1" ]]; then
  while true; do sleep 1; done
fi
sleep 1
exit ${P490_EXIT_CODE:-0}
EOF
  chmod +x "$work/bin/claude"
}

scan_marker() {
  local marker="$1"
  local pid="${2:-}"
  local pgid="${3:-}"
  local tmux_name="${4:-}"
  local found=0
  if [[ -n "$pid" ]]; then
    local pid_scan
    pid_scan="$(ps -p "$pid" -o pid,pgid,stat,args --no-headers || true)"
    [[ -n "$pid_scan" ]] && { echo "$pid_scan" | tee -a "$REPORT"; found=1; }
  fi
  if [[ -n "$pgid" ]]; then
    local pgid_scan
    pgid_scan="$(ps -eo pid,pgid,stat,args | awk -v pgid="$pgid" '$2 == pgid { print }')"
    [[ -n "$pgid_scan" ]] && { echo "$pgid_scan" | tee -a "$REPORT"; found=1; }
  fi
  local cmd_scan
  cmd_scan="$(ps -eo pid,pgid,args | grep "$marker" | grep -v grep || true)"
  [[ -n "$cmd_scan" ]] && { echo "$cmd_scan" | tee -a "$REPORT"; found=1; }
  if [[ -n "$tmux_name" ]] && tmux has-session -t "$tmux_name" 2>/dev/null; then
    log "tmux session still exists: $tmux_name"
    found=1
  fi
  [[ "$found" == "0" ]]
}

cleanup_marker() {
  local marker="$1"
  ps -eo pid,args | awk -v marker="$marker" 'index($0, marker) && !index($0, "awk -v marker") { print $1 }' |
    while read -r pid; do
      [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
    done
}

run_path() {
  local name="$1"
  local exit_code="$2"
  local use_tmux_stop="$3"
  local alias="p490-$name-$$"
  local marker="P490_${name}_$$"
  local work
  work="$(mktemp -d)"
  make_cli "$work/cli.ts"
  make_fixture "$work" "$alias"
  log "# path $name marker=$marker cli_source=$CLI_SOURCE"
  (
    cd "$work"
    if [[ "$use_tmux_stop" == "1" ]]; then
      PATH="$work/bin:$PATH" P490_MARKER="$marker" P490_WAIT_FOR_STOP=1 tmux new-session -d -s "$alias" "bun '$work/cli.ts' node start '$alias'" >/tmp/p490-$name-start.log 2>&1
      for _ in $(seq 1 30); do
        [[ -s state/setsid.pid ]] && break
        sleep 0.2
      done
      PATH="$work/bin:$PATH" bun "$work/cli.ts" node stop "$alias" >/tmp/p490-$name-stop.log 2>&1 || true
    else
      PATH="$work/bin:$PATH" P490_MARKER="$marker" P490_EXIT_CODE="$exit_code" bun "$work/cli.ts" node start "$alias" >/tmp/p490-$name.log 2>&1 || true
    fi
  )
  sleep 1
  local pid=""
  local pgid=""
  [[ -s "$work/state/setsid.pid" ]] && pid="$(cat "$work/state/setsid.pid")"
  [[ -n "$pid" ]] && pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  log "setsid_child_pid=$pid setsid_child_pgid=$pgid"
  if ! scan_marker "$marker" "$pid" "$pgid" "$alias"; then
    log "FAIL path $name: residual process/session found"
    cleanup_marker "$marker"
    return 1
  fi
  log "PASS path $name: zero residuals"
}

fail=0
run_path A 0 0 || fail=1
run_path B 7 0 || fail=1
run_path C 0 1 || fail=1

if [[ "$fail" == "1" ]]; then
  log "RESULT FAIL"
  exit 1
fi

log "RESULT PASS"
