#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: normalize-codex-copresence-node.sh --mode plan|apply --alias NAME
  --config ABS --inventory-dir ABS --goals-root ABS --workdir ABS
  --dist-cli ABS --expected-dist-sha256 HEX --codex-bin ABS --expected-version VERSION --expected-model MODEL
  --new-appsrv-session NAME --new-bridge-session NAME --new-tui-session NAME --expected-tui-command NAME
  --expected-pid PID:STARTTIME (repeat) --stop-session NAME (repeat)
EOF
}

MODE=plan ALIAS= CONFIG= INVENTORY_DIR= GOALS_ROOT= WORKDIR= DIST_CLI=
CODEX_BIN= EXPECTED_VERSION= EXPECTED_MODEL= EXPECTED_DIST_SHA256= NEW_APPSRV_SESSION= NEW_BRIDGE_SESSION= NEW_TUI_SESSION= EXPECTED_TUI_COMMAND= EXPECTED_PIDS=() STOP_SESSIONS=()
while (($#)); do
  case "$1" in
    --mode) MODE=${2:?}; shift 2;; --alias) ALIAS=${2:?}; shift 2;;
    --config) CONFIG=${2:?}; shift 2;; --inventory-dir) INVENTORY_DIR=${2:?}; shift 2;;
    --goals-root) GOALS_ROOT=${2:?}; shift 2;; --workdir) WORKDIR=${2:?}; shift 2;;
    --dist-cli) DIST_CLI=${2:?}; shift 2;; --codex-bin) CODEX_BIN=${2:?}; shift 2;;
    --expected-dist-sha256) EXPECTED_DIST_SHA256=${2:?}; shift 2;;
    --expected-version) EXPECTED_VERSION=${2:?}; shift 2;;
    --expected-model) EXPECTED_MODEL=${2:?}; shift 2;;
    --new-appsrv-session) NEW_APPSRV_SESSION=${2:?}; shift 2;;
    --new-bridge-session) NEW_BRIDGE_SESSION=${2:?}; shift 2;;
    --new-tui-session) NEW_TUI_SESSION=${2:?}; shift 2;;
    --expected-tui-command) EXPECTED_TUI_COMMAND=${2:?}; shift 2;;
    --expected-pid) EXPECTED_PIDS+=("${2:?}"); shift 2;;
    --stop-session) STOP_SESSIONS+=("${2:?}"); shift 2;;
    -h|--help) usage; exit 0;; *) echo "REFUSE: unknown option $1" >&2; usage >&2; exit 2;;
  esac
