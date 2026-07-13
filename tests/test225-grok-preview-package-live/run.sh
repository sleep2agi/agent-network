#!/usr/bin/env bash
set -euo pipefail
umask 077

# test225 runs in the *runtime* stage of its Dockerfile.  That image contains
# only the globally installed anet candidate, the unpublished agent-node
# tarball, the published preview Hub, and this black-box harness. It
# intentionally has no repository checkout and no source-path escape hatch.

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test225.txt}"
HOME=/tmp/test225-home
WORK=/tmp/test225-work
HUB_PORT=9200
HUB="http://127.0.0.1:${HUB_PORT}"
ALIAS=preview-grok-225
TEST_PASSWORD='Test225-Pass-123!'
FAKE_GROK=/test225/fake-grok.mjs
FAKE_OBSERVATIONS=/tmp/test225-fake-observations.jsonl
FAKE_READINESS_OBSERVATIONS=/tmp/test225-fake-readiness.jsonl
EXPECTED_GROK_ENV_KEYS=/tmp/test225-expected-grok-env-keys.json
EXPECTED_GROK_PTY_ENV_KEYS=/tmp/test225-expected-grok-pty-env-keys.json
EXPECTED_AGENT_NODE_ENV_KEYS=/tmp/test225-expected-agent-node-env-keys.json
EXPECTED_NPX_ENV_KEYS=/tmp/test225-expected-npx-env-keys.json
NPX_ENV_OBSERVATION=/tmp/test225-npx-env.json
FALLBACK_PID_SNAPSHOT=/tmp/test225-fallback-pids
LOCAL_REGISTRY_LOG=/tmp/test225-local-registry.raw.log
SERVER_LOG=/tmp/test225-server.raw.log
START_LOG=/tmp/test225-start.raw.log
RELOAD_LOG=/tmp/test225-reload.raw.log
RESUME_LOG=/tmp/test225-resume.raw.log
ATTACH_CAPTURE=/tmp/test225-attach.raw.txt
RELOAD_CAPTURE=/tmp/test225-reload-attach.raw.txt
RESUME_CAPTURE=/tmp/test225-resume-attach.raw.txt
REAL_START_LOG=/tmp/test225-real-start.raw.log
REAL_RESUME_LOG=/tmp/test225-real-resume.raw.log
REAL_CAPTURE=/tmp/test225-real-attach.raw.txt
REAL_RESUME_CAPTURE=/tmp/test225-real-resume-attach.raw.txt
REGISTER_LOG=/tmp/test225-register.raw.log
CREATE_LOG=/tmp/test225-create.raw.log
HEADLESS_CREATE_LOG=/tmp/test225-headless-create.raw.log
REAL_CREATE_LOG=/tmp/test225-real-create.raw.log

# The package gate must observe native shared-TUI rendering. It may not make a
# trust prompt or network turn pass by typing into tmux on the user's behalf.
if grep -Eq 'tmux[[:space:]]+(send[-]keys|paste[-]buffer|load[-]buffer)' "$0"; then
  printf 'FAIL: test225 contains a forbidden tmux input command\n' >&2
  exit 1
fi
GLOBAL_INSTALL_LOG=/tmp/test225-global-install.raw.log
export HOME
export PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export COMMHUB_DB=/tmp/test225-commhub.db
export HOST=127.0.0.1
export PORT="$HUB_PORT"

mkdir -p "$ARTIFACT_DIR" "$HOME/.grok" "$WORK"
chmod 700 "$HOME" "$HOME/.grok" "$WORK"
[ ! -e "$HOME/.grok/auth.json" ] \
  || { printf 'FAIL: deterministic test home unexpectedly contains auth state\n' >&2; exit 1; }
: >"$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }
fail_with_private_log() {
  local message=$1 path=$2
  local bytes=0 mode=missing
  if [ -e "$path" ]; then
    bytes=$(stat -c %s "$path" 2>/dev/null || printf 0)
    mode=$(stat -c %a "$path" 2>/dev/null || printf unknown)
  fi
  log "diagnostic: private raw log retained until cleanup (bytes=$bytes mode=$mode)"
  fail "$message"
}