done
[[ "$MODE" == plan || "$MODE" == apply ]] || { echo "REFUSE: mode must be plan or apply" >&2; exit 2; }
[[ -n "$ALIAS" && -n "$CONFIG" && -n "$INVENTORY_DIR" && -n "$GOALS_ROOT" && -n "$WORKDIR" && -n "$DIST_CLI" && -n "$EXPECTED_DIST_SHA256" && -n "$CODEX_BIN" && -n "$EXPECTED_VERSION" && -n "$EXPECTED_MODEL" && -n "$NEW_APPSRV_SESSION" && -n "$NEW_BRIDGE_SESSION" && -n "$NEW_TUI_SESSION" && -n "$EXPECTED_TUI_COMMAND" ]] || { echo "REFUSE: missing required option" >&2; exit 2; }
for value in "$ALIAS" "$NEW_APPSRV_SESSION" "$NEW_BRIDGE_SESSION" "$NEW_TUI_SESSION" "$EXPECTED_TUI_COMMAND"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\t'* && "$value" != *' '* && "$value" != */* && "$value" != *'|'* && "$value" != *'*'* && "$value" != *'?'* && "$value" != *'['* && "$value" != *']'* ]] || { echo "REFUSE: unsafe alias/session name" >&2; exit 2; }
done
for path in "$CONFIG" "$INVENTORY_DIR" "$GOALS_ROOT" "$WORKDIR" "$DIST_CLI" "$CODEX_BIN"; do
  [[ "$path" == /* && "$path" != *$'\n'* ]] || { echo "REFUSE: paths must be absolute and single-line" >&2; exit 2; }
done
[[ -d "$WORKDIR" && ! -L "$WORKDIR" ]] || { echo "REFUSE: workdir must be a real directory" >&2; exit 2; }
[[ -f "$DIST_CLI" && ! -L "$DIST_CLI" ]] || { echo "REFUSE: dist cli must be a real file" >&2; exit 2; }
[[ -x "$CODEX_BIN" && ! -L "$CODEX_BIN" ]] || { echo "REFUSE: codex binary must be executable and not a symlink" >&2; exit 2; }
[[ "$EXPECTED_DIST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "REFUSE: expected dist sha256 must be lowercase hex" >&2; exit 2; }
[[ "$EXPECTED_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "REFUSE: expected model has unsafe shape" >&2; exit 2; }
[[ "$(sha256sum "$DIST_CLI" | awk '{print $1}')" == "$EXPECTED_DIST_SHA256" ]] || { echo "REFUSE: dist cli sha256 mismatch" >&2; exit 2; }
WORK_UID=$(stat -c %u "$WORKDIR")
[[ "$WORK_UID" == "$(id -u)" ]] || { echo "REFUSE: workdir is not owned by euid" >&2; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_TOOL="$SCRIPT_DIR/codex-copresence-fleet-config.mjs"
THREAD_TOOL="$SCRIPT_DIR/codex-copresence-thread-owner.mjs"
PLAN=$(bun "$CONFIG_TOOL" --mode plan --config "$CONFIG" --inventory-dir "$INVENTORY_DIR" --goals-root "$GOALS_ROOT" --workdir "$WORKDIR" --model "$EXPECTED_MODEL")
NODE_ID=$(bun -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.node_id)' "$PLAN")
DESIRED_GOALS=$(bun -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.goalsPath)' "$PLAN")
PERMISSION_REPAIR_COUNT=$(bun -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.permissionRepairs?.length||0))' "$PLAN")
if [[ "$MODE" == apply && "$PERMISSION_REPAIR_COUNT" != 0 ]]; then
  echo "REFUSE: $PERMISSION_REPAIR_COUNT inventory permission repairs require a separately reviewed prepare-permissions step" >&2
  exit 2
fi
WS=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const u=c.codexAppServerUrl;if(!/^ws:\/\/127\.0\.0\.1:[0-9]+$/.test(u||""))process.exit(2);process.stdout.write(u)' "$CONFIG") || { echo "REFUSE: codexAppServerUrl must be loopback ws" >&2; exit 2; }
HUB=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const u=c.hub;if(!/^https?:\/\//.test(u||""))process.exit(2);process.stdout.write(u.replace(/\/$/,""))' "$CONFIG") || { echo "REFUSE: missing/invalid hub URL" >&2; exit 2; }
MODEL=$EXPECTED_MODEL
THREAD_ID=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c.codexThreadId;if(!/^[A-Za-z0-9_-]{8,128}$/.test(v||""))process.exit(2);process.stdout.write(v)' "$CONFIG") || { echo "REFUSE: codexThreadId is missing or unsafe" >&2; exit 2; }
SANDBOX_MODE=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.flags?.sandboxMode||"workspace-write")' "$CONFIG")
APPROVAL_POLICY=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.flags?.approvalPolicy||"on-request")' "$CONFIG")
[[ "$SANDBOX_MODE" =~ ^(read-only|workspace-write|danger-full-access)$ ]] || { echo "REFUSE: unsupported sandbox mode" >&2; exit 2; }
[[ "$APPROVAL_POLICY" =~ ^(untrusted|on-request|never)$ ]] || { echo "REFUSE: unsupported approval policy" >&2; exit 2; }

declare -A EXPECTED=()
for spec in "${EXPECTED_PIDS[@]}"; do
  [[ "$spec" =~ ^([0-9]+):([0-9]+)$ ]] || { echo "REFUSE: expected pid must be PID:STARTTIME" >&2; exit 2; }
  EXPECTED["${BASH_REMATCH[1]}"]=${BASH_REMATCH[2]}
done
starttime() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
fingerprint() { tr '\0' ' ' <"/proc/$1/cmdline" | sed -E 's/(ntok|atok|utok|ghp)_[A-Za-z0-9_-]+/[REDACTED]/g' | sha256sum | awk '{print $1}'; }
for pid in "${!EXPECTED[@]}"; do
  [[ -r "/proc/$pid/stat" ]] || { echo "REFUSE: expected pid $pid vanished" >&2; exit 2; }
  actual=$(starttime "$pid"); [[ "$actual" == "${EXPECTED[$pid]}" ]] || { echo "REFUSE: pid $pid starttime drift" >&2; exit 2; }
  echo "EXPECTED pid=$pid starttime=$actual exe=$(readlink "/proc/$pid/exe") cmd_sha256=$(fingerprint "$pid")"
done

mapfile -t MATCHED < <(for p in /proc/[0-9]*; do
  pid=${p##*/}; [[ -r "$p/cmdline" ]] || continue; cmd=$(tr '\0' ' ' <"$p/cmdline")
  [[ "$pid" == "$$" ]] && continue
  [[ "$cmd" == *"normalize-codex-copresence-node.sh"* || "$cmd" == *"codex-copresence-fleet-config.mjs"* ]] && continue
  if [[ "$cmd" == *"--config $CONFIG"* || "$cmd" == *"--alias $ALIAS"* || "$cmd" == *" node start $ALIAS "* || "$cmd" == *" resume $ALIAS "* || "$cmd" == *"resume --remote $WS"* || "$cmd" == *"app-server --listen $WS"* ]]; then echo "$pid"; fi
done)
for pid in "${MATCHED[@]}"; do
  [[ -e "/proc/$pid/cmdline" ]] || continue
  [[ -n "${EXPECTED[$pid]:-}" ]] || { echo "REFUSE: unaccounted matching process pid=$pid cmd_sha256=$(fingerprint "$pid")" >&2; exit 2; }
done

declare -A SESSION_IDS=()
while IFS='|' read -r sid name pane; do [[ -n "$sid" ]] && SESSION_IDS["$name"]="$sid:$pane"; done < <(tmux list-panes -a -F '#{session_id}|#{session_name}|#{pane_pid}' 2>/dev/null || true)
for name in "${STOP_SESSIONS[@]}"; do
  entry=${SESSION_IDS[$name]:-}; [[ -n "$entry" ]] || { echo "REFUSE: exact tmux session not found: $name" >&2; exit 2; }
  pane=${entry#*:}; [[ -n "${EXPECTED[$pane]:-}" ]] || { echo "REFUSE: tmux $name pane pid $pane is not expected" >&2; exit 2; }
done
for name in "$NEW_APPSRV_SESSION" "$NEW_BRIDGE_SESSION" "$NEW_TUI_SESSION"; do
  if [[ -n "${SESSION_IDS[$name]:-}" ]]; then
    found=0; for stopped in "${STOP_SESSIONS[@]}"; do [[ "$stopped" == "$name" ]] && found=1; done
    (( found == 1 )) || { echo "REFUSE: destination tmux session already exists but is not an exact stop target: $name" >&2; exit 2; }
  fi
done
echo "PLAN alias=$ALIAS node_id=$NODE_ID model=$MODEL ws=$WS expected=${#EXPECTED[@]} stop_sessions=${#STOP_SESSIONS[@]} components=appsrv,bridge,tui"
echo "$PLAN"
[[ "$MODE" == apply ]] || { echo "RESULT: PLAN ONLY — no mutation"; exit 0; }
(( ${#EXPECTED[@]} > 0 && ${#STOP_SESSIONS[@]} > 0 )) || { echo "REFUSE: apply requires expected pids and exact sessions" >&2; exit 2; }

BACKUP_DIR=$(mktemp -d "/tmp/anet-normalize-${NODE_ID}.XXXXXX"); chmod 0700 "$BACKUP_DIR"
cp -p "$CONFIG" "$BACKUP_DIR/config.json"; printf '%s\n' "${STOP_SESSIONS[@]}" >"$BACKUP_DIR/stopped-sessions.txt"; chmod 0600 "$BACKUP_DIR"/*
GOALS_ROOT_EXISTED=0; GOALS_NODE_EXISTED=0
CREATED_APPSRV=0; CREATED_BRIDGE=0; CREATED_TUI=0
[[ -d "$GOALS_ROOT" ]] && GOALS_ROOT_EXISTED=1
[[ -d "$(dirname "$DESIRED_GOALS")" ]] && GOALS_NODE_EXISTED=1
kill_current_exact() {
  local wanted=$1 sid name pane
  while IFS='|' read -r sid name pane; do
    if [[ "$name" == "$wanted" ]]; then tmux kill-session -t "$sid" 2>/dev/null || true; return; fi
  done < <(tmux list-panes -a -F '#{session_id}|#{session_name}|#{pane_pid}' 2>/dev/null || true)
  return 0
}
rollback() {
  local rc=$?; trap - ERR INT TERM
  (( CREATED_APPSRV == 0 )) || kill_current_exact "$NEW_APPSRV_SESSION" || true
  (( CREATED_BRIDGE == 0 )) || kill_current_exact "$NEW_BRIDGE_SESSION" || true
  (( CREATED_TUI == 0 )) || kill_current_exact "$NEW_TUI_SESSION" || true
  cp -p "$BACKUP_DIR/config.json" "$CONFIG"; chmod 0600 "$CONFIG"
  if (( GOALS_NODE_EXISTED == 0 )); then rmdir "$(dirname "$DESIRED_GOALS")" 2>/dev/null || true; fi
  if (( GOALS_ROOT_EXISTED == 0 )); then rmdir "$GOALS_ROOT" 2>/dev/null || true; fi
  echo "ROLLBACK: config restored; runtime remains stopped fail-closed" >&2
  echo "ROLLBACK_COORDINATES=$BACKUP_DIR" >&2; exit "$rc"
}
trap rollback ERR INT TERM
for name in "${STOP_SESSIONS[@]}"; do sid=${SESSION_IDS[$name]%%:*}; tmux kill-session -t "$sid"; done
for _ in $(seq 1 40); do alive=0; for pid in "${!EXPECTED[@]}"; do [[ -e "/proc/$pid" ]] && alive=1; done; (( alive == 0 )) && break; sleep 0.25; done
for pid in "${!EXPECTED[@]}"; do [[ ! -e "/proc/$pid" ]] || { echo "REFUSE: pid $pid survived exact tmux stop" >&2; false; }; done
bun "$CONFIG_TOOL" --mode apply --config "$CONFIG" --inventory-dir "$INVENTORY_DIR" --goals-root "$GOALS_ROOT" --workdir "$WORKDIR" --model "$EXPECTED_MODEL"

RUNTIME_DIR=$(mktemp -d "/tmp/anet-normalize-run-${NODE_ID}.XXXXXX"); chmod 0700 "$RUNTIME_DIR"
cat >"$RUNTIME_DIR/appsrv.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
TOKEN=$(bun -e 'const c=JSON.parse(require("fs").readFileSync(process.env.ANET_NODE_CONFIG,"utf8"));if(!c.token)process.exit(2);process.stdout.write(c.token)')
export ANET_CODEX_COMMHUB_TOKEN="$TOKEN"; unset TOKEN
exec "$ANET_CODEX_BIN" app-server -c approval_policy=never -c sandbox_mode=danger-full-access -c "mcp_servers.commhub.url=\"$ANET_HUB/mcp\"" -c 'mcp_servers.commhub.bearer_token_env_var="ANET_CODEX_COMMHUB_TOKEN"' --listen "$ANET_WS"
EOF
cat >"$RUNTIME_DIR/bridge.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
unset ANET_CODEX_COMMHUB_TOKEN
exec bun "$ANET_DIST_CLI" --config "$ANET_NODE_CONFIG" --alias "$ANET_ALIAS"
EOF
cat >"$RUNTIME_DIR/tui.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=(resume --remote "$ANET_WS" "$ANET_THREAD_ID" -m "$ANET_MODEL" -C "$ANET_WORKDIR")
if [[ "$ANET_SANDBOX_MODE" == danger-full-access && "$ANET_APPROVAL_POLICY" == never ]]; then
  args+=(--dangerously-bypass-approvals-and-sandbox)
else
  args+=(-s "$ANET_SANDBOX_MODE" -a "$ANET_APPROVAL_POLICY")
fi
exec "$ANET_CODEX_BIN" "${args[@]}"
EOF
chmod 0700 "$RUNTIME_DIR"/*.sh
tmux new-session -d -s "$NEW_APPSRV_SESSION" -c "$WORKDIR" -e "ANET_NODE_CONFIG=$CONFIG" -e "ANET_CODEX_BIN=$CODEX_BIN" -e "ANET_HUB=$HUB" -e "ANET_WS=$WS" "$RUNTIME_DIR/appsrv.sh"
CREATED_APPSRV=1
PORT=${WS##*:}; for _ in $(seq 1 80); do ss -ltnH "sport = :$PORT" | grep -q . && break; sleep 0.25; done
ss -ltnH "sport = :$PORT" | grep -q . || { echo "app-server did not listen" >&2; false; }
APPSRV_PID=$(ss -ltnpH "sport = :$PORT" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1); [[ -n "$APPSRV_PID" ]] || { echo "cannot resolve app-server pid" >&2; false; }
ACTUAL_VERSION=$("/proc/$APPSRV_PID/exe" --version | awk '{print $NF}'); [[ "$ACTUAL_VERSION" == "$EXPECTED_VERSION" ]] || { echo "version mismatch: $ACTUAL_VERSION" >&2; false; }
bun "$THREAD_TOOL" --ws "$WS" --thread-id "$THREAD_ID" --node-id "$NODE_ID" --alias "$ALIAS" --cwd "$WORKDIR" --mode claim
tmux new-session -d -s "$NEW_BRIDGE_SESSION" -c "$WORKDIR" -e "ANET_NODE_CONFIG=$CONFIG" -e "ANET_DIST_CLI=$DIST_CLI" -e "ANET_ALIAS=$ALIAS" "$RUNTIME_DIR/bridge.sh"
CREATED_BRIDGE=1
tmux new-session -d -s "$NEW_TUI_SESSION" -c "$WORKDIR" -e "ANET_CODEX_BIN=$CODEX_BIN" -e "ANET_WS=$WS" -e "ANET_THREAD_ID=$THREAD_ID" -e "ANET_MODEL=$MODEL" -e "ANET_WORKDIR=$WORKDIR" -e "ANET_SANDBOX_MODE=$SANDBOX_MODE" -e "ANET_APPROVAL_POLICY=$APPROVAL_POLICY" "$RUNTIME_DIR/tui.sh"
CREATED_TUI=1
sleep 2
echo "ACTIVE_SESSIONS:"; tmux list-sessions -F '#{session_name}'
tmux list-sessions -F '#{session_name}' | grep -Fxq "$NEW_APPSRV_SESSION"
tmux list-sessions -F '#{session_name}' | grep -Fxq "$NEW_BRIDGE_SESSION"
tmux list-sessions -F '#{session_name}' | grep -Fxq "$NEW_TUI_SESSION"
TUI_META=$(tmux list-panes -t "$NEW_TUI_SESSION" -F '#{pane_pid}|#{pane_dead}|#{pane_current_command}')
IFS='|' read -r TUI_PID TUI_DEAD TUI_COMMAND <<<"$TUI_META"
[[ "$TUI_DEAD" == 0 && "$TUI_COMMAND" == "$EXPECTED_TUI_COMMAND" ]] || { echo "TUI failed liveness gate: dead=$TUI_DEAD command=$TUI_COMMAND" >&2; false; }
descendant_pids() {
  local root=$1 current child ppid seen
  local -a frontier
  frontier=("$root"); seen=" $root "
  printf '%s\n' "$root"
  while ((${#frontier[@]})); do
    current=${frontier[0]}; frontier=("${frontier[@]:1}")
    for status in /proc/[0-9]*/status; do
      [[ -r "$status" ]] || continue
      child=${status#/proc/}; child=${child%/status}
      [[ "$seen" != *" $child "* ]] || continue
      ppid=$(awk '$1=="PPid:" {print $2}' "$status" 2>/dev/null || true)
      if [[ "$ppid" == "$current" ]]; then
        printf '%s\n' "$child"; seen+="$child "; frontier+=("$child")
      fi
    done
  done
}
mapfile -t TUI_SOCKET_CANDIDATES < <(descendant_pids "$TUI_PID")
TUI_SOCKET_PID=
SOCKETS=$(ss -tnpH state established "dport = :$PORT")
for candidate in "${TUI_SOCKET_CANDIDATES[@]}"; do
  if grep -Fq "pid=$candidate," <<<"$SOCKETS"; then TUI_SOCKET_PID=$candidate; break; fi
done
[[ -n "$TUI_SOCKET_PID" ]] || { echo "TUI process tree has no socket to the new app-server" >&2; false; }
echo "TUI_SOCKET pane_pid=$TUI_PID holder_pid=$TUI_SOCKET_PID descendants=${#TUI_SOCKET_CANDIDATES[@]}"
trap - ERR INT TERM
echo "RESULT: NORMALIZED alias=$ALIAS appsrv_version=$ACTUAL_VERSION"
echo "ROLLBACK_COORDINATES=$BACKUP_DIR"
echo "UAT_REQUIRED: socket single-owner + /goal + /loop notice + /aloop create/cancel"