wait_http() {
  local url=$1
  for _ in $(seq 1 150); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

wait_file() {
  local file=$1
  local attempts=${2:-200}
  for _ in $(seq 1 "$attempts"); do
    [ -e "$file" ] && return 0
    sleep 0.1
  done
  return 1
}

wait_gone() {
  local file=$1
  local attempts=${2:-200}
  for _ in $(seq 1 "$attempts"); do
    [ ! -e "$file" ] && return 0
    sleep 0.1
  done
  return 1
}

wait_pane() {
  local session=$1 pattern=$2 output=$3 attempts=${4:-300}
  for _ in $(seq 1 "$attempts"); do
    # -J joins soft-wrapped screen rows. Credential markers are deliberately
    # long; raw row boundaries must not create a false absence in the human
    # TUI proof.
    tmux capture-pane -p -J -t "$session":0.0 -S -400 >"$output" 2>/dev/null || true
    grep -Fq "$pattern" "$output" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

matching_process_count() {
  local needle=$1 proc cmd count=0
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    cmd=$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *"$needle"*) count=$((count + 1)) ;;
    esac
  done
  printf '%s\n' "$count"
}

wait_no_fallback_runtime() {
  local attempts=${1:-300}
  for _ in $(seq 1 "$attempts"); do
    if [ "$(matching_process_count '/@sleep2agi/agent-node/dist/cli.js')" -eq 0 ] \
      && [ "$(matching_process_count '/test225/fake-grok.mjs')" -eq 0 ] \
      && [ "$(matching_process_count 'npm exec @sleep2agi/agent-node@preview')" -eq 0 ] \
      && [ "$(matching_process_count 'process.stdin.resume()')" -eq 0 ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

process_starttime() {
  local pid=$1 raw tail
  [ -r "/proc/$pid/stat" ] || return 1
  raw=$(<"/proc/$pid/stat")
  tail=${raw##*) }
  set -- $tail
  [ "$#" -ge 20 ] || return 1
  printf '%s\n' "${20}"
}

snapshot_fallback_runtime() {
  local output=$1 proc pid cmd start kind
  : >"$output"
  chmod 600 "$output"
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    pid=${proc##*/}
    cmd=$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)
    kind=""
    case "$cmd" in
      *"/@sleep2agi/agent-node/dist/cli.js"*) kind=agent-node ;;
      *"/test225/fake-grok.mjs"*) kind=grok ;;
      *flock*"process.stdin.resume()"*) kind=lock-holder ;;
    esac
    [ -n "$kind" ] || continue
    start=$(process_starttime "$pid") || continue
    printf '%s %s %s\n' "$pid" "$start" "$kind" >>"$output"
  done
}

assert_snapshot_gone() {
  local input=$1 pid start kind current
  while read -r pid start kind; do
    current=$(process_starttime "$pid" 2>/dev/null || true)
    [ -z "$current" ] || [ "$current" != "$start" ] \
      || fail "recorded $kind process survived stop"
  done <"$input"
}

file_mode() {
  stat -c '%a' "$1"
}

scan_fixed_file() {
  local patterns=$1
  shift
  [ -s "$patterns" ] || return 0
  for target in "$@"; do
    [ -e "$target" ] || continue
    if [ -d "$target" ]; then
      if grep -R -F -f "$patterns" "$target" >/dev/null 2>&1; then return 1; fi
    elif grep -F -f "$patterns" "$target" >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

stop_node_checked() {
  local alias label output
  alias=$1
  label=$2
  output="/tmp/test225-${label}-stop.raw.log"
  if ! anet node stop "$alias" >"$output" 2>&1; then
    fail_with_private_log "node stop failed for $label" "$output"
  fi
  scan_fixed_file /tmp/test225-markers "$output" \
    || fail "node stop output exposed a synthetic credential marker for $label"
  scan_fixed_file /tmp/test225-assistant-marker "$output" \
    || fail "node stop output exposed an assistant credential marker for $label"
  scan_fixed_file /tmp/test225-live-credentials "$output" \
    || fail "node stop output exposed a Hub credential for $label"
  scan_fixed_file /tmp/test225-real-patterns "$output" \
    || fail "node stop output exposed a real auth scalar for $label"
  rm -f "$output"
}

NODE_PROCESS_PID=""
SERVER_PID=""
REGISTRY_PID=""
cleanup() {
  set +e
  for session in test225-attach test225-resume-attach test225-real-attach test225-real-resume-attach; do
    tmux kill-session -t "$session" 2>/dev/null || true
  done
  if [ -n "$NODE_PROCESS_PID" ]; then kill "$NODE_PROCESS_PID" 2>/dev/null || true; fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [ -n "$REGISTRY_PID" ]; then kill "$REGISTRY_PID" 2>/dev/null || true; fi
  pkill -f '/test225/fake-grok.mjs' 2>/dev/null || true
  rm -f \
    "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
    "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$RESUME_CAPTURE" \
    "$REAL_START_LOG" "$REAL_RESUME_LOG" "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" \
    "$REGISTER_LOG" "$CREATE_LOG" "$HEADLESS_CREATE_LOG" "$REAL_CREATE_LOG" \
    "$GLOBAL_INSTALL_LOG" \
    /tmp/test225-*-stop.raw.log \
    /tmp/test225-markers /tmp/test225-assistant-marker /tmp/test225-live-credentials \
    /tmp/test225-real-patterns /tmp/test225-real-hub-rows /tmp/test225-hub-results \
    /tmp/test225-headless.raw.log \
    /tmp/test225-candidate-agent-node-package.json \
    "$EXPECTED_GROK_ENV_KEYS" "$EXPECTED_GROK_PTY_ENV_KEYS" "$EXPECTED_AGENT_NODE_ENV_KEYS" \
    "$EXPECTED_NPX_ENV_KEYS" "$NPX_ENV_OBSERVATION" \
    "$FALLBACK_PID_SNAPSHOT" \
    "$FAKE_OBSERVATIONS" "$FAKE_READINESS_OBSERVATIONS" "$LOCAL_REGISTRY_LOG"
  rm -rf /tmp/test225-candidate-extracted /tmp/test225-real-auth /tmp/test225-bin
}
trap cleanup EXIT

log "# test225 — Grok preview candidate tarball + live co-presence"
log "date: $(date -Is)"
log "source_commit=${TEST225_SOURCE_COMMIT:-uncommitted}"
log "network=container-local Hub; outbound npm only for initial candidate dependency resolution"

log "[L0] clean candidate package image"
[ ! -e /workspace ] || fail "runtime image unexpectedly contains /workspace source checkout"
[ ! -e /build ] || fail "runtime image unexpectedly contains packer source tree"
[ -z "${ANET_AGENT_NODE_BIN:-}" ] || fail "ANET_AGENT_NODE_BIN source escape hatch is set"
command -v anet >/dev/null || fail "anet is not installed from candidate tarball"
command -v agent-node >/dev/null && fail "clean fallback image unexpectedly has a global agent-node"
command -v commhub-server >/dev/null || fail "commhub-server is not installed from candidate tarball"

ANET_VERSION=$(node -p 'require("/usr/local/lib/node_modules/@sleep2agi/agent-network/package.json").version')
NODE_TGZ=$(find /candidate -maxdepth 1 -type f -name 'sleep2agi-agent-node-*.tgz' -print -quit)
[ -n "$NODE_TGZ" ] || fail "agent-node candidate tarball is missing"
NODE_TGZ_SHA256=$(sha256sum "$NODE_TGZ" | awk '{print $1}')
tar -xOf "$NODE_TGZ" package/package.json > /tmp/test225-candidate-agent-node-package.json
chmod 600 /tmp/test225-candidate-agent-node-package.json
AGENT_NODE_VERSION=$(jq -r .version /tmp/test225-candidate-agent-node-package.json)
SERVER_VERSION=$(node -p 'require("/usr/local/lib/node_modules/@sleep2agi/commhub-server/package.json").version')
[[ "$ANET_VERSION" == *-preview.* ]] || fail "agent-network candidate is not a preview version"
[[ "$AGENT_NODE_VERSION" == *-preview.* ]] || fail "agent-node candidate is not a preview version"
[[ "$SERVER_VERSION" == "0.9.0-preview.21" ]] || fail "test Hub is not the current published preview baseline"
node -e '
  for (const path of process.argv.slice(1)) {
    const pkg = require(path);
    if (pkg.publishConfig?.tag !== "preview") process.exit(1);
  }
' \
  /usr/local/lib/node_modules/@sleep2agi/agent-network/package.json \
  /tmp/test225-candidate-agent-node-package.json \
  || fail "candidate package metadata does not force the preview dist-tag"
anet --help | grep -Fq 'anet grok attach' || fail "installed anet does not advertise grok attach"
pass "anet candidate installed without global agent-node (candidate=$AGENT_NODE_VERSION); published preview Hub=$SERVER_VERSION"

mkdir -p /tmp/test225-candidate-extracted
for tarball in /candidate/*.tgz; do
  tar -tzf "$tarball" > /tmp/test225-tar-list
  if grep -Eiq '(^|/)(\.env|auth\.json|pending-replies\.json|[^/]*\.raw(\.|$)|[^/]*capture|report-test|\.git)(/|$)' /tmp/test225-tar-list; then
    fail "candidate tarball contains a forbidden credential/capture/report path"
  fi
  dest="/tmp/test225-candidate-extracted/$(basename "$tarball" .tgz)"
  mkdir -p "$dest"
  tar -xzf "$tarball" -C "$dest"
done
rm -f /tmp/test225-tar-list
pass "tarball file lists contain no auth, dotenv, pending-reply, raw capture, report, or VCS payload"

log "[L1] isolated Hub + real anet node create"
commhub-server --host 127.0.0.1 --port "$HUB_PORT" --db "$COMMHUB_DB" --dev-open >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_http "$HUB/health" || fail "candidate commhub-server did not become healthy"

cd "$WORK"
anet register --username test225 --password "$TEST_PASSWORD" >"$REGISTER_LOG" 2>&1
grep -Fq 'Registered and logged in' "$REGISTER_LOG" || fail "anet register did not complete"
anet node create "$ALIAS" --runtime grok-build-cli >"$CREATE_LOG" 2>&1
grep -Fq 'EXPERIMENTAL/DANGEROUS' "$CREATE_LOG" \
  || fail "grok preview create did not print its danger warning"
grep -Fq "anet grok attach $ALIAS" "$CREATE_LOG" \
  || fail "grok preview create did not print attach guidance"

CONFIG="$WORK/.anet/nodes/$ALIAS/config.json"
[ -f "$CONFIG" ] || fail "anet node create did not persist config"
jq -e '.runtime == "grok-build-cli" and .grokCopresence == true
  and (.grokLeaderSocket | type == "string") and (.grokAttachSocket | type == "string")
  and (.token | startswith("ntok_"))' "$CONFIG" >/dev/null \
  || fail "created node config is not a grok co-presence profile"
[ "$(file_mode "$CONFIG")" = 600 ] || fail "node credential store mode is not 0600"
[ "$(file_mode "$HOME/.anet/config.json")" = 600 ] || fail "global credential store mode is not 0600"
USER_TOKEN=$(jq -r '.token' "$HOME/.anet/config.json")
NETWORK_ID=$(jq -r '.network_id' "$HOME/.anet/config.json")
NODE_TOKEN=$(jq -r '.token' "$CONFIG")
printf '%s\n' "$TEST_PASSWORD" "$USER_TOKEN" "$NODE_TOKEN" > /tmp/test225-live-credentials
chmod 600 /tmp/test225-live-credentials
ATTACH_SOCKET=$(jq -r '.grokAttachSocket' "$CONFIG")
LEADER_SOCKET=$(jq -r '.grokLeaderSocket' "$CONFIG")
scan_fixed_file /tmp/test225-live-credentials "$REGISTER_LOG" "$CREATE_LOG" \
  || fail "register/create console output exposed a persisted Hub credential"
rm -f "$REGISTER_LOG" "$CREATE_LOG"
pass "anet create selected grok-build-cli and persisted owner-only credentials"

# Persisted profile decisions must beat stale ambient mode/socket variables.
HEADLESS_ALIAS=preview-grok-headless-225
anet node create "$HEADLESS_ALIAS" --runtime grok-build-cli --grok-headless \
  >"$HEADLESS_CREATE_LOG" 2>&1
HEADLESS_CONFIG="$WORK/.anet/nodes/$HEADLESS_ALIAS/config.json"
jq -e '.runtime == "grok-build-cli" and .grokCopresence == false
  and (.grokLeaderSocket == null) and (.grokAttachSocket == null)' "$HEADLESS_CONFIG" >/dev/null \
  || fail "--grok-headless did not persist an explicit co-presence opt-out"
HEADLESS_TOKEN=$(jq -r '.token' "$HEADLESS_CONFIG")
printf '%s\n' "$HEADLESS_TOKEN" >> /tmp/test225-live-credentials
scan_fixed_file /tmp/test225-live-credentials "$HEADLESS_CREATE_LOG" \
  || fail "headless create console output exposed a persisted Hub credential"
rm -f "$HEADLESS_CREATE_LOG"

log "[L2] deterministic package-only TUI co-presence"
chmod 755 "$FAKE_GROK"
mkdir -p /tmp/test225-bin
ln -sf "$FAKE_GROK" /tmp/test225-bin/grok
ln -sf /test225/npx-env-wrapper.mjs /tmp/test225-bin/npx
export PATH="/tmp/test225-bin:$PATH"
cat > /tmp/test225-markers <<'EOF_MARKERS'
TEST225_DB_CANARY_40a728
TEST225_AWS_CANARY_d821c9
TEST225_TOKEN_CANARY_74f210
TEST225_SECRET_CANARY_36e7b5
TEST225_KEY_CANARY_a5c0f8
TEST225_NTOK_CANARY_4af821
TEST225_UTOK_CANARY_a1dd60
EOF_MARKERS
printf '%s\n' 'TEST225_ASSISTANT_SECRET_CANARY_b682a1' > /tmp/test225-assistant-marker
chmod 600 /tmp/test225-markers
chmod 600 /tmp/test225-assistant-marker

{
  for key in PATH TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TZ SHELL USER LOGNAME TERM COLORTERM NO_COLOR; do
    printenv "$key" >/dev/null 2>&1 && printf '%s\n' "$key"
  done
  printf '%s\n' \
    HOME GROK_HOME GROK_AUTH_PATH ANET_EXPECTED_PARENT_PID \
    GROK_CLAUDE_MCPS_ENABLED GROK_CURSOR_MCPS_ENABLED \
    GROK_CLAUDE_HOOKS_ENABLED GROK_CURSOR_HOOKS_ENABLED \
    GROK_FOLDER_TRUST GROK_DEFAULT_SELECTED_PERMISSION
} | sort -u | jq -Rsc 'split("\n") | map(select(length > 0))' > "$EXPECTED_GROK_ENV_KEYS"
jq -c '. + ["PWD", "TERM"] | unique | sort' "$EXPECTED_GROK_ENV_KEYS" \
  > "$EXPECTED_GROK_PTY_ENV_KEYS"

{
  for key in PATH HOME TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TZ SHELL USER LOGNAME TERM COLORTERM NO_COLOR; do
    printenv "$key" >/dev/null 2>&1 && printf '%s\n' "$key"
  done
  printf '%s\n' GROK_BINARY ANET_CONFIG_UPDATE_CAPABLE
} | sort -u | jq -Rsc 'split("\n") | map(select(length > 0))' > "$EXPECTED_AGENT_NODE_ENV_KEYS"

{
  for key in PATH TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TZ; do
    [ -n "${!key:-}" ] && printf '%s\n' "$key"
  done
  printf '%s\n' \
    HOME npm_config_registry npm_config_cache npm_config_userconfig \
    npm_config_globalconfig npm_config_audit npm_config_fund npm_config_update_notifier
} | sort -u | jq -Rsc 'split("\n") | map(select(length > 0))' > "$EXPECTED_NPX_ENV_KEYS"

node /test225/local-registry.mjs "$NODE_TGZ" 4873 >"$LOCAL_REGISTRY_LOG" 2>&1 &
REGISTRY_PID=$!
wait_file "$LOCAL_REGISTRY_LOG" 100 || fail "local candidate registry did not start"
for _ in $(seq 1 100); do
  grep -Fq READY "$LOCAL_REGISTRY_LOG" && break
  sleep 0.1
done
grep -Fq READY "$LOCAL_REGISTRY_LOG" || fail "local candidate registry did not become ready"

start_fake_node() {
  local output=$1
  env \
    -u ANET_AGENT_NODE_BIN \
    GROK_BINARY="$FAKE_GROK" \
    DATABASE_URL='postgres://u:TEST225_DB_CANARY_40a728@db.invalid/x' \
    AWS_SECRET_ACCESS_KEY='TEST225_AWS_CANARY_d821c9' \
    PARTNER_TOKEN='TEST225_TOKEN_CANARY_74f210' \
    PARTNER_SECRET='TEST225_SECRET_CANARY_36e7b5' \
    PARTNER_KEY='TEST225_KEY_CANARY_a5c0f8' \
    ntok='TEST225_NTOK_CANARY_4af821' \
    utok='TEST225_UTOK_CANARY_a1dd60' \
    ANET_GROK_COPRESENCE=0 \
    GROK_LEADER_SOCKET=/tmp/test225-wrong-leader.sock \
    ANET_GROK_ATTACH_SOCKET=/tmp/test225-wrong-attach.sock \
    npm_config_registry=http://127.0.0.1:4873 \
    npm_config_audit=false \
    npm_config_fund=false \
    anet node start "$ALIAS" >"$output" 2>&1 &
  NODE_PROCESS_PID=$!
}

start_fake_node_global() {
  local output=$1
  env \
    -u ANET_AGENT_NODE_BIN \
    GROK_BINARY="$FAKE_GROK" \
    DATABASE_URL='postgres://u:TEST225_DB_CANARY_40a728@db.invalid/x' \
    AWS_SECRET_ACCESS_KEY='TEST225_AWS_CANARY_d821c9' \
    PARTNER_TOKEN='TEST225_TOKEN_CANARY_74f210' \
    PARTNER_SECRET='TEST225_SECRET_CANARY_36e7b5' \
    PARTNER_KEY='TEST225_KEY_CANARY_a5c0f8' \
    ntok='TEST225_NTOK_CANARY_4af821' \
    utok='TEST225_UTOK_CANARY_a1dd60' \
    ANET_GROK_COPRESENCE=0 \
    GROK_LEADER_SOCKET=/tmp/test225-wrong-leader.sock \
    ANET_GROK_ATTACH_SOCKET=/tmp/test225-wrong-attach.sock \
    npm_config_offline=true \
    anet node start "$ALIAS" >"$output" 2>&1 &
  NODE_PROCESS_PID=$!
}

start_attach() {
  local session=$1
  tmux new-session -d -s "$session" \
    "cd '$WORK' && env -u ANET_AGENT_NODE_BIN HOME='$HOME' PATH='$PATH' anet grok attach '$ALIAS'"
}

start_fake_node "$START_LOG"
wait_file "$ATTACH_SOCKET" 600 \
  || fail_with_private_log "attach socket did not appear through npx preview fallback" "$START_LOG"
grep -Fq 'agent-node is not installed globally; fetching @sleep2agi/agent-node@preview' "$START_LOG" \
  || fail "clean start did not exercise the documented npx preview fallback"
start_attach test225-attach
wait_pane test225-attach 'attached to Grok TUI' "$ATTACH_CAPTURE" 200 \
  || fail "real tmux TTY did not attach through anet grok attach"

# `/goal` bypasses processTask by design, so prove its durable branch applies
# the same preview redaction before writing goals.json.
GOAL_TASK_ID=$(curl -fsS -X POST "$HUB/api/task" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg alias "$ALIAS" --arg network "$NETWORK_ID" \
    '{alias:$alias,task:"/goal 1h audit PARTNER_TOKEN=TEST225_TOKEN_CANARY_74f210",from:"test225-driver",priority:"high",network_id:$network}')" \
  | jq -r '.task_id // .message_id // empty')
[ -n "$GOAL_TASK_ID" ] || fail "goal dispatch returned no task id"
GOAL_ROW=""
for _ in $(seq 1 300); do
  GOAL_ROW=$(curl -fsS "$HUB/api/tasks?limit=50&network_id=$NETWORK_ID" \
    -H "Authorization: Bearer $USER_TOKEN" \
    | jq -c --arg id "$GOAL_TASK_ID" '.tasks[]? | select(.task_id == $id)' || true)
  jq -e '.status == "replied"' <<<"$GOAL_ROW" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.status == "replied"' <<<"$GOAL_ROW" >/dev/null 2>&1 \
  || fail "goal command did not reply"
GOALS_FILE="$WORK/.anet/nodes/$ALIAS/goals.json"
[ -f "$GOALS_FILE" ] || fail "goal command did not persist goals.json"
scan_fixed_file /tmp/test225-markers "$GOALS_FILE" \
  || fail "new goal branch persisted an inbound credential marker"

# Simulate a pre-preview owner-only goal that already contains a credential
# shape. The final assembled Grok prompt must be scrubbed again, even though
# the current inbound task itself is clean.
grep -Fq '[REDACTED_CREDENTIAL]' "$GOALS_FILE" \
  || fail "sanitized goal lacks the expected placeholder"
sed -i 's/\[REDACTED_CREDENTIAL\]/PARTNER_SECRET=TEST225_SECRET_CANARY_36e7b5/' "$GOALS_FILE"
chmod 644 "$GOALS_FILE"

# Reload the legacy record from disk so this is a real final-prompt boundary
# test, not an in-memory GoalStore false positive.
RUNTIME_PID_FILE="$WORK/.anet/nodes/$ALIAS/.pid"
[ -f "$RUNTIME_PID_FILE" ] || fail "npx fallback did not record a runtime PID"
RUNTIME_PID=$(<"$RUNTIME_PID_FILE")
RUNTIME_ARGV=()
while IFS= read -r -d '' arg; do RUNTIME_ARGV+=("$arg"); done <"/proc/$RUNTIME_PID/cmdline"
[ "${#RUNTIME_ARGV[@]}" -ge 2 ] || fail "npx fallback pidfile has no executable argv"
[ "$(readlink -f "${RUNTIME_ARGV[0]}")" = "$(readlink -f "$(command -v node)")" ] \
  || fail "npx fallback pidfile identifies a wrapper instead of Node"
case "${RUNTIME_ARGV[1]}" in
  *"/node_modules/@sleep2agi/agent-node/dist/cli.js") ;;
  *) fail "npx fallback pidfile does not identify the direct candidate entrypoint" ;;
esac
[ "$(matching_process_count 'npm exec @sleep2agi/agent-node@preview')" -eq 0 ] \
  || fail "npx resolver wrapper survived candidate launch"
snapshot_fallback_runtime "$FALLBACK_PID_SNAPSHOT"
[ "$(awk '$3 == "agent-node" {n++} END {print n+0}' "$FALLBACK_PID_SNAPSHOT")" -eq 1 ] \
  || fail "fallback snapshot does not contain exactly one direct agent-node"
[ "$(awk '$3 == "grok" {n++} END {print n+0}' "$FALLBACK_PID_SNAPSHOT")" -eq 1 ] \
  || fail "fallback snapshot does not contain exactly one Grok PTY process"
[ "$(awk '$3 == "lock-holder" {n++} END {print n+0}' "$FALLBACK_PID_SNAPSHOT")" -eq 3 ] \
  || fail "fallback snapshot does not contain the three lifetime lock holders"

stop_node_checked "$ALIAS" legacy-reload
[ ! -e "$ATTACH_SOCKET" ] || fail "node stop returned before removing the attach socket"
[ ! -e "$LEADER_SOCKET" ] || fail "node stop returned before removing the leader socket"
assert_snapshot_gone "$FALLBACK_PID_SNAPSHOT"
tmux kill-session -t test225-attach 2>/dev/null || true
wait "$NODE_PROCESS_PID" 2>/dev/null || true
NODE_PROCESS_PID=""
wait_no_fallback_runtime 300 \
  || fail "npx fallback stop left agent-node, Grok, npm wrapper, or lock-holder processes"
[ ! -e "$RUNTIME_PID_FILE" ] || fail "runtime pidfile survived fallback stop"
LOCK_COUNT=0
while IFS= read -r -d '' lock_path; do
  LOCK_COUNT=$((LOCK_COUNT + 1))
  flock --exclusive --nonblock "$lock_path" true \
    || fail "lifetime lock remained held after fallback stop"
done < <(find "$HOME/.anet-grok" "$(dirname "$LEADER_SOCKET")" -type f -name '*.lock' -print0)
[ "$LOCK_COUNT" -eq 3 ] || fail "fallback stop proof did not find exactly three lifetime lock files"
start_fake_node "$RELOAD_LOG"
wait_file "$ATTACH_SOCKET" 600 \
  || fail_with_private_log "attach socket did not return for legacy-goal reload" "$RELOAD_LOG"
start_attach test225-attach
wait_pane test225-attach 'attached to Grok TUI' "$RELOAD_CAPTURE" 200 \
  || fail "real tmux TTY did not reattach after legacy-goal reload"
for _ in $(seq 1 100); do
  if [ "$(file_mode "$GOALS_FILE")" = 600 ] \
    && scan_fixed_file /tmp/test225-markers "$GOALS_FILE"; then
    break
  fi
  sleep 0.1
done
[ "$(file_mode "$GOALS_FILE")" = 600 ] \
  || fail "legacy goals store was not tightened to owner-only mode"
scan_fixed_file /tmp/test225-markers "$GOALS_FILE" \
  || fail "legacy goals store was not scrubbed during load"
grep -Fq '[REDACTED_CREDENTIAL]' "$GOALS_FILE" \
  || fail "legacy goals store rewrite lacks the redaction placeholder"

TASK_TEXT='GROK_PREVIEW_LIVE_225_A Reply with the fake marker. DATABASE_URL=postgres://TEST225_DB_CANARY_40a728 PARTNER_TOKEN=TEST225_TOKEN_CANARY_74f210 PARTNER_SECRET=TEST225_SECRET_CANARY_36e7b5 PARTNER_KEY=TEST225_KEY_CANARY_a5c0f8'
TASK_ID=$(curl -fsS -X POST "$HUB/api/task" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg alias "$ALIAS" --arg task "$TASK_TEXT" --arg network "$NETWORK_ID" \
    '{alias:$alias,task:$task,from:"test225-driver",priority:"high",network_id:$network}')" \
  | jq -r '.task_id // .message_id // empty')
[ -n "$TASK_ID" ] || fail "Hub dispatch returned no task id"

TASK_ROW=""
for _ in $(seq 1 300); do
  TASK_ROW=$(curl -fsS "$HUB/api/tasks?limit=50&network_id=$NETWORK_ID" \
    -H "Authorization: Bearer $USER_TOKEN" \
    | jq -c --arg id "$TASK_ID" '.tasks[]? | select(.task_id == $id)' || true)
  jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_FAKE_REPLY_OK"))' \
    <<<"$TASK_ROW" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_FAKE_REPLY_OK"))' \
  <<<"$TASK_ROW" >/dev/null 2>&1 \
  || fail_with_private_log "Hub task did not receive fake Grok reply" "$START_LOG"
{
  jq -r '.result // ""' <<<"$GOAL_ROW"
  jq -r '.result // ""' <<<"$TASK_ROW"
} > /tmp/test225-hub-results
chmod 600 /tmp/test225-hub-results
wait_pane test225-attach 'GROK_PREVIEW_LIVE_225_A' "$RELOAD_CAPTURE" 100 \
  || fail "attached human TUI did not live-render the Hub task"
wait_pane test225-attach 'GROK_PREVIEW_FAKE_REPLY_OK' "$RELOAD_CAPTURE" 100 \
  || fail "attached human TUI did not live-render the Grok reply"
grep -Fq 'TEST225_ASSISTANT_SECRET_CANARY_b682a1' "$RELOAD_CAPTURE" \
  || fail "owner-only TUI proof did not contain the assistant-generated marker"
pass "create -> start -> register -> Hub task -> real tmux attach live render -> reply"

log "[L3] exact child-env and persisted-output checks"
grep -Fq "CANDIDATE_PACKUMENT version=$AGENT_NODE_VERSION" "$LOCAL_REGISTRY_LOG" \
  || fail "npx fallback did not fetch the candidate packument from the local registry"
grep -Fq "CANDIDATE_TARBALL sha256=$NODE_TGZ_SHA256" "$LOCAL_REGISTRY_LOG" \
  || fail "npx fallback did not fetch the exact candidate tarball"
[ -f "$NPX_ENV_OBSERVATION" ] || fail "npx resolver wrapper did not record its environment"
jq -e --slurpfile expected "$EXPECTED_NPX_ENV_KEYS" --arg home "$HOME" \
  '.envKeys == $expected[0]
   and .env.HOME == $home
   and .env.npm_config_registry == "http://127.0.0.1:4873/"
   and .env.npm_config_cache == ($home + "/.npm")
   and .env.npm_config_userconfig == ($home + "/.anet/npm-resolver/user.npmrc")
   and .env.npm_config_globalconfig == ($home + "/.anet/npm-resolver/global.npmrc")
   and .env.npm_config_audit == "false"
   and .env.npm_config_fund == "false"
   and .env.npm_config_update_notifier == "false"' \
  "$NPX_ENV_OBSERVATION" >/dev/null \
  || fail "npx resolver environment differs from the exact reviewed set"
NPX_CONFIG_DIR="$HOME/.anet/npm-resolver"
[ "$(file_mode "$NPX_CONFIG_DIR")" = 700 ] \
  || fail "npx resolver config directory is not owner-only"
for config in "$NPX_CONFIG_DIR/user.npmrc" "$NPX_CONFIG_DIR/global.npmrc"; do
  [ -f "$config" ] && [ ! -s "$config" ] && [ "$(file_mode "$config")" = 600 ] \
    || fail "npx resolver config is not distinct, empty, and owner-only"
done
[ "$(stat -c %i "$NPX_CONFIG_DIR/user.npmrc")" != "$(stat -c %i "$NPX_CONFIG_DIR/global.npmrc")" ] \
  || fail "npx resolver user/global config files share an inode"
scan_fixed_file /tmp/test225-markers "$NPX_ENV_OBSERVATION" \
  || fail "npx resolver inherited a synthetic credential marker"
scan_fixed_file /tmp/test225-live-credentials "$NPX_ENV_OBSERVATION" \
  || fail "npx resolver inherited a Hub credential"
wait_file "$FAKE_OBSERVATIONS" 100 || fail "fake Grok did not write derived env observation"
wait_file "$FAKE_READINESS_OBSERVATIONS" 100 \
  || fail "fake Grok did not write a derived TUI readiness observation"
if ! jq -e -s 'length > 0 and all(.[]; .preReadyNetworkWrites == 0)' \
  "$FAKE_READINESS_OBSERVATIONS" >/dev/null; then
  fail "candidate wrote a network prompt before the TUI composer readiness gate"
fi
if ! jq -e -s --slurpfile expected "$EXPECTED_GROK_ENV_KEYS" \
  --slurpfile expectedPty "$EXPECTED_GROK_PTY_ENV_KEYS" \
  --slurpfile expectedParent "$EXPECTED_AGENT_NODE_ENV_KEYS" \
  'any(.[]; .kind == "version") and any(.[]; .kind == "help")
  and any(.[]; .kind == "inspect") and any(.[]; .kind == "spawn")
  and all(.[]; (.forbiddenKeys | length) == 0 and .markerValueObserved == false
    and (if .kind == "spawn"
      then .envKeys == $expectedPty[0] and .terminalEnvExpected == true
        and .parentPidMatches == true
        and .folderTrustExact == true
        and .folderTrustMode == 384
        and .folderTrustCount == 1
        and .parentEnvKeys == $expectedParent[0]
        and (.parentForbiddenKeys | length) == 0
        and .parentMarkerValueObserved == false
      else .envKeys == $expected[0]
      end))' \
  "$FAKE_OBSERVATIONS" >/dev/null; then
  # Key names only: preserve a useful, value-free diagnostic without
  # disclosing any child environment values into the report.
  jq -c -s --slurpfile expected "$EXPECTED_GROK_ENV_KEYS" \
    --slurpfile expectedPty "$EXPECTED_GROK_PTY_ENV_KEYS" \
    --slurpfile expectedParent "$EXPECTED_AGENT_NODE_ENV_KEYS" \
    'map(. as $row | (if .kind == "spawn" then $expectedPty[0] else $expected[0] end) as $want
      | {kind,missing:($want - .envKeys),extra:(.envKeys - $want),forbiddenKeys,markerValueObserved,
          terminalEnvExpected,parentPidMatches,
          parentMissing:($expectedParent[0] - (.parentEnvKeys // [])),
          parentExtra:((.parentEnvKeys // []) - $expectedParent[0]),
          parentForbiddenKeys,parentMarkerValueObserved})' \
    "$FAKE_OBSERVATIONS" | tee -a "$REPORT"
  fail "candidate Grok probe/PTY env differs from the exact reviewed key set"
fi
if scan_fixed_file /tmp/test225-markers \
  "$START_LOG" "$RELOAD_LOG" "$ATTACH_CAPTURE" "$RELOAD_CAPTURE"; then :; else
  fail "synthetic credential reached ordinary agent/TUI logs"
fi
grep -Fq 'TEST225_ASSISTANT_SECRET_CANARY_b682a1' <<<"$TASK_ROW" \
  && fail "assistant-generated credential shape reached the Hub reply"
SESSION_ID=$(jq -r '.grokCliSession // empty' "$CONFIG")
[ -n "$SESSION_ID" ] || fail "co-presence session id was not persisted"
GROK_STATE="$HOME/.anet-grok"
if scan_fixed_file /tmp/test225-markers "$GROK_STATE"; then :; else
  fail "synthetic credential reached Grok session or generated state"
fi
# Grok owns its live transcript and may persist model output before the
# bridge can scrub it. That explicitly accepted preview exception is confined
# to this owner-only store/TUI; the marker must still be absent from Hub
# replies, ordinary logs, pending replies, reports, and tarballs.
grep -R -Fq 'TEST225_ASSISTANT_SECRET_CANARY_b682a1' "$GROK_STATE" \
  || fail "owner-only Grok transcript proof did not contain the assistant-generated marker"
if find "$GROK_STATE" -type d -perm /077 -print -quit | grep -q .; then
  fail "Grok state contains a directory accessible to group/other"
fi
if find "$GROK_STATE" -type f ! -perm 0600 -print -quit | grep -q .; then
  fail "Grok state contains a regular file whose mode is not 0600"
fi
PENDING="$WORK/.anet/nodes/$ALIAS/pending-replies.json"
if [ -e "$PENDING" ]; then
  [ "$(file_mode "$PENDING")" = 600 ] || fail "pending-replies store is not mode 0600"
  scan_fixed_file /tmp/test225-markers "$PENDING" || fail "synthetic credential reached pending-replies store"
fi
scan_fixed_file /tmp/test225-markers /tmp/test225-candidate-extracted "$REPORT" \
  || fail "synthetic credential reached candidate tarball or report"
scan_fixed_file /tmp/test225-markers "$WORK/.anet/nodes/$ALIAS" \
  || fail "synthetic credential reached node-local durable state"
scan_fixed_file /tmp/test225-assistant-marker \
  /tmp/test225-candidate-extracted "$START_LOG" "$RELOAD_LOG" "$PENDING" "$REPORT" \
  /tmp/test225-hub-results \
  || fail "assistant-generated credential shape reached ordinary log/pending/tarball/report"
scan_fixed_file /tmp/test225-live-credentials \
  /tmp/test225-candidate-extracted "$SERVER_LOG" "$START_LOG" "$ATTACH_CAPTURE" \
  "$RELOAD_LOG" "$RELOAD_CAPTURE" "$GROK_STATE" "$PENDING" "$REPORT" \
  /tmp/test225-hub-results \
  || fail "test Hub credential reached tarball/log/TUI/state/pending/report"
pass "Grok child env is filtered; state is 0700/0600; credentials are absent from logs/state/pending/tarballs/report"

for private_raw in "$REPORT" "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" \
  "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$FAKE_OBSERVATIONS" "$NPX_ENV_OBSERVATION"; do
  [ "$(file_mode "$private_raw")" = 600 ] || fail "raw test artifact is not mode 0600: $private_raw"
done
pass "all retained test logs/captures are owner-only during the run"

log "[L4] npx fallback -> global candidate + same-session resume"
stop_node_checked "$ALIAS" fallback
tmux kill-session -t test225-attach 2>/dev/null || true
wait_gone "$ATTACH_SOCKET" 300 || fail "attach socket survived node stop"
wait "$NODE_PROCESS_PID" 2>/dev/null || true
NODE_PROCESS_PID=""

# Install the exact same unpublished tarball only after the fallback path has
# succeeded. From here onward npm is offline, proving start selects the global
# candidate rather than source or another npx resolution.
if ! npm install -g --include=optional "$NODE_TGZ" >"$GLOBAL_INSTALL_LOG" 2>&1; then
  fail_with_private_log "global candidate agent-node install failed" "$GLOBAL_INSTALL_LOG"
fi
command -v agent-node >/dev/null || fail "candidate agent-node global binary is missing"
agent-node --help | grep -Fq 'ANET_CAPABILITY_GROK_COPRESENCE_V1' \
  || fail "global candidate agent-node lacks the co-presence capability marker"
node -e '
  const root = "/usr/local/lib/node_modules/@sleep2agi/agent-node";
  require(require.resolve("node-pty", { paths: [root] }));
' || fail "global candidate agent-node lacks its node-pty optional dependency"
scan_fixed_file /tmp/test225-markers "$GLOBAL_INSTALL_LOG" \
  || fail "global install output exposed a synthetic credential marker"
scan_fixed_file /tmp/test225-assistant-marker "$GLOBAL_INSTALL_LOG" \
  || fail "global install output exposed an assistant credential marker"
scan_fixed_file /tmp/test225-live-credentials "$GLOBAL_INSTALL_LOG" \
  || fail "global install output exposed a Hub credential"
rm -f "$GLOBAL_INSTALL_LOG"

# Dynamic package gate: a configured Feishu channel must fail before the
# forked worker or Grok TUI starts, with a fixed explanation and no channel
# credential in output.
FEISHU_DIR=/tmp/test225-feishu-refused
FEISHU_CONFIG=/tmp/test225-feishu-refused-config.json
FEISHU_LOG=/tmp/test225-feishu-refused.raw.log
mkdir -p "$FEISHU_DIR"
chmod 700 "$FEISHU_DIR"
printf '%s\n' 'FEISHU_APP_ID=test225' \
  'FEISHU_APP_SECRET=TEST225_SECRET_CANARY_36e7b5' > "$FEISHU_DIR/.env"
printf '%s\n' '{"allowFrom":[]}' > "$FEISHU_DIR/access.json"
chmod 600 "$FEISHU_DIR/.env" "$FEISHU_DIR/access.json"
jq --arg channel "feishu:$FEISHU_DIR" '.channels=[$channel]' "$CONFIG" > "$FEISHU_CONFIG"
chmod 600 "$FEISHU_CONFIG"
if env -i HOME="$HOME" PATH="$PATH" GROK_BINARY="$FAKE_GROK" \
  agent-node --config "$FEISHU_CONFIG" --alias "$ALIAS" --runtime grok-build-cli \
  > "$FEISHU_LOG" 2>&1; then
  fail "installed candidate accepted an unsupported Feishu channel"
fi
grep -Fq 'grok-build-cli preview currently refuses Feishu channels' "$FEISHU_LOG" \
  || fail "installed candidate Feishu refusal lacked the fixed explanation"
scan_fixed_file /tmp/test225-markers "$FEISHU_LOG" \
  || fail "Feishu refusal output exposed a synthetic credential marker"
[ "$(matching_process_count '/test225/fake-grok.mjs')" -eq 0 ] \
  || fail "Feishu refusal started Grok before closing the channel boundary"
rm -rf "$FEISHU_DIR" "$FEISHU_CONFIG" "$FEISHU_LOG"

# The local registry was needed only for the first npx path. Kill it before
# resume so a false global-install check cannot silently fall back to network.
kill "$REGISTRY_PID" 2>/dev/null || true
wait "$REGISTRY_PID" 2>/dev/null || true
REGISTRY_PID=""

# A persisted headless opt-out must beat a stale ambient co-presence enable.
HEADLESS_LOG=/tmp/test225-headless.raw.log
env ANET_GROK_COPRESENCE=1 \
  GROK_LEADER_SOCKET=/tmp/test225-headless-wrong-leader.sock \
  ANET_GROK_ATTACH_SOCKET=/tmp/test225-headless-wrong-attach.sock \
  GROK_BINARY="$FAKE_GROK" npm_config_offline=true \
  anet node start "$HEADLESS_ALIAS" >"$HEADLESS_LOG" 2>&1 &
HEADLESS_PID=$!
sleep 1
[ ! -e /tmp/test225-headless-wrong-leader.sock ] \
  || fail "ambient ANET_GROK_COPRESENCE overrode persisted headless mode"
grep -Fq 'EXPERIMENTAL/DANGEROUS grok-build-cli co-presence is enabled' "$HEADLESS_LOG" \
  && fail "headless node emitted the effective co-presence warning"
scan_fixed_file /tmp/test225-markers "$HEADLESS_LOG" \
  || fail "headless start output exposed a synthetic credential marker"
scan_fixed_file /tmp/test225-live-credentials "$HEADLESS_LOG" \
  || fail "headless start output exposed a Hub credential"
stop_node_checked "$HEADLESS_ALIAS" headless
wait "$HEADLESS_PID" 2>/dev/null || true
rm -f "$HEADLESS_LOG"
pass "persisted co-presence true/false and socket identities override stale ambient env"

# Seed an owner-only legacy queue record so the installed tarball—not merely
# a unit test—must scrub the final pending-reply serialization boundary on
# startup. The fake target is expected to be rejected after the scrub.
jq -n --arg marker 'PARTNER_TOKEN=TEST225_TOKEN_CANARY_74f210' '[{
  to:"test225-missing-target",
  text:("legacy pending " + $marker),
  taskId:"test225-legacy-pending",
  failed:true,
  queuedAt:1,
  attempts:0,
  lastError:("legacy failure " + $marker)
}]' >"$PENDING"
chmod 600 "$PENDING"

# A corrupt pre-preview goal file must not be copied byte-for-byte into a
# recovery artifact. The installed package must scrub the backup, replace the
# live file with an empty valid store, and tighten both files to 0600.
printf '%s\n' '{bad PARTNER_KEY=TEST225_KEY_CANARY_a5c0f8' > "$GOALS_FILE"
chmod 644 "$GOALS_FILE"

start_fake_node_global "$RESUME_LOG"
wait_file "$ATTACH_SOCKET" 300 \
  || fail_with_private_log "attach socket did not return from global candidate" "$RESUME_LOG"
for _ in $(seq 1 200); do
  if [ -f "$PENDING" ] && [ "$(file_mode "$PENDING")" = 600 ] \
    && scan_fixed_file /tmp/test225-markers "$PENDING"; then
    break
  fi
  sleep 0.1
done
[ -f "$PENDING" ] || fail "installed candidate did not retain the pending-reply store"
[ "$(file_mode "$PENDING")" = 600 ] || fail "installed candidate widened the pending-reply store mode"
scan_fixed_file /tmp/test225-markers "$PENDING" \
  || fail "installed candidate did not scrub a legacy pending reply"
CORRUPT_BACKUP=""
for _ in $(seq 1 100); do
  CORRUPT_BACKUP=$(find "$(dirname "$GOALS_FILE")" -maxdepth 1 -type f \
    -name 'goals.json.corrupt.*' -print -quit)
  [ -n "$CORRUPT_BACKUP" ] && break
  sleep 0.1
done
[ -n "$CORRUPT_BACKUP" ] || fail "installed candidate did not preserve a corrupt goals artifact"
[ "$(file_mode "$CORRUPT_BACKUP")" = 600 ] \
  || fail "corrupt goals artifact is not owner-only"
[ "$(file_mode "$GOALS_FILE")" = 600 ] \
  || fail "recovered live goals store is not owner-only"
scan_fixed_file /tmp/test225-markers "$CORRUPT_BACKUP" "$GOALS_FILE" \
  || fail "corrupt goals recovery persisted a credential marker"
jq -e '.version == 1 and .goals == []' "$GOALS_FILE" >/dev/null \
  || fail "corrupt goals recovery did not replace the live file with an empty valid store"
start_attach test225-resume-attach
wait_pane test225-resume-attach 'attached to Grok TUI' "$RESUME_CAPTURE" 200 \
  || fail "tmux could not attach after resume"

RESUME_TEXT='GROK_PREVIEW_RESUME_225_B Reply with the fake resume marker.'
RESUME_TASK_ID=$(curl -fsS -X POST "$HUB/api/task" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg alias "$ALIAS" --arg task "$RESUME_TEXT" --arg network "$NETWORK_ID" \
    '{alias:$alias,task:$task,from:"test225-driver",priority:"high",network_id:$network}')" \
  | jq -r '.task_id // .message_id // empty')
[ -n "$RESUME_TASK_ID" ] || fail "resume dispatch returned no task id"

RESUME_ROW=""
for _ in $(seq 1 300); do
  RESUME_ROW=$(curl -fsS "$HUB/api/tasks?limit=50&network_id=$NETWORK_ID" \
    -H "Authorization: Bearer $USER_TOKEN" \
    | jq -c --arg id "$RESUME_TASK_ID" '.tasks[]? | select(.task_id == $id)' || true)
  jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_RESUME_225_B"))' \
    <<<"$RESUME_ROW" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_RESUME_225_B"))' \
  <<<"$RESUME_ROW" >/dev/null 2>&1 || fail "resumed node did not reply"
jq -r '.result // ""' <<<"$RESUME_ROW" >> /tmp/test225-hub-results
wait_pane test225-resume-attach 'GROK_PREVIEW_RESUME_225_B' "$RESUME_CAPTURE" 100 \
  || fail "resumed attached TUI did not render the second task"
[ "$(jq -r '.grokCliSession' "$CONFIG")" = "$SESSION_ID" ] \
  || fail "stop/resume changed the Grok session id"
jq -e -s '([.[] | select(.kind == "spawn")] | length) >= 2
  and ([.[] | select(.kind == "spawn")][-1].resume == true)
  and all(.[] | select(.kind == "spawn");
    .folderTrustExact == true and .folderTrustMode == 384 and .folderTrustCount == 1)
  and all(.[]; (.forbiddenKeys | length) == 0 and .markerValueObserved == false)' \
  "$FAKE_OBSERVATIONS" >/dev/null \
  || fail "fake Grok did not resume or resumed with a forbidden env"
jq -e -s 'length > 0 and all(.[]; .preReadyNetworkWrites == 0)' \
  "$FAKE_READINESS_OBSERVATIONS" >/dev/null \
  || fail "resume wrote a network prompt before the TUI composer readiness gate"
grep -Fq 'fetching @sleep2agi/agent-node@preview' "$START_LOG" \
  || fail "initial package-only start no longer proves the documented npx preview fallback"
grep -Fq '[anet] using installed agent-node with Grok co-presence capability.' "$RESUME_LOG" \
  || fail "resume did not identify the installed global candidate agent-node"
grep -Eq 'fetching @sleep2agi/agent-node@preview|using @sleep2agi/agent-node@preview instead' "$RESUME_LOG" \
  && fail "resume used a cached npx preview path instead of the installed global candidate"
pass "node stop/resume reused one session: first start used npx preview fallback; resume used global candidate"

stop_node_checked "$ALIAS" resumed
tmux kill-session -t test225-resume-attach 2>/dev/null || true
wait "$NODE_PROCESS_PID" 2>/dev/null || true
NODE_PROCESS_PID=""

run_real_gate() {
  local real_bin=${TEST225_REAL_GROK_BIN:-/host-grok/bin/grok-0.2.93}
  local real_auth=${TEST225_REAL_GROK_AUTH:-/host-grok/auth.json}
  local real_alias=preview-grok-real-225
  local real_config="$WORK/.anet/nodes/$real_alias/config.json"
  local real_socket real_session first_id first_row second_id second_row

  [ -x "$real_bin" ] || fail "RUN_REAL_GROK=1 but real Grok binary is not executable: $real_bin"
  [ -r "$real_auth" ] || fail "RUN_REAL_GROK=1 but real Grok auth is not readable: $real_auth"
  [[ "$($real_bin --version)" =~ ^grok\ 0\.2\.93\ \(f00f96316d\)(\ \[stable\])?$ ]] \
    || fail "optional live gate requires exact Grok 0.2.93"

  mkdir -p "$HOME/.grok" /tmp/test225-real-auth
  cp "$real_auth" "$HOME/.grok/auth.json"
  chmod 600 "$HOME/.grok/auth.json"
  [ ! -r /host-grok/agent_id ] || cp /host-grok/agent_id "$HOME/.grok/agent_id"
  # Treat every nontrivial auth string as private. Do not assume credentials
  # live under a token/key/secret-shaped field name; upstream schemas may use
  # generic value/content fields.
  jq -r '.. | strings | select(length >= 12)' "$HOME/.grok/auth.json" \
    | sort -u > /tmp/test225-real-patterns
  chmod 600 /tmp/test225-real-patterns

  anet node create "$real_alias" --runtime grok-build-cli >"$REAL_CREATE_LOG" 2>&1
  grep -Fq 'EXPERIMENTAL/DANGEROUS' "$REAL_CREATE_LOG" \
    || fail "optional real node omitted danger warning"
  printf '%s\n' "$(jq -r '.token' "$real_config")" >> /tmp/test225-live-credentials
  scan_fixed_file /tmp/test225-live-credentials "$REAL_CREATE_LOG" \
    || fail "optional real create console output exposed a Hub credential"
  scan_fixed_file /tmp/test225-real-patterns "$REAL_CREATE_LOG" \
    || fail "optional real create console output exposed an auth scalar"
  rm -f "$REAL_CREATE_LOG"
  real_socket=$(jq -r '.grokAttachSocket' "$real_config")

  env -u ANET_AGENT_NODE_BIN GROK_BINARY="$real_bin" npm_config_offline=true \
    anet node start "$real_alias" >"$REAL_START_LOG" 2>&1 &
  NODE_PROCESS_PID=$!
  wait_file "$real_socket" 600 \
    || fail_with_private_log "real Grok attach socket did not appear" "$REAL_START_LOG"
  tmux new-session -d -s test225-real-attach \
    "cd '$WORK' && env -u ANET_AGENT_NODE_BIN HOME='$HOME' PATH='$PATH' anet grok attach '$real_alias'"
  wait_pane test225-real-attach 'attached to Grok TUI' "$REAL_CAPTURE" 300 \
    || fail "optional real TUI did not attach"

  first_id=$(curl -fsS -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg alias "$real_alias" --arg network "$NETWORK_ID" \
      '{alias:$alias,task:"Reply with exactly GROK_PREVIEW_REAL_225_A and nothing else.",from:"test225-driver",priority:"high",network_id:$network}')" \
    | jq -r '.task_id // .message_id // empty')
  for _ in $(seq 1 1800); do
    first_row=$(curl -fsS "$HUB/api/tasks?limit=80&network_id=$NETWORK_ID" \
      -H "Authorization: Bearer $USER_TOKEN" \
      | jq -c --arg id "$first_id" '.tasks[]? | select(.task_id == $id)' || true)
    jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_REAL_225_A"))' \
      <<<"$first_row" >/dev/null 2>&1 && break
    sleep 0.2
  done
  jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_REAL_225_A"))' \
    <<<"$first_row" >/dev/null 2>&1 || fail "optional real Grok first task did not reply"
  wait_pane test225-real-attach 'GROK_PREVIEW_REAL_225_A' "$REAL_CAPTURE" 300 \
    || fail "optional real TUI did not live-render first marker"
  real_session=$(jq -r '.grokCliSession // empty' "$real_config")
  [ -n "$real_session" ] || fail "optional real session id missing"

  stop_node_checked "$real_alias" real-first
  tmux kill-session -t test225-real-attach 2>/dev/null || true
  wait_gone "$real_socket" 600 || fail "optional real attach socket survived stop"
  wait "$NODE_PROCESS_PID" 2>/dev/null || true
  NODE_PROCESS_PID=""

  env -u ANET_AGENT_NODE_BIN GROK_BINARY="$real_bin" npm_config_offline=true \
    anet node start "$real_alias" >"$REAL_RESUME_LOG" 2>&1 &
  NODE_PROCESS_PID=$!
  wait_file "$real_socket" 600 || fail "optional real attach socket did not return"
  tmux new-session -d -s test225-real-resume-attach \
    "cd '$WORK' && env -u ANET_AGENT_NODE_BIN HOME='$HOME' PATH='$PATH' anet grok attach '$real_alias'"
  wait_pane test225-real-resume-attach 'attached to Grok TUI' "$REAL_RESUME_CAPTURE" 300 \
    || fail "optional real resume attach failed"

  second_id=$(curl -fsS -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg alias "$real_alias" --arg network "$NETWORK_ID" \
      '{alias:$alias,task:"Reply with exactly GROK_PREVIEW_REAL_225_B and nothing else.",from:"test225-driver",priority:"high",network_id:$network}')" \
    | jq -r '.task_id // .message_id // empty')
  for _ in $(seq 1 1800); do
    second_row=$(curl -fsS "$HUB/api/tasks?limit=80&network_id=$NETWORK_ID" \
      -H "Authorization: Bearer $USER_TOKEN" \
      | jq -c --arg id "$second_id" '.tasks[]? | select(.task_id == $id)' || true)
    jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_REAL_225_B"))' \
      <<<"$second_row" >/dev/null 2>&1 && break
    sleep 0.2
  done
  jq -e '.status == "replied" and (.result | contains("GROK_PREVIEW_REAL_225_B"))' \
    <<<"$second_row" >/dev/null 2>&1 || fail "optional real Grok resume task did not reply"
  wait_pane test225-real-resume-attach 'GROK_PREVIEW_REAL_225_B' "$REAL_RESUME_CAPTURE" 300 \
    || fail "optional real TUI did not live-render resume marker"
  [ "$(jq -r '.grokCliSession' "$real_config")" = "$real_session" ] \
    || fail "optional real stop/resume changed session"

  printf '%s\n%s\n' "$first_row" "$second_row" > /tmp/test225-real-hub-rows
  chmod 600 /tmp/test225-real-hub-rows
  jq -r '.result // ""' <<<"$first_row" >> /tmp/test225-hub-results
  jq -r '.result // ""' <<<"$second_row" >> /tmp/test225-hub-results

  scan_fixed_file /tmp/test225-real-patterns \
    /tmp/test225-candidate-extracted "$REPORT" "$REAL_START_LOG" "$REAL_RESUME_LOG" \
    "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" "$SERVER_LOG" /tmp/test225-real-hub-rows \
    || fail "real Grok auth scalar reached a tarball/report/log/live capture"
  scan_fixed_file /tmp/test225-real-patterns "$GROK_STATE" \
    || fail "real Grok auth scalar reached generated state"
  local real_pending="$WORK/.anet/nodes/$real_alias/pending-replies.json"
  scan_fixed_file /tmp/test225-real-patterns "$real_pending" \
    || fail "real Grok auth scalar reached pending replies"
  pass "optional authenticated real Grok package E2E: live render, reply, stop/resume, auth scan"

  stop_node_checked "$real_alias" real-resumed
  tmux kill-session -t test225-real-resume-attach 2>/dev/null || true
  wait "$NODE_PROCESS_PID" 2>/dev/null || true
  NODE_PROCESS_PID=""
  rm -f "$HOME/.grok/auth.json" "$HOME/.grok/agent_id" \
    /tmp/test225-real-patterns /tmp/test225-real-hub-rows
}

log "[L5] optional authenticated real Grok gate"
if [ "${RUN_REAL_GROK:-0}" = 1 ]; then
  run_real_gate
  REAL_STATUS=PASS
else
  REAL_STATUS='NOT_RUN (set RUN_REAL_GROK=1 and read-only TEST225_REAL_GROK_BIN/TEST225_REAL_GROK_AUTH mounts)'
  log "OPTIONAL: authenticated real Grok gate not requested"
fi

scan_fixed_file /tmp/test225-markers \
  /tmp/test225-candidate-extracted "$REPORT" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
  "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$RESUME_CAPTURE" "$GROK_STATE" "$PENDING" \
  "$WORK/.anet/nodes/$ALIAS" /tmp/test225-hub-results \
  "$LOCAL_REGISTRY_LOG" "$NPX_ENV_OBSERVATION" \
  || fail "final synthetic credential scan failed"
scan_fixed_file /tmp/test225-live-credentials \
  /tmp/test225-candidate-extracted "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
  "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$RESUME_CAPTURE" "$GROK_STATE" "$PENDING" "$REPORT" \
  /tmp/test225-hub-results "$LOCAL_REGISTRY_LOG" "$NPX_ENV_OBSERVATION" \
  || fail "final test Hub credential scan failed"
scan_fixed_file /tmp/test225-assistant-marker \
  /tmp/test225-candidate-extracted "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
  "$PENDING" "$REPORT" /tmp/test225-hub-results "$LOCAL_REGISTRY_LOG" \
  || fail "final assistant-generated credential scan failed"

log ""
log "Summary: PASS"
log "package_e2e=PASS"
log "real_authenticated_live=$REAL_STATUS"
log "source_escape_hatches=0"
log "npx_preview_fallback=PASS"
log "global_agent_node_resume=PASS"
log "external_publish_actions=0"
log "tmux_input_commands_issued=0"
while IFS= read -r tarball; do
  log "candidate_tarball_sha256=$(sha256sum "$tarball" | awk '{print $1}') file=$(basename "$tarball")"
done < <(find /candidate -maxdepth 1 -type f -name '*.tgz' | sort)
