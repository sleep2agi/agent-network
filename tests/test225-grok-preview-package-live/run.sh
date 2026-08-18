#!/usr/bin/env bash
set -euo pipefail
umask 077
source /test225/lib/safe-rm.sh

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
EXPECTED_GROK_LEADER_ENV_KEYS=/tmp/test225-expected-grok-leader-env-keys.json
EXPECTED_HELPER_ENV=/tmp/test225-expected-helper-env.json
EXPECTED_AGENT_NODE_ENV_KEYS=/tmp/test225-expected-agent-node-env-keys.json
EXPECTED_NPX_ENV_KEYS=/tmp/test225-expected-npx-env-keys.json
NPX_ENV_OBSERVATION=/tmp/test225-npx-env.json
FALLBACK_PID_SNAPSHOT=/tmp/test225-fallback-pids
USER_NPM_PREFIX=/tmp/test225-npm-global
GLOBAL_AGENT_NODE_ROOT="$USER_NPM_PREFIX/lib/node_modules/@sleep2agi/agent-node"
LOCAL_REGISTRY_LOG=/tmp/test225-local-registry.raw.log
SERVER_LOG=/tmp/test225-server.raw.log
START_LOG=/tmp/test225-start.raw.log
RELOAD_LOG=/tmp/test225-reload.raw.log
RESUME_LOG=/tmp/test225-resume.raw.log
ATTACH_CAPTURE=/tmp/test225-attach.raw.txt
RELOAD_CAPTURE=/tmp/test225-reload-attach.raw.txt
RESUME_CAPTURE=/tmp/test225-resume-attach.raw.txt
GLOBAL_OBSERVATIONS=/tmp/test225-global-observations.jsonl
GLOBAL_READINESS_OBSERVATIONS=/tmp/test225-global-readiness.jsonl
REAL_START_LOG=/tmp/test225-real-start.raw.log
REAL_RESUME_LOG=/tmp/test225-real-resume.raw.log
REAL_CAPTURE=/tmp/test225-real-attach.raw.txt
REAL_RESUME_CAPTURE=/tmp/test225-real-resume-attach.raw.txt
REGISTER_LOG=/tmp/test225-register.raw.log
CREATE_LOG=/tmp/test225-create.raw.log
HEADLESS_CREATE_LOG=/tmp/test225-headless-create.raw.log
REAL_CREATE_LOG=/tmp/test225-real-create.raw.log
INFO_LOG=/tmp/test225-info.raw.log
STOP_LOG_DIR=/tmp/test225-stop-logs
TUI_INVENTORY_DIAGNOSTIC="$ARTIFACT_DIR/test225-tui-inventory-diagnostic.json"
TUI_INVENTORY_EVIDENCE="$ARTIFACT_DIR/test225-tui-inventory-evidence.json"
REAL_TURN_DIAGNOSTIC="$ARTIFACT_DIR/test225-real-turn-diagnostic.json"
AUTH_EVIDENCE_DIAGNOSTIC="$ARTIFACT_DIR/test225-auth-evidence-diagnostic.json"
REAL_AUTH_PATTERNS=/tmp/test225-real-patterns
REAL_AUTH_UNSAFE_PATTERNS=/tmp/test225-real-unsafe-patterns
REAL_AUTH_METADATA_MANIFEST=/tmp/test225-real-auth-metadata.json
REAL_STATE_HOME=""
REAL_LEADER_SOCKET=""
REAL_ATTACH_SOCKET=""
REAL_SESSION_ID=""
REAL_CWD=""

# The package gate must observe native shared-TUI rendering. It may not make a
# trust prompt or network turn pass by typing into tmux on the user's behalf.
if grep -Eq 'tmux[[:space:]]+(send[-]keys|paste[-]buffer|load[-]buffer)' "$0"; then
  printf 'FAIL: test225 contains a forbidden tmux input command\n' >&2
  exit 1
fi
GLOBAL_INSTALL_LOG=/tmp/test225-global-install.raw.log
export HOME
export PATH="$USER_NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
export COMMHUB_DB=/tmp/test225-commhub.db
export HOST=127.0.0.1
export PORT="$HUB_PORT"

# Cleanup removes every /tmp/test225-* private path. Evidence must live on a
# separately mounted root so neither a success nor a failure can erase it.
ARTIFACT_ABS=$(realpath -m "$ARTIFACT_DIR")
REPORT_ABS=$(realpath -m "$REPORT")
HOME_ABS=$(realpath -m "$HOME")
WORK_ABS=$(realpath -m "$WORK")
case "$ARTIFACT_ABS" in
  "$HOME_ABS"|"$HOME_ABS"/*|"$WORK_ABS"|"$WORK_ABS"/*|/tmp/test225-*)
    printf 'FAIL: artifact directory overlaps test225 private cleanup roots\n' >&2
    exit 1
    ;;
esac
case "$REPORT_ABS" in
  "$HOME_ABS"|"$HOME_ABS"/*|"$WORK_ABS"|"$WORK_ABS"/*|/tmp/test225-*)
    printf 'FAIL: report path overlaps test225 private cleanup roots\n' >&2
    exit 1
    ;;
esac
PRIVATE_SENTINEL_ABS=/tmp/test225-private-sentinel
if [ "$ARTIFACT_ABS" = / ] \
  || [[ "$HOME_ABS" == "$ARTIFACT_ABS/"* ]] \
  || [[ "$WORK_ABS" == "$ARTIFACT_ABS/"* ]] \
  || [[ "$PRIVATE_SENTINEL_ABS" == "$ARTIFACT_ABS/"* ]]; then
  printf 'FAIL: artifact directory is an ancestor of test225 private cleanup roots\n' >&2
  exit 1
fi
# Private scratch data stays under /tmp; closed diagnostics may additionally
# be removed only from the already-validated mounted artifact root.
SAFE_RM_ALLOW_PREFIXES="/tmp/ $ARTIFACT_ABS/"
export SAFE_RM_ALLOW_PREFIXES

# Remove stale optional evidence at the first safe point, before report
# creation or any executable gate. A nonzero EXIT also removes a newly written
# success artifact so an incomplete overall run cannot leave it unbound.
rm -f -- "$TUI_INVENTORY_DIAGNOSTIC" "$TUI_INVENTORY_EVIDENCE" \
  "$REAL_TURN_DIAGNOSTIC" "$AUTH_EVIDENCE_DIAGNOSTIC"

mkdir -p "$ARTIFACT_DIR" "$HOME/.grok" "$WORK" "$STOP_LOG_DIR"
chmod 700 "$HOME" "$HOME/.grok" "$WORK" "$STOP_LOG_DIR"
[ ! -e "$HOME/.grok/auth.json" ] \
  || { printf 'FAIL: deterministic test home unexpectedly contains auth state\n' >&2; exit 1; }
node /test225/artifact-report.mjs "$REPORT" \
  || { printf 'FAIL: could not atomically create a private report\n' >&2; exit 1; }

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

PROJECT_SANDBOX_PLACEHOLDER_NAMES=(.grok .claude .cursor .mcp.json .envrc)
assert_no_project_sandbox_placeholders() {
  local name target
  for name in "${PROJECT_SANDBOX_PLACEHOLDER_NAMES[@]}"; do
    target="$WORK/$name"
    [ ! -e "$target" ] && [ ! -L "$target" ] \
      || fail "post-stop cleanup retained pinned project sandbox placeholder: $name"
  done
}

SOURCE_COMMIT=${TEST225_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || fail "SOURCE_COMMIT must bind this gate to one full lowercase Git SHA"
ARCHIVE_COMMIT=$(tr -d '\r\n' </test225/source-commit.txt)
[[ "$ARCHIVE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || fail "test225 build context must come from git archive, not a mutable checkout"
[ "$ARCHIVE_COMMIT" = "$SOURCE_COMMIT" ] \
  || fail "SOURCE_COMMIT does not match the archived build context"
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

assert_no_unix_listener() {
  local socket_path=$1
  node - "$socket_path" <<'NODE'
const fs = require("node:fs");
const wanted = process.argv[2];
const active = fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1).some((line) => {
  const match = line.match(/^\s*\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/);
  return match && match[1] === "00010000" && match[2] === "0001"
    && match[3] === "01" && (match[5] || "") === wanted;
});
process.exit(active ? 1 : 0);
NODE
}

snapshot_unix_listener_owner() {
  local socket_path=$1 output=$2
  node - "$socket_path" "$output" <<'NODE'
const fs = require("node:fs");
const socketPath = process.argv[2];
const output = process.argv[3];
const rows = fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)
  .map((line) => line.match(/^\s*\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/))
  .filter((match) => match && match[1] === "00010000" && match[2] === "0001"
    && match[3] === "01" && (match[5] || "") === socketPath);
if (rows.length !== 1) process.exit(2);
const inode = rows[0][4];
const target = `socket:[${inode}]`;
const holders = [];
for (const entry of fs.readdirSync("/proc", {withFileTypes: true})) {
  if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
  let fds;
  try { fds = fs.readdirSync(`/proc/${entry.name}/fd`); } catch { continue; }
  if (fds.some((fd) => {
    try { return fs.readlinkSync(`/proc/${entry.name}/fd/${fd}`) === target; } catch { return false; }
  })) holders.push(Number(entry.name));
}
if (holders.length !== 1) process.exit(3);
const pid = holders[0];
const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
const close = raw.lastIndexOf(")");
const fields = raw.slice(close + 2).trim().split(/\s+/);
const startTime = fields[19];
if (!/^\d+$/.test(startTime || "")) process.exit(4);
fs.writeFileSync(output, JSON.stringify({pid,startTime,inode}) + "\n", {mode: 0o600});
fs.chmodSync(output, 0o600);
NODE
}

assert_unix_listener_owner_gone() {
  local identity_file=$1 socket_path=$2
  node - "$identity_file" "$socket_path" <<'NODE'
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const socketPath = process.argv[3];
let sameGeneration = false;
try {
  const raw = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
  const close = raw.lastIndexOf(")");
  sameGeneration = raw.slice(close + 2).trim().split(/\s+/)[19] === identity.startTime;
} catch {}
const listenerRemains = fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1).some((line) => {
  const match = line.match(/^\s*\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/);
  return match && match[1] === "00010000" && match[2] === "0001" && match[3] === "01"
    && (match[4] === identity.inode || (match[5] || "") === socketPath);
});
process.exit(sameGeneration || listenerRemains ? 1 : 0);
NODE
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

assert_lock_holder_envs_exact() {
  local input=$1 pid start kind current
  while read -r pid start kind; do
    [ "$kind" = lock-holder ] || continue
    current=$(process_starttime "$pid" 2>/dev/null || true)
    [ -n "$current" ] && [ "$current" = "$start" ] \
      || fail "lock-holder disappeared before its environment was verified"
    node - "$pid" "$EXPECTED_HELPER_ENV" <<'NODE' \
      || fail "lock-holder environment differs from the exact reviewed object"
const fs = require("node:fs");
const pid = process.argv[2];
const expected = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const actual = {};
for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
  if (!entry) continue;
  const separator = entry.indexOf("=");
  if (separator < 1) process.exit(2);
  actual[entry.slice(0, separator)] = entry.slice(separator + 1);
}
const canonical = (value) => JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
));
if (canonical(actual) !== canonical(expected)) process.exit(1);
NODE
  done <"$input"
}

assert_installed_candidate_runtime() {
  local alias=$1 label=$2 output=$3 pid_file pid
  local -a argv=()
  pid_file="$WORK/.anet/nodes/$alias/.pid"
  [ -f "$pid_file" ] || fail "$label start did not record a runtime PID"
  pid=$(<"$pid_file")
  while IFS= read -r -d '' arg; do argv+=("$arg"); done <"/proc/$pid/cmdline"
  [ "${#argv[@]}" -ge 2 ] || fail "$label pidfile has no executable argv"
  # npm's generated bin shim invokes `node` through PATH, so argv[0] may be
  # the bare word "node" rather than an absolute path.  Bind the recorded PID
  # to the executable the kernel actually runs instead of resolving argv[0]
  # relative to the test working directory.
  [ "$(readlink -f "/proc/$pid/exe")" = "$(readlink -f "$(command -v node)")" ] \
    || fail "$label pidfile identifies a wrapper instead of Node"
  [ "$(readlink -f "${argv[1]}")" = "$GLOBAL_AGENT_NODE_ROOT/dist/cli.js" ] \
    || fail "$label did not launch the installed candidate entrypoint"
  [ "$(matching_process_count 'npm exec @sleep2agi/agent-node@preview')" -eq 0 ] \
    || fail "$label left an npm resolver wrapper running"
  grep -Fq '[anet] using installed agent-node with Grok co-presence capability.' "$output" \
    || fail "$label did not report the installed candidate"
  grep -Eq 'fetching @sleep2agi/agent-node@preview|using @sleep2agi/agent-node@preview instead' "$output" \
    && fail "$label unexpectedly used an npx preview fallback"
  # The negative grep above returns 1 on the success path. Do not let that
  # expected result become the function status under `set -e`.
  return 0
}

assert_fake_observations_exact() {
  local observations=${1:-$FAKE_OBSERVATIONS}
  if jq -e -s --slurpfile expected "$EXPECTED_GROK_ENV_KEYS" \
    --slurpfile expectedPty "$EXPECTED_GROK_PTY_ENV_KEYS" \
    --slurpfile expectedLeader "$EXPECTED_GROK_LEADER_ENV_KEYS" \
    --slurpfile expectedParent "$EXPECTED_AGENT_NODE_ENV_KEYS" \
    'any(.[]; .kind == "version") and any(.[]; .kind == "help")
    and any(.[]; .kind == "inspect") and any(.[]; .kind == "spawn")
    and any(.[]; .kind == "leader")
    and all(.[]; (.forbiddenKeys | length) == 0 and .markerValueObserved == false
      and .changelogOfflineExact == true and .leaderLogDisabledExact == true
      and (if .kind == "leader"
        then .envKeys == $expectedLeader[0]
          and .ownerMarkerValid == true
          and .socketEnvExact == true
        elif .kind == "spawn"
        then .envKeys == $expectedPty[0] and .terminalEnvExpected == true
          and .parentPidMatches == true
          and .folderTrustExact == true
          and .folderTrustMode == 384
          and .folderTrustCount == 1
          and .selectedSandboxProfileMatched == true
          and .sandboxEnvMatchesArgv == true
          and .authPathSandboxDenied == false
          and .requiredDenyToolsPresent == true
          and .requiredProtectedPathDeniesPresent == true
          and .agentProfileExact == true
          and .tuiFlagsExact == true
          and .projectSandboxPlaceholdersExact == true
          and .parentEnvKeys == $expectedParent[0]
          and (.parentForbiddenKeys | length) == 0
          and .parentMarkerValueObserved == false
        else .envKeys == $expected[0]
        end))' \
    "$observations" >/dev/null; then
    return 0
  fi
  # Key names only: preserve a useful, value-free diagnostic without
  # disclosing any child environment values into the report.
  jq -c -s --slurpfile expected "$EXPECTED_GROK_ENV_KEYS" \
    --slurpfile expectedPty "$EXPECTED_GROK_PTY_ENV_KEYS" \
    --slurpfile expectedLeader "$EXPECTED_GROK_LEADER_ENV_KEYS" \
    --slurpfile expectedParent "$EXPECTED_AGENT_NODE_ENV_KEYS" \
    'map(. as $row | (if .kind == "leader" then $expectedLeader[0]
        elif .kind == "spawn" then $expectedPty[0] else $expected[0] end) as $want
      | {kind,missing:($want - .envKeys),extra:(.envKeys - $want),forbiddenKeys,markerValueObserved,
          ownerMarkerValid,socketEnvExact,terminalEnvExpected,parentPidMatches,selectedSandboxProfileMatched,sandboxEnvMatchesArgv,authPathSandboxDenied,
          requiredDenyToolsPresent,requiredProtectedPathDeniesPresent,agentProfileExact,tuiFlagsExact,projectSandboxPlaceholdersExact,
          parentMissing:($expectedParent[0] - (.parentEnvKeys // [])),
          parentExtra:((.parentEnvKeys // []) - $expectedParent[0]),
          parentForbiddenKeys,parentMarkerValueObserved})' \
    "$observations" | tee -a "$REPORT"
  fail "candidate Grok probe/PTY env differs from the exact reviewed key set"
}

capture_stopped_pane() {
  local session=$1 output=$2 dead=0
  for _ in $(seq 1 300); do
    dead=$(tmux display-message -p -t "$session":0.0 '#{pane_dead}' 2>/dev/null || printf missing)
    [ "$dead" = 1 ] && break
    sleep 0.1
  done
  [ "$dead" = 1 ] || fail "attached TUI pane did not reach a stopped state: $session"
  tmux capture-pane -p -J -t "$session":0.0 -S -400 >"$output" 2>/dev/null \
    || fail "could not capture stopped TUI pane: $session"
  chmod 600 "$output"
}

file_mode() {
  stat -c '%a' "$1"
}

scan_fixed_file() {
  local patterns=$1 rc
  shift
  [ -s "$patterns" ] || return 0
  for target in "$@"; do
    [ -e "$target" ] || [ -L "$target" ] || continue
    if [ -d "$target" ]; then
      # Owner-bound runtime sockets now live below the scanned state root.
      # They have no persistent byte content and are validated separately by
      # the socket identity/metadata gate; scan every regular state payload
      # while preventing GNU grep from turning a live socket into rc=2.
      if grep -R --devices=skip -F -f "$patterns" "$target" >/dev/null 2>&1; then
        return 1
      else
        rc=$?
        [ "$rc" -eq 1 ] || return 2
      fi
    elif grep -F -f "$patterns" "$target" >/dev/null 2>&1; then
      return 1
    else
      rc=$?
      [ "$rc" -eq 1 ] || return 2
    fi
  done
  return 0
}

scan_pattern_file_valid() {
  local candidate=$1 mode links owner
  [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -s "$candidate" ] || return 1
  mode=$(stat -c %a -- "$candidate" 2>/dev/null) || return 1
  links=$(stat -c %h -- "$candidate" 2>/dev/null) || return 1
  owner=$(stat -c %u -- "$candidate" 2>/dev/null) || return 1
  [ "$mode" = 600 ] && [ "$links" = 1 ] && [ "$owner" = "$(id -u)" ]
}

real_turn_scan_inputs_valid() {
  local patterns
  for patterns in /tmp/test225-markers /tmp/test225-live-credentials \
    "$REAL_AUTH_PATTERNS" "$REAL_AUTH_UNSAFE_PATTERNS" \
    "$REAL_AUTH_METADATA_MANIFEST"; do
    scan_pattern_file_valid "$patterns" || return 1
  done
}

refresh_real_auth_patterns() {
  local auth_path=$1
  [ -r "$auth_path" ] || fail "real auth scalar refresh source is not readable"
  # One stable private-file read derives both the full deny set and an exact
  # scope-bound metadata manifest. The manifest is never persisted as evidence.
  node /test225/auth-evidence-diagnostic.mjs refresh-patterns \
    "$auth_path" "$REAL_AUTH_PATTERNS" "$REAL_AUTH_UNSAFE_PATTERNS" \
    "$REAL_AUTH_METADATA_MANIFEST" \
    || fail "could not derive real auth scalar scan patterns"
  real_turn_scan_inputs_valid \
    || fail "derived real auth scan inputs are not closed owner-only files"
}

persist_auth_evidence_diagnostic() {
  local temporary=$1
  real_turn_scan_inputs_valid \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic scan inputs are not owner-only"; }
  node /test225/auth-evidence-diagnostic.mjs validate "$temporary" \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic failed closed-schema validation"; }
  scan_fixed_file /tmp/test225-markers "$temporary" \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic retained a synthetic marker"; }
  scan_fixed_file /tmp/test225-live-credentials "$temporary" \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic retained a Hub credential"; }
  scan_fixed_file /tmp/test225-real-patterns "$temporary" \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic retained an auth scalar"; }
  real_turn_scan_inputs_valid \
    || { rm -f -- "$temporary"; fail "auth evidence diagnostic scan inputs changed before persistence"; }
  mv -f -- "$temporary" "$AUTH_EVIDENCE_DIAGNOSTIC"
  chmod 600 "$AUTH_EVIDENCE_DIAGNOSTIC"
  node /test225/auth-evidence-diagnostic.mjs validate "$AUTH_EVIDENCE_DIAGNOSTIC" \
    || fail "persisted auth evidence diagnostic is not closed and owner-only"
  scan_fixed_file /tmp/test225-markers "$AUTH_EVIDENCE_DIAGNOSTIC" \
    || fail "persisted auth evidence diagnostic retained a synthetic marker"
  scan_fixed_file /tmp/test225-live-credentials "$AUTH_EVIDENCE_DIAGNOSTIC" \
    || fail "persisted auth evidence diagnostic retained a Hub credential"
  scan_fixed_file /tmp/test225-real-patterns "$AUTH_EVIDENCE_DIAGNOSTIC" \
    || fail "persisted auth evidence diagnostic retained an auth scalar"
  real_turn_scan_inputs_valid \
    || fail "auth evidence diagnostic scan inputs changed after persistence"
  log "diagnostic: auth_evidence phase=$(jq -r '.phase' "$AUTH_EVIDENCE_DIAGNOSTIC") outcome=$(jq -r '.scanOutcome' "$AUTH_EVIDENCE_DIAGNOSTIC") artifact=$(basename "$AUTH_EVIDENCE_DIAGNOSTIC") detail_withheld=true"
}

run_real_auth_evidence_gate() {
  local phase=$1 expected_state_home=$2 expected_session_id=$3 expected_cwd=$4
  local expected_leader=$5 expected_attach=$6 decision outcome temporary
  local -a scan_args=()
  shift 6
  [ $(( $# % 2 )) -eq 0 ] || fail "auth evidence gate received an incomplete role/target pair"
  while [ "$#" -gt 0 ]; do
    scan_args+=("$1" "$2")
    shift 2
  done
  if [ ! -s /tmp/test225-real-patterns ] && [ "${RUN_REAL_GROK:-0}" != 1 ]; then
    rm -f -- "$AUTH_EVIDENCE_DIAGNOSTIC"
    return 0
  fi
  real_turn_scan_inputs_valid \
    || fail "auth evidence gate scan inputs are missing, empty, or not owner-only"
  temporary="$ARTIFACT_DIR/.test225-auth-evidence-diagnostic.tmp.$$.$RANDOM"
  rm -f -- "$temporary" "$AUTH_EVIDENCE_DIAGNOSTIC"
  node /test225/auth-evidence-diagnostic.mjs scan "$temporary" "$phase" \
    "$REAL_AUTH_PATTERNS" "$REAL_AUTH_METADATA_MANIFEST" "$HOME/.grok/agent_id" \
    "$expected_state_home" "$expected_session_id" "$expected_cwd" \
    "$expected_leader" "$expected_attach" "${scan_args[@]}" \
    || fail "could not build closed auth evidence target classification"
  node /test225/auth-evidence-diagnostic.mjs validate "$temporary" \
    || { rm -f -- "$temporary"; fail "auth evidence target classification is not closed"; }
  outcome=$(jq -r '.scanOutcome' "$temporary")
  decision=$(node /test225/auth-evidence-gate-policy.mjs classify preview "$temporary") \
    || { rm -f -- "$temporary"; fail "auth evidence release policy rejected its closed input"; }
  real_turn_scan_inputs_valid \
    || { rm -f -- "$temporary"; fail "auth evidence gate scan inputs changed during classification"; }
  if [ "$decision" = pass ]; then
    [ "$outcome" = clean ] \
      || { rm -f -- "$temporary"; fail "auth evidence release policy passed a non-clean scan"; }
    log "PASS: auth_evidence phase=$phase scanOutcome:clean"
    rm -f -- "$temporary" "$AUTH_EVIDENCE_DIAGNOSTIC"
    return 0
  fi
  if [ "$decision" = warning ]; then
    persist_auth_evidence_diagnostic "$temporary"
    log "WARNING: auth_evidence phase=$phase scanOutcome:$outcome preview_structure_warning=true"
    return 0
  fi
  [ "$decision" = fatal ] \
    || { rm -f -- "$temporary"; fail "auth evidence release policy returned an unknown decision"; }
  persist_auth_evidence_diagnostic "$temporary"
  fail "real auth evidence scan failed; closed target-role diagnostic retained"
}

inventory_result_metadata_valid() {
  local candidate=$1 mode links owner
  [ -f "$candidate" ] && [ ! -L "$candidate" ] || return 1
  mode=$(stat -c %a -- "$candidate" 2>/dev/null) || return 1
  links=$(stat -c %h -- "$candidate" 2>/dev/null) || return 1
  owner=$(stat -c %u -- "$candidate" 2>/dev/null) || return 1
  [ "$mode" = 600 ] && [ "$links" = 1 ] && [ "$owner" = "$(id -u)" ]
}

select_unique_status_row() {
  local alias=$1
  jq -ce --arg alias "$alias" '
    def current_wrapper:
      type == "object"
      and ((keys | sort) == ["ok","sessions","summary"])
      and .ok == true
      and (.sessions | type == "array")
      and (.summary
        | type == "object"
        and ((keys | sort) == ["idle","offline","total","working"])
        and all(.[]; type == "number" and . >= 0 and floor == .));
    def status_rows:
      if type == "array" then .
      elif current_wrapper then .sessions
      else error("unexpected /api/status payload")
      end;
    status_rows
    | if all(.[];
        type == "object"
        and (.alias | type == "string")
        and (.status | type == "string")
        and (.agent == null or (.agent | type == "string")))
      then .
      else error("invalid /api/status session row")
      end
    | map(select(.alias == $alias))
    | if length == 1 then .[0]
      elif length == 0 then error("status alias missing")
      else error("status alias duplicated")
      end
  '
}

assert_status_selector_accepts() {
  local label=$1 payload=$2 expected_status=${3:-idle}
  local output=/tmp/test225-status-selector-output
  rm -f -- "$output"
  printf '%s' "$payload" | select_unique_status_row selector-target >"$output" 2>/dev/null \
    || fail "status selector rejected $label"
  jq -e --arg status "$expected_status" \
    '.alias == "selector-target" and .status == $status' "$output" >/dev/null \
    || fail "status selector returned the wrong row for $label"
  rm -f -- "$output"
}

assert_status_selector_rejects() {
  local label=$1 payload=$2 output=/tmp/test225-status-selector-output
  rm -f -- "$output"
  if printf '%s' "$payload" | select_unique_status_row selector-target >"$output" 2>/dev/null; then
    rm -f -- "$output"
    fail "status selector accepted $label"
  fi
  [ ! -s "$output" ] || {
    rm -f -- "$output"
    fail "status selector emitted partial output for $label"
  }
  rm -f -- "$output"
}

inventory_result_valid() {
  local candidate=$1 expected_status=$2
  inventory_result_metadata_valid "$candidate" || return 1
  node /test225/inventory-diagnostic.mjs validate "$candidate" >/dev/null 2>&1 \
    || return 1
  [ "$(jq -r '.status' "$candidate" 2>/dev/null)" = "$expected_status" ]
}

inventory_result_scan() {
  local candidate=$1 patterns rc
  for patterns in /tmp/test225-markers /tmp/test225-live-credentials /tmp/test225-real-patterns; do
    if scan_fixed_file "$patterns" "$candidate"; then rc=0; else rc=$?; fi
    case "$rc" in
      0) ;;
      1) return 10 ;;
      *) return 11 ;;
    esac
  done
  return 0
}

make_inventory_fallback() {
  local output=$1 category=$2
  rm -f -- "$output"
  node /test225/inventory-diagnostic.mjs fallback "$output" "$category" \
    >/dev/null 2>&1 || return 1
  inventory_result_valid "$output" failed
}

persist_inventory_diagnostic() {
  local candidate=$1 destination=$2 temporary
  temporary="$ARTIFACT_DIR/.test225-tui-inventory-diagnostic.tmp.$$.$RANDOM"
  rm -f -- "$temporary"
  install -m 600 -- "$candidate" "$temporary" || return 1
  inventory_result_valid "$temporary" "$(jq -r '.status' "$candidate")" || {
    rm -f -- "$temporary"
    return 1
  }
  mv -f -- "$temporary" "$destination" || {
    rm -f -- "$temporary"
    return 1
  }
  inventory_result_metadata_valid "$destination"
}

run_tui_inventory_gate() {
  local real_bin=$1 profile_fixture=$2
  local result_dir result_file fallback_file probe_rc expected_status=failed
  local candidate_valid=0 scan_rc=12 fallback_category selected phase category

  rm -f -- "$TUI_INVENTORY_DIAGNOSTIC" "$TUI_INVENTORY_EVIDENCE"
  result_dir=$(mktemp -d /tmp/test225-tui-inventory-result.XXXXXX) \
    || fail "could not create private TUI inventory result directory"
  chmod 700 "$result_dir"
  [ -d "$result_dir" ] && [ ! -L "$result_dir" ] \
    && [ "$(stat -c %a "$result_dir")" = 700 ] \
    && [ "$(stat -c %u "$result_dir")" = "$(id -u)" ] \
    || fail "TUI inventory result directory is not owner-only"
  result_file="$result_dir/result.json"
  fallback_file="$result_dir/fallback.json"

  # This boundary is strictly keyless. Only the already-validated synthetic
  # and Hub scan sets may exist; real-auth scalar derivation belongs solely to
  # run_real_gate after its read-only auth precondition.
  scan_pattern_file_valid /tmp/test225-markers \
    || fail "keyless inventory gate lacks its owner-only synthetic scan set"
  scan_pattern_file_valid /tmp/test225-live-credentials \
    || fail "keyless inventory gate lacks its owner-only Hub scan set"
  [ ! -e "$REAL_AUTH_PATTERNS" ] \
    && [ ! -e "$REAL_AUTH_UNSAFE_PATTERNS" ] \
    && [ ! -e "$REAL_AUTH_METADATA_MANIFEST" ] \
    || fail "keyless inventory gate unexpectedly observed a real-auth scan set"
  if node /test225/tui-tool-inventory-probe.mjs \
    "$real_bin" "$profile_fixture" "$result_file" >/dev/null 2>&1; then
    probe_rc=0
    expected_status=passed
  else
    probe_rc=$?
  fi

  if inventory_result_valid "$result_file" "$expected_status"; then
    candidate_valid=1
    if inventory_result_scan "$result_file"; then scan_rc=0; else scan_rc=$?; fi
  fi

  if [ "$probe_rc" -eq 0 ] && [ "$candidate_valid" -eq 1 ] && [ "$scan_rc" -eq 0 ]; then
    persist_inventory_diagnostic "$result_file" "$TUI_INVENTORY_EVIDENCE" \
      || fail "could not persist the closed keyless inventory evidence"
    safe_rm_rf "$result_dir"
    rm -f -- "$TUI_INVENTORY_DIAGNOSTIC"
    inventory_result_valid "$TUI_INVENTORY_EVIDENCE" passed \
      || fail "persisted keyless inventory evidence failed closed-schema validation"
    return 0
  fi

  if [ "$candidate_valid" -eq 1 ] && [ "$expected_status" = failed ] \
    && [ "$scan_rc" -eq 0 ]; then
    selected=$result_file
  else
    case "$scan_rc" in
      10) fallback_category=diagnostic_rejected ;;
      11) fallback_category=diagnostic_scan_error ;;
      *) fallback_category=invalid_or_missing_result ;;
    esac
    make_inventory_fallback "$fallback_file" "$fallback_category" \
      || fail "could not create a closed TUI inventory fallback diagnostic"
    # A scanner read error has already failed closed. The fallback is generated
    # from a fixed schema with no variable strings; otherwise require all three
    # scans to pass before persistence.
    if [ "$fallback_category" != diagnostic_scan_error ]; then
      inventory_result_scan "$fallback_file" \
        || fail "closed TUI inventory fallback failed credential scanning"
    fi
    selected=$fallback_file
  fi

  persist_inventory_diagnostic "$selected" "$TUI_INVENTORY_DIAGNOSTIC" \
    || fail "could not persist the closed TUI inventory diagnostic"
  rm -f -- "$TUI_INVENTORY_EVIDENCE"
  phase=$(jq -r '.phase' "$TUI_INVENTORY_DIAGNOSTIC")
  category=$(jq -r '.category' "$TUI_INVENTORY_DIAGNOSTIC")
  safe_rm_rf "$result_dir"
  log "diagnostic: tui_inventory phase=$phase category=$category artifact=$(basename "$TUI_INVENTORY_DIAGNOSTIC")"
  fail "pinned Grok TUI did not satisfy the fixed preview tool inventory gate"
}

fail_if_task_terminal_error() {
  local label=$1 row=$2 phase=$3 started_ms=$4
  local status category subcategory size_bucket elapsed_ms temporary
  status=$(jq -r '.status // ""' <<<"$row")
  case "$status" in
    failed|cancelled|expired) ;;
    *) return 0 ;;
  esac
  # Keep the raw Hub result in shell/process memory only. The helper emits a
  # fixed value-free enum and bounded metadata; it never copies or hashes the
  # model/runtime body, paths, PIDs, session IDs, or task IDs.
  elapsed_ms=$(( $(date +%s%3N) - started_ms ))
  temporary=$(mktemp "$ARTIFACT_DIR/.test225-real-turn-diagnostic.tmp.XXXXXX") \
    || fail "$label could not create a private turn diagnostic temporary"
  if ! printf '%s' "$row" \
    | jq -j '.result // "" | if type == "string" then . else tojson end' \
    | node /test225/failure-diagnostic.mjs "$phase" "$status" "$elapsed_ms" >"$temporary"; then
    rm -f -- "$temporary"
    fail "$label could not create a closed turn diagnostic"
  fi
  chmod 600 "$temporary"
  [ -s "$temporary" ] && inventory_result_metadata_valid "$temporary" || {
    rm -f -- "$temporary"
    fail "$label produced turn diagnostic with invalid private-file metadata"
  }
  jq -e '
    (keys | sort) == ["elapsedBucket","failureCode","failureSubcode","phase","resultSizeBucket","status","v"]
    and .v == 2
    and (.phase == "first_task" or .phase == "resume_task")
    and (.status == "failed" or .status == "cancelled" or .status == "expired")
    and (.failureCode | IN(
      "approval_boundary","correlation","input_validation","jsonl_tail",
      "leader_lifecycle","native_outcome","runtime_closed","service_or_model",
      "spawn_audit","timeout","tui_exit","unknown"
    ))
    and (.failureSubcode | IN(
      "none","unknown",
      "chat.stat.missing_after_arm","chat.stat.identity_changed",
      "chat.stat.size_regressed","chat.stat.non_regular","chat.stat.owner_mismatch",
      "chat.stat.io_other","chat.open.io_other","chat.fstat.non_regular",
      "chat.fstat.io_other","chat.read.io_other","chat.read.state_invariant",
      "chat.close.io_other","chat.reduce.state_invariant",
      "events.stat.missing_after_arm","events.stat.identity_changed",
      "events.stat.size_regressed","events.stat.non_regular","events.stat.owner_mismatch",
      "events.stat.io_other","events.open.io_other","events.fstat.non_regular",
      "events.fstat.io_other","events.read.io_other","events.read.state_invariant",
      "events.close.io_other","events.reduce.state_invariant",
      "events.lifecycle.state_invariant","combined.flush.state_invariant"
    ))
    and (
      if .failureCode == "jsonl_tail" then .failureSubcode != "none"
      elif .failureCode == "unknown" then .failureSubcode == "unknown"
      else .failureSubcode == "none"
      end
    )
    and (.resultSizeBucket | IN("empty","lt_256","lt_1024","lt_2049"))
    and (.elapsedBucket | IN("lt_30s","lt_120s","lt_600s","gte_600s"))
  ' "$temporary" >/dev/null || {
    rm -f -- "$temporary"
    fail "$label produced an invalid closed turn diagnostic"
  }
  real_turn_scan_inputs_valid || {
    rm -f -- "$temporary"
    fail "$label diagnostic scan inputs are missing, empty, or not owner-only"
  }
  scan_fixed_file /tmp/test225-markers "$temporary" \
    || { rm -f -- "$temporary"; fail "$label diagnostic retained a synthetic marker"; }
  scan_fixed_file /tmp/test225-live-credentials "$temporary" \
    || { rm -f -- "$temporary"; fail "$label diagnostic retained a Hub credential"; }
  scan_fixed_file /tmp/test225-real-patterns "$temporary" \
    || { rm -f -- "$temporary"; fail "$label diagnostic retained an auth scalar"; }
  mv -f -- "$temporary" "$REAL_TURN_DIAGNOSTIC"
  [ -s "$REAL_TURN_DIAGNOSTIC" ] \
    && inventory_result_metadata_valid "$REAL_TURN_DIAGNOSTIC" \
    || fail "$label persisted diagnostic metadata is not owner-only"
  real_turn_scan_inputs_valid \
    || fail "$label persisted diagnostic scan inputs became invalid"
  scan_fixed_file /tmp/test225-markers "$REAL_TURN_DIAGNOSTIC" \
    || fail "$label persisted diagnostic retained a synthetic marker"
  scan_fixed_file /tmp/test225-live-credentials "$REAL_TURN_DIAGNOSTIC" \
    || fail "$label persisted diagnostic retained a Hub credential"
  scan_fixed_file /tmp/test225-real-patterns "$REAL_TURN_DIAGNOSTIC" \
    || fail "$label persisted diagnostic retained an auth scalar"
  category=$(jq -r '.failureCode' "$REAL_TURN_DIAGNOSTIC")
  subcategory=$(jq -r '.failureSubcode' "$REAL_TURN_DIAGNOSTIC")
  size_bucket=$(jq -r '.resultSizeBucket' "$REAL_TURN_DIAGNOSTIC")
  log "diagnostic: $label terminal_status=$status category=$category subcategory=$subcategory result_size_bucket=$size_bucket artifact=$(basename "$REAL_TURN_DIAGNOSTIC") detail_withheld=true"
  fail "$label reached a terminal error before a valid reply"
}

stop_node_checked() {
  local alias label output
  alias=$1
  label=$2
  output="$STOP_LOG_DIR/${label}.raw.log"
  if ! anet node stop "$alias" >"$output" 2>&1; then
    fail_with_private_log "node stop failed for $label" "$output"
  fi
  scan_fixed_file /tmp/test225-markers "$output" \
    || fail "node stop output exposed a synthetic credential marker for $label"
  scan_fixed_file /tmp/test225-live-credentials "$output" \
    || fail "node stop output exposed a Hub credential for $label"
  scan_fixed_file /tmp/test225-real-patterns "$output" \
    || fail "node stop output exposed a real auth scalar for $label"
}

NODE_PROCESS_PID=""
HEADLESS_PID=""
SERVER_PID=""
REGISTRY_PID=""
cleanup() {
  local original_rc=$? cleanup_failed=0 auth_diagnostic_valid=1 pid start state ppid alias config path
  local identity_before identity_after matched real_bin job_identity job_ppid job_state job_start
  local pid_set=/tmp/test225-cleanup-pids
  local fresh_set=/tmp/test225-cleanup-fresh
  trap - EXIT
  set +e
  : >"$pid_set"

  # One stat read yields a coherent ppid/state/starttime tuple. A second read
  # around cmdline access prevents PID-reuse splicing.
  proc_identity() {
    local candidate=$1 raw tail
    [ -r "/proc/$candidate/stat" ] || return 1
    raw=$(<"/proc/$candidate/stat")
    tail=${raw##*) }
    set -- $tail
    [ "$#" -ge 20 ] || return 1
    printf '%s %s %s\n' "$2" "$1" "${20}"
  }

  append_cleanup_identity() {
    local candidate=$1 identity=${2:-} candidate_ppid candidate_state candidate_start
    [[ "$candidate" =~ ^[0-9]+$ ]] || return 0
    [ "$candidate" -gt 1 ] || return 0
    [ "$candidate" -ne "$$" ] || return 0
    [ -n "$identity" ] || identity=$(proc_identity "$candidate" 2>/dev/null) || return 0
    read -r candidate_ppid candidate_state candidate_start <<<"$identity"
    [[ "$candidate_start" =~ ^[0-9]+$ ]] || return 0
    grep -Fqx "$candidate $candidate_start" "$pid_set" 2>/dev/null \
      || printf '%s %s\n' "$candidate" "$candidate_start" >>"$pid_set"
  }

  proc_argv_has_token() {
    local candidate=$1 expected=$2 arg
    while IFS= read -r -d '' arg; do
      [ "$arg" = "$expected" ] && return 0
    done <"/proc/$candidate/cmdline" 2>/dev/null
    return 1
  }

  proc_argv_has_pair() {
    local candidate=$1 expected_flag=$2 expected_value=$3 previous= arg
    while IFS= read -r -d '' arg; do
      if [ "$previous" = "$expected_flag" ] && [ "$arg" = "$expected_value" ]; then
        return 0
      fi
      previous=$arg
    done <"/proc/$candidate/cmdline" 2>/dev/null
    return 1
  }

  proc_argv_has_private_path() {
    local candidate=$1 arg canonical
    while IFS= read -r -d '' arg; do
      case "$arg" in
        "$HOME"|"$HOME"/*|"$WORK"|"$WORK"/*) return 0 ;;
      esac
      # Some launchers embed an exact private path after a key/value separator.
      # Only accept a canonical absolute suffix, never a substring match.
      case "$arg" in
        *=/*)
          canonical=${arg#*=}
          case "$canonical" in
            "$HOME"|"$HOME"/*|"$WORK"|"$WORK"/*) return 0 ;;
          esac
          ;;
      esac
    done <"/proc/$candidate/cmdline" 2>/dev/null
    return 1
  }

  collect_cleanup_descendants() {
    local changed parent parent_start round identity
    for round in $(seq 1 32); do
      changed=0
      for path in /proc/[0-9]*; do
        pid=${path##*/}
        identity=$(proc_identity "$pid" 2>/dev/null) || continue
        read -r ppid state start <<<"$identity"
        while read -r parent parent_start; do
          cleanup_identity_active "$parent" "$parent_start" || continue
          [ "$ppid" = "$parent" ] || continue
          if ! grep -Fqx "$pid $start" "$pid_set" 2>/dev/null; then
            printf '%s %s\n' "$pid" "$start" >>"$pid_set"
            changed=1
          fi
          break
        done <"$pid_set"
      done
      [ "$changed" -eq 0 ] && return 0
    done
    printf 'test225 cleanup: descendant expansion exceeded its bound\n' >&2
    cleanup_failed=1
  }

  collect_test225_producers() {
    local raw_pid node_alias identity
    for pid in $(jobs -pr 2>/dev/null); do
      job_identity=$(proc_identity "$pid" 2>/dev/null) || continue
      read -r job_ppid job_state job_start <<<"$job_identity"
      [ "$job_ppid" = "$$" ] || continue
      append_cleanup_identity "$pid" "$job_identity"
    done
    for path in "$WORK"/.anet/nodes/*/.pid; do
      [ -r "$path" ] || continue
      raw_pid=$(<"$path")
      [[ "$raw_pid" =~ ^[0-9]+$ ]] || continue
      node_alias=$(basename "$(dirname "$path")")
      identity_before=$(proc_identity "$raw_pid" 2>/dev/null) || continue
      proc_argv_has_pair "$raw_pid" "--alias" "$node_alias" || continue
      identity_after=$(proc_identity "$raw_pid" 2>/dev/null) || continue
      [ "$identity_before" = "$identity_after" ] || continue
      append_cleanup_identity "$raw_pid" "$identity_after"
    done
    for alias in test225-attach test225-resume-attach test225-real-attach test225-real-resume-attach; do
      pid=$(tmux display-message -p -t "$alias":0.0 '#{pane_pid}' 2>/dev/null)
      [ -n "$pid" ] && append_cleanup_identity "$pid"
    done
    real_bin=${TEST225_REAL_GROK_BIN:-/host-grok/bin/grok-0.2.93}
    for path in /proc/[0-9]*; do
      [ -r "$path/cmdline" ] || continue
      pid=${path##*/}
      [ "$pid" -ne "$$" ] || continue
      identity_before=$(proc_identity "$pid" 2>/dev/null) || continue
      matched=0
      proc_argv_has_token "$pid" "/test225/fake-grok.mjs" && matched=1
      proc_argv_has_token "$pid" "/test225/local-registry.mjs" && matched=1
      proc_argv_has_token "$pid" "@sleep2agi/agent-node@preview" && matched=1
      proc_argv_has_token "$pid" "process.stdout.write('LOCKED\\n');process.stdin.resume()" && matched=1
      proc_argv_has_pair "$pid" "--db" "$COMMHUB_DB" && matched=1
      proc_argv_has_private_path "$pid" && matched=1
      [ -n "$real_bin" ] && proc_argv_has_token "$pid" "$real_bin" && matched=1
      [ "$matched" -eq 1 ] || continue
      identity_after=$(proc_identity "$pid" 2>/dev/null) || continue
      [ "$identity_before" = "$identity_after" ] || continue
      [ "$matched" -eq 1 ] && append_cleanup_identity "$pid" "$identity_after"
    done
    collect_cleanup_descendants
  }

  cleanup_identity_active() {
    local candidate=$1 expected_start=$2 identity current_ppid current_state current_start
    identity=$(proc_identity "$candidate" 2>/dev/null) || return 1
    read -r current_ppid current_state current_start <<<"$identity"
    [ "$current_start" = "$expected_start" ] || return 1
    case "$current_state" in Z|X|x) return 1 ;; esac
    return 0
  }

  cleanup_set_has_live() {
    local recorded_pid recorded_start
    while read -r recorded_pid recorded_start; do
      cleanup_identity_active "$recorded_pid" "$recorded_start" && return 0
    done <"$pid_set"
    return 1
  }

  signal_cleanup_set() {
    local signal=$1 recorded_pid recorded_start
    while read -r recorded_pid recorded_start; do
      cleanup_identity_active "$recorded_pid" "$recorded_start" || continue
      kill -s "$signal" "$recorded_pid" 2>/dev/null || true
    done <"$pid_set"
  }

  wait_cleanup_set() {
    local attempts=$1
    for _ in $(seq 1 "$attempts"); do
      cleanup_set_has_live || return 0
      sleep 0.1
    done
    return 1
  }

  # Snapshot every currently-owned tree before stop removes .pid files or
  # tmux removes pane identities. Later collections append; they never erase
  # the pre-stop generation bindings.
  collect_test225_producers
  for config in "$WORK"/.anet/nodes/*/config.json; do
    [ -f "$config" ] || continue
    alias=$(basename "$(dirname "$config")")
    timeout --kill-after=2s 10s anet node stop "$alias" >/dev/null 2>&1 || true
  done
  for alias in test225-attach test225-resume-attach test225-real-attach test225-real-resume-attach; do
    tmux kill-session -t "$alias" 2>/dev/null || true
  done
  collect_test225_producers
  signal_cleanup_set TERM
  wait_cleanup_set 50 || true
  collect_test225_producers
  signal_cleanup_set KILL
  if ! wait_cleanup_set 50; then
    printf 'test225 cleanup: producer shutdown did not quiesce\n' >&2
    cleanup_failed=1
  fi
  collect_test225_producers
  if cleanup_set_has_live; then
    printf 'test225 cleanup: live producer remained after kill fence\n' >&2
    cleanup_failed=1
  fi

  if [ -e "$AUTH_EVIDENCE_DIAGNOSTIC" ] || [ -L "$AUTH_EVIDENCE_DIAGNOSTIC" ]; then
    node /test225/auth-evidence-diagnostic.mjs validate "$AUTH_EVIDENCE_DIAGNOSTIC" \
      >/dev/null 2>&1 || {
        printf 'test225 cleanup: auth evidence diagnostic lost closed metadata\n' >&2
        auth_diagnostic_valid=0
      }
    real_turn_scan_inputs_valid || auth_diagnostic_valid=0
    if [ "$auth_diagnostic_valid" -eq 1 ]; then
      scan_fixed_file /tmp/test225-markers "$AUTH_EVIDENCE_DIAGNOSTIC" \
        >/dev/null 2>&1 || auth_diagnostic_valid=0
      scan_fixed_file /tmp/test225-live-credentials "$AUTH_EVIDENCE_DIAGNOSTIC" \
        >/dev/null 2>&1 || auth_diagnostic_valid=0
      scan_fixed_file /tmp/test225-real-patterns "$AUTH_EVIDENCE_DIAGNOSTIC" \
        >/dev/null 2>&1 || auth_diagnostic_valid=0
    fi
    if [ "$auth_diagnostic_valid" -ne 1 ]; then
      safe_rm_rf "$AUTH_EVIDENCE_DIAGNOSTIC"
      cleanup_failed=1
    fi
  fi

  # Producers are fenced before any credential/session/database path is gone.
  safe_rm_rf "$HOME" "$WORK"
  for path in /tmp/test225-*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    safe_rm_rf "$path"
  done
  if [ -e "$HOME" ] || [ -L "$HOME" ] || [ -e "$WORK" ] || [ -L "$WORK" ]; then
    printf 'test225 cleanup: private roots remained after deletion\n' >&2
    cleanup_failed=1
  fi

  # A new, empty registry proves no producer survived/reappeared; historical
  # dead/zombie identities are intentionally not treated as writers.
  pid_set=$fresh_set
  : >"$pid_set"
  NODE_PROCESS_PID="" HEADLESS_PID="" SERVER_PID="" REGISTRY_PID=""
  collect_test225_producers
  if cleanup_set_has_live; then
    printf 'test225 cleanup: producer reappeared after private-root deletion\n' >&2
    cleanup_failed=1
  fi
  rm -f "$fresh_set"
  for path in /tmp/test225-*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    printf 'test225 cleanup: private temporary path remained\n' >&2
    cleanup_failed=1
    break
  done
  [ "$cleanup_failed" -eq 0 ] || original_rc=1
  if [ "$original_rc" -ne 0 ]; then
    rm -f -- "$TUI_INVENTORY_EVIDENCE"
  fi
  exit "$original_rc"
}
trap cleanup EXIT

log "# test225 — Grok preview candidate tarball + live co-presence"
log "date: $(date -Is)"
log "source_commit=$SOURCE_COMMIT"
log "network=container-local Hub; outbound npm only for initial candidate dependency resolution"

log "[L0] clean candidate package image"
[ "$(id -u)" -ne 0 ] || fail "candidate package E2E must run as an unprivileged user"
[ "$(readlink -f "$(command -v bun)")" = /usr/local/bin/bun ] \
  || fail "unprivileged package E2E cannot execute the public Bun runtime"
[ ! -e /workspace ] || fail "runtime image unexpectedly contains /workspace source checkout"
[ ! -e /build ] || fail "runtime image unexpectedly contains packer source tree"
[ -z "${ANET_AGENT_NODE_BIN:-}" ] || fail "ANET_AGENT_NODE_BIN source escape hatch is set"
command -v anet >/dev/null || fail "anet is not installed from candidate tarball"
command -v agent-node >/dev/null && fail "clean fallback image unexpectedly has a global agent-node"
command -v commhub-server >/dev/null || fail "commhub-server is not installed from candidate tarball"
[ "$(stat -c %a -- /candidate)" = 755 ] && [ "$(stat -c %u -- /candidate)" = 0 ] \
  || fail "candidate directory is not root-owned mode 0755"
mapfile -t NODE_TGZ_CANDIDATES < <(find /candidate -maxdepth 1 -type f -name 'sleep2agi-agent-node-*.tgz' | sort)
[ "${#NODE_TGZ_CANDIDATES[@]}" -eq 1 ] || fail "expected exactly one agent-node candidate tarball"
NODE_TGZ=${NODE_TGZ_CANDIDATES[0]}
[ -f "$NODE_TGZ" ] && [ ! -L "$NODE_TGZ" ] \
  || fail "agent-node candidate tarball is not a regular file"
[ "$(stat -c %a -- "$NODE_TGZ")" = 644 ] \
  || fail "agent-node candidate tarball mode is not 0644"
[ "$(stat -c %u -- "$NODE_TGZ")" = 0 ] \
  || fail "agent-node candidate tarball is not root-owned"
[ "$(stat -c %h -- "$NODE_TGZ")" = 1 ] \
  || fail "agent-node candidate tarball has multiple hard links"
NODE_TGZ_IDENTITY=$(stat -c '%d:%i:%s:%Y' -- "$NODE_TGZ")
FAILURE_CONTRACT=/candidate/test225-grok-failure-contract.v1.json
[ -f "$FAILURE_CONTRACT" ] && [ ! -L "$FAILURE_CONTRACT" ] \
  || fail "candidate failure contract is missing or not a regular file"
[ "$(stat -c %a -- "$FAILURE_CONTRACT")" = 444 ] \
  || fail "candidate failure contract mode is not 0444"
[ "$(stat -c %u -- "$FAILURE_CONTRACT")" = 0 ] \
  || fail "candidate failure contract is not root-owned"
[ "$(stat -c %h -- "$FAILURE_CONTRACT")" = 1 ] \
  || fail "candidate failure contract has multiple hard links"
TEST225_FAILURE_CONTRACT_MODE=package \
TEST225_FAILURE_CONTRACT="$FAILURE_CONTRACT" \
TEST225_AGENT_NODE_TARBALL="$NODE_TGZ" \
node --test \
  /test225/auth-evidence-diagnostic.test.mjs \
  /test225/auth-evidence-gate-policy.test.mjs \
  /test225/failure-diagnostic.test.mjs \
  /test225/inventory-gate.test.mjs \
  /test225/inventory-diagnostic.test.mjs \
  >/tmp/test225-failure-diagnostic-test.log 2>&1 \
  || fail_with_private_log "closed turn diagnostic unit tests failed" /tmp/test225-failure-diagnostic-test.log
[ "$(stat -c '%d:%i:%s:%Y' -- "$NODE_TGZ")" = "$NODE_TGZ_IDENTITY" ] \
  || fail "agent-node candidate tarball identity changed during contract validation"
rm -f /tmp/test225-failure-diagnostic-test.log

STATUS_SELECTOR_ROW='{"alias":"selector-target","status":"idle","agent":"agent-node:grok-build-cli"}'
assert_status_selector_accepts legacy-array "[$STATUS_SELECTOR_ROW]"
assert_status_selector_accepts current-wrapper \
  "{\"ok\":true,\"sessions\":[$STATUS_SELECTOR_ROW],\"summary\":{\"idle\":1,\"working\":0,\"offline\":0,\"total\":1}}"
assert_status_selector_rejects top-level-boolean 'true'
assert_status_selector_rejects unknown-wrapper \
  "{\"ok\":true,\"agents\":[$STATUS_SELECTOR_ROW]}"
assert_status_selector_rejects mixed-array "[$STATUS_SELECTOR_ROW,true]"
assert_status_selector_rejects duplicate-alias "[$STATUS_SELECTOR_ROW,$STATUS_SELECTOR_ROW]"
assert_status_selector_rejects missing-alias \
  '[{"alias":"other","status":"online","agent":null}]'
assert_status_selector_rejects invalid-row \
  '[{"alias":false,"status":"online","agent":null}]'
unset STATUS_SELECTOR_ROW

ANET_VERSION=$(node -p 'require("/usr/local/lib/node_modules/@sleep2agi/agent-network/package.json").version')
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
NODE_LOG_DIR="$WORK/.anet/nodes/$ALIAS/logs"
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
anet info "$ALIAS" >"$INFO_LOG" 2>&1
grep -Fq 'fixed commhub-only profile [todo_write,search_tool,use_tool] (no filesystem/shell/web/media/subagents)' "$INFO_LOG" \
  || fail "anet info misreported the shared TUI effective tool boundary"
scan_fixed_file /tmp/test225-live-credentials "$INFO_LOG" \
  || fail "anet info exposed a Hub credential"
rm -f "$REGISTER_LOG" "$CREATE_LOG" "$INFO_LOG"
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
[ -x "$FAKE_GROK" ] || fail "image-owned Grok test double is not executable"
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
chmod 600 /tmp/test225-markers

# The closed diagnostic must never interpret an absent, empty, aliased, or
# broadly-readable scan input as a clean scan. These controls exercise the
# exact metadata predicate used immediately before and after persistence.
SCAN_INPUT_CONTROL_DIR=/tmp/test225-scan-input-controls
mkdir -p "$SCAN_INPUT_CONTROL_DIR"
chmod 700 "$SCAN_INPUT_CONTROL_DIR"
: >"$SCAN_INPUT_CONTROL_DIR/empty"
chmod 600 "$SCAN_INPUT_CONTROL_DIR/empty"
printf '%s\n' 'TEST225_SCAN_INPUT_CONTROL' >"$SCAN_INPUT_CONTROL_DIR/valid"
chmod 600 "$SCAN_INPUT_CONTROL_DIR/valid"
ln -s "$SCAN_INPUT_CONTROL_DIR/valid" "$SCAN_INPUT_CONTROL_DIR/symlink"
cp "$SCAN_INPUT_CONTROL_DIR/valid" "$SCAN_INPUT_CONTROL_DIR/wrong-mode"
chmod 644 "$SCAN_INPUT_CONTROL_DIR/wrong-mode"
ln "$SCAN_INPUT_CONTROL_DIR/valid" "$SCAN_INPUT_CONTROL_DIR/hardlink"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/missing" \
  && fail "diagnostic scanner accepted a missing pattern file"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/empty" \
  && fail "diagnostic scanner accepted an empty pattern file"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/symlink" \
  && fail "diagnostic scanner accepted a symlink pattern file"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/wrong-mode" \
  && fail "diagnostic scanner accepted a broadly-readable pattern file"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/valid" \
  && fail "diagnostic scanner accepted a multiply-linked pattern file"
rm -f "$SCAN_INPUT_CONTROL_DIR/hardlink"
scan_pattern_file_valid "$SCAN_INPUT_CONTROL_DIR/valid" \
  || fail "diagnostic scanner rejected a nonempty owner-only pattern file"
safe_rm_rf "$SCAN_INPUT_CONTROL_DIR"

# Negative controls: a scanner read error is a gate error, not a clean result,
# and auth refresh extends (rather than replaces) the private scan set.
SCAN_ERROR_DIR=/tmp/test225-scan-error
mkdir -p "$SCAN_ERROR_DIR"
ln -s "$SCAN_ERROR_DIR/missing" "$SCAN_ERROR_DIR/dangling"
if scan_fixed_file /tmp/test225-markers "$SCAN_ERROR_DIR"; then
  fail "credential scanner accepted an unreadable directory tree"
else
  SCAN_ERROR_RC=$?
fi
[ "$SCAN_ERROR_RC" -eq 2 ] || fail "credential scanner did not distinguish a read error"
if scan_fixed_file /tmp/test225-markers "$SCAN_ERROR_DIR/dangling"; then
  fail "credential scanner accepted a direct dangling target"
else
  SCAN_ERROR_RC=$?
fi
[ "$SCAN_ERROR_RC" -eq 2 ] || fail "credential scanner skipped a direct dangling target"
safe_rm_rf "$SCAN_ERROR_DIR"
cat > /tmp/test225-refresh-auth.json <<'EOF_REFRESH_AUTH_1'
{"value":"TEST225_REFRESH_SCAN_OLD_0123456789"}
EOF_REFRESH_AUTH_1
chmod 600 /tmp/test225-refresh-auth.json
refresh_real_auth_patterns /tmp/test225-refresh-auth.json
cat > /tmp/test225-refresh-auth.json <<'EOF_REFRESH_AUTH_2'
{"value":"TEST225_REFRESH_SCAN_NEW_0123456789"}
EOF_REFRESH_AUTH_2
refresh_real_auth_patterns /tmp/test225-refresh-auth.json
grep -Fxq 'TEST225_REFRESH_SCAN_OLD_0123456789' /tmp/test225-real-patterns \
  || fail "auth refresh scan set dropped the prior scalar"
grep -Fxq 'TEST225_REFRESH_SCAN_NEW_0123456789' /tmp/test225-real-patterns \
  || fail "auth refresh scan set omitted the new scalar"
rm -f /tmp/test225-refresh-auth.json "$REAL_AUTH_PATTERNS" \
  "$REAL_AUTH_UNSAFE_PATTERNS" "$REAL_AUTH_METADATA_MANIFEST"

# Exercise aggregate-independent structural classification and the actual
# closed persistence function. Correct identity, wrong identity, deep
# session/agent_id, direct clean symlink, match, and dangling cases must stay
# distinguishable without retaining the marker or any path.
AUTH_ROLE_SELFTEST=/tmp/test225-auth-role-selftest
AUTH_ROLE_OUTPUT=/tmp/test225-auth-role-output
AUTH_ROLE_CURRENT_HOME="$AUTH_ROLE_SELFTEST/state/node-aaaaaaaaaaaaaaaaaaaaaaaa"
AUTH_ROLE_PRIOR_HOME="$AUTH_ROLE_SELFTEST/state/node-bbbbbbbbbbbbbbbbbbbbbbbb"
AUTH_ROLE_SESSION_ID=11111111-1111-4111-8111-111111111111
AUTH_ROLE_CWD=/synthetic-work
AUTH_ROLE_SESSION_DIR="$AUTH_ROLE_CURRENT_HOME/sessions/%2Fsynthetic-work/$AUTH_ROLE_SESSION_ID"
AUTH_ROLE_RUNTIME="$AUTH_ROLE_SELFTEST/runtime"
AUTH_ROLE_LOCK_DIR="$AUTH_ROLE_CURRENT_HOME/copresence-locks"
AUTH_ROLE_LEADER="$AUTH_ROLE_RUNTIME/l.sock"
AUTH_ROLE_ATTACH="$AUTH_ROLE_RUNTIME/a.sock"
mkdir -p "$AUTH_ROLE_SELFTEST/source" \
  "$AUTH_ROLE_SELFTEST/home/.grok" \
  "$AUTH_ROLE_SESSION_DIR" "$AUTH_ROLE_RUNTIME" "$AUTH_ROLE_LOCK_DIR" \
  "$AUTH_ROLE_PRIOR_HOME"
chmod 700 "$AUTH_ROLE_SELFTEST" "$AUTH_ROLE_SELFTEST/source" \
  "$AUTH_ROLE_SELFTEST/home" "$AUTH_ROLE_SELFTEST/home/.grok" \
  "$AUTH_ROLE_SELFTEST/state" "$AUTH_ROLE_CURRENT_HOME" \
  "$AUTH_ROLE_CURRENT_HOME/sessions" \
  "$AUTH_ROLE_CURRENT_HOME/sessions/%2Fsynthetic-work" \
  "$AUTH_ROLE_SESSION_DIR" "$AUTH_ROLE_RUNTIME" "$AUTH_ROLE_LOCK_DIR" \
  "$AUTH_ROLE_PRIOR_HOME"
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 \
  >"$AUTH_ROLE_SELFTEST/home/.grok/agent_id"
printf '%s\n' clean >"$AUTH_ROLE_SELFTEST/source/other-agent-id"
printf '%s\n' clean >"$AUTH_ROLE_SELFTEST/source/direct-clean"
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 \
  >"$AUTH_ROLE_SESSION_DIR/chat_history.jsonl"
printf '%s\n' clean >"$AUTH_ROLE_CURRENT_HOME/config.toml"
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 \
  >"$AUTH_ROLE_CURRENT_HOME/unreviewed.data"
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 \
  >"$AUTH_ROLE_PRIOR_HOME/prior.data"
ln -s "$AUTH_ROLE_SELFTEST/home/.grok/agent_id" \
  "$AUTH_ROLE_CURRENT_HOME/agent_id"
ln -s "$AUTH_ROLE_SELFTEST/source/other-agent-id" \
  "$AUTH_ROLE_PRIOR_HOME/agent_id"
ln -s "$AUTH_ROLE_SELFTEST/source/other-agent-id" \
  "$AUTH_ROLE_SESSION_DIR/agent_id"
ln -s "$AUTH_ROLE_SELFTEST/source/missing" "$AUTH_ROLE_CURRENT_HOME/unreviewed.link"
ln -s "$AUTH_ROLE_SELFTEST/source/direct-clean" "$AUTH_ROLE_SELFTEST/direct-clean-link"
AUTH_ROLE_LEADER_KEY=$(printf '%s' "$AUTH_ROLE_LEADER" | sha256sum | cut -c1-20)
AUTH_ROLE_SESSION_KEY=$(printf '%s\0%s\0%s' \
  "$AUTH_ROLE_CURRENT_HOME" "$AUTH_ROLE_CWD" "$AUTH_ROLE_SESSION_ID" \
  | sha256sum | cut -c1-24)
: >"$AUTH_ROLE_RUNTIME/.leader-$AUTH_ROLE_LEADER_KEY.lock"
: >"$AUTH_ROLE_RUNTIME/.bridge-$AUTH_ROLE_LEADER_KEY-$AUTH_ROLE_SESSION_ID.lock"
: >"$AUTH_ROLE_LOCK_DIR/.session-$AUTH_ROLE_SESSION_KEY.lock"
find "$AUTH_ROLE_SELFTEST" -type f -exec chmod 600 {} +
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 >"$REAL_AUTH_PATTERNS"
printf '%s\n' TEST225_AUTH_ROLE_PRIVATE_0123456789 >"$REAL_AUTH_UNSAFE_PATTERNS"
printf '%s\n' '{"v":1,"tuples":[]}' >"$REAL_AUTH_METADATA_MANIFEST"
chmod 600 "$REAL_AUTH_PATTERNS" "$REAL_AUTH_UNSAFE_PATTERNS" \
  "$REAL_AUTH_METADATA_MANIFEST"
real_turn_scan_inputs_valid \
  || fail "auth evidence role self-test scan inputs are not owner-only"
if (trap - EXIT; HOME="$AUTH_ROLE_SELFTEST/home"; export HOME; \
  run_real_auth_evidence_gate final_scan \
  "$AUTH_ROLE_CURRENT_HOME" "$AUTH_ROLE_SESSION_ID" "$AUTH_ROLE_CWD" \
  "$AUTH_ROLE_LEADER" "$AUTH_ROLE_ATTACH" \
  __grok_state__ "$AUTH_ROLE_SELFTEST/state" \
  runtime_log_store "$AUTH_ROLE_SELFTEST/direct-clean-link") \
  >"$AUTH_ROLE_OUTPUT" 2>&1; then
  fail "auth evidence production gate accepted a synthetic containment failure"
else
  AUTH_ROLE_GATE_RC=$?
fi
chmod 600 "$AUTH_ROLE_OUTPUT"
[ "$AUTH_ROLE_GATE_RC" -eq 1 ] \
  || fail "auth evidence production gate returned an unexpected failure status"
node /test225/auth-evidence-diagnostic.mjs validate "$AUTH_EVIDENCE_DIAGNOSTIC" \
  || fail "auth evidence production gate did not persist a closed artifact"
jq -e '
  .scanOutcome == "mixed"
  and .matchedRoles == ["grok_identity_state","grok_session_chat","grok_current_home_other_state","grok_prior_node_state"]
  and .errorRoles == ["runtime_log_store","grok_current_state_completeness","grok_current_state_structure","grok_prior_node_structure"]
' "$AUTH_EVIDENCE_DIAGNOSTIC" >/dev/null \
  || fail "auth evidence role classifier did not bind the exact expected roles"
scan_fixed_file /tmp/test225-real-patterns "$AUTH_EVIDENCE_DIAGNOSTIC" \
  "$AUTH_ROLE_OUTPUT" "$REPORT" \
  || fail "auth evidence role persistence retained its private marker"

# Prove the production preview branch accepts only the scan-complete structural
# role. The same raw fixture above is reduced to one clean, unknown regular file;
# latest/prod strictness is pinned independently by the policy unit test.
AUTH_ROLE_WARNING_OUTPUT=/tmp/test225-auth-role-warning-output
printf '%s\n' clean >"$AUTH_ROLE_SELFTEST/home/.grok/agent_id"
printf '%s\n' clean >"$AUTH_ROLE_SESSION_DIR/chat_history.jsonl"
printf '%s\n' clean >"$AUTH_ROLE_CURRENT_HOME/unreviewed.data"
safe_rm_rf "$AUTH_ROLE_PRIOR_HOME"
rm -f "$AUTH_ROLE_SESSION_DIR/agent_id" "$AUTH_ROLE_CURRENT_HOME/unreviewed.link"
if ! (trap - EXIT; HOME="$AUTH_ROLE_SELFTEST/home"; export HOME; \
  run_real_auth_evidence_gate final_scan \
  "$AUTH_ROLE_CURRENT_HOME" "$AUTH_ROLE_SESSION_ID" "$AUTH_ROLE_CWD" \
  "$AUTH_ROLE_LEADER" "$AUTH_ROLE_ATTACH" \
  __grok_state__ "$AUTH_ROLE_SELFTEST/state") \
  >"$AUTH_ROLE_WARNING_OUTPUT" 2>&1; then
  fail "auth evidence preview gate rejected its scan-complete structural warning"
fi
chmod 600 "$AUTH_ROLE_WARNING_OUTPUT"
node /test225/auth-evidence-diagnostic.mjs validate "$AUTH_EVIDENCE_DIAGNOSTIC" \
  || fail "auth evidence preview warning did not persist a closed artifact"
jq -e '
  .scanOutcome == "scan_error"
  and .matchedRoles == []
  and .errorRoles == ["grok_current_state_completeness"]
' "$AUTH_EVIDENCE_DIAGNOSTIC" >/dev/null \
  || fail "auth evidence preview warning escaped its exact completeness role"
grep -Fq 'WARNING: auth_evidence phase=final_scan scanOutcome:scan_error preview_structure_warning=true' \
  "$AUTH_ROLE_WARNING_OUTPUT" \
  || fail "auth evidence preview warning branch did not emit its fixed audit marker"
scan_fixed_file /tmp/test225-real-patterns "$AUTH_EVIDENCE_DIAGNOSTIC" \
  "$AUTH_ROLE_WARNING_OUTPUT" "$REPORT" \
  || fail "auth evidence preview warning retained its private marker"

safe_rm_rf "$AUTH_ROLE_SELFTEST" "$AUTH_ROLE_OUTPUT" "$AUTH_ROLE_WARNING_OUTPUT" \
  "$REAL_AUTH_PATTERNS" \
  "$REAL_AUTH_UNSAFE_PATTERNS" "$REAL_AUTH_METADATA_MANIFEST"
rm -f -- "$AUTH_EVIDENCE_DIAGNOSTIC"
unset AUTH_ROLE_GATE_RC AUTH_ROLE_CURRENT_HOME AUTH_ROLE_PRIOR_HOME \
  AUTH_ROLE_SESSION_ID AUTH_ROLE_CWD AUTH_ROLE_SESSION_DIR \
  AUTH_ROLE_RUNTIME AUTH_ROLE_LOCK_DIR AUTH_ROLE_LEADER AUTH_ROLE_ATTACH \
  AUTH_ROLE_LEADER_KEY AUTH_ROLE_SESSION_KEY AUTH_ROLE_WARNING_OUTPUT
pass "auth evidence scanner emits only closed target-role diagnostics"

# Seed a pre-boundary ordinary log with broad permissions and a synthetic
# credential. Startup must scrub it and repair both directory/file modes
# before appending the first runtime line.
mkdir -p "$NODE_LOG_DIR"
chmod 755 "$NODE_LOG_DIR"
LEGACY_DAILY_LOG="$NODE_LOG_DIR/$(date -u +%F).log"
printf '%s\n' 'legacy PARTNER_TOKEN=TEST225_TOKEN_CANARY_74f210' > "$LEGACY_DAILY_LOG"
chmod 644 "$LEGACY_DAILY_LOG"

{
  for key in PATH TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TZ SHELL USER LOGNAME TERM COLORTERM NO_COLOR; do
    printenv "$key" >/dev/null 2>&1 && printf '%s\n' "$key"
  done
  printf '%s\n' \
    HOME PWD GROK_HOME GROK_AUTH_PATH ANET_EXPECTED_PARENT_PID \
    GROK_CLAUDE_MCPS_ENABLED GROK_CURSOR_MCPS_ENABLED \
    GROK_CLAUDE_HOOKS_ENABLED GROK_CURSOR_HOOKS_ENABLED \
    GROK_FOLDER_TRUST GROK_DEFAULT_SELECTED_PERMISSION \
    GROK_DISABLE_AUTOUPDATER GROK_CHANGELOG_OFFLINE GROK_LEADER_LOG GROK_SUBAGENTS GROK_WEB_FETCH GROK_MEMORY
} | sort -u | jq -Rsc 'split("\n") | map(select(length > 0))' > "$EXPECTED_GROK_ENV_KEYS"
jq -c '. + ["TERM", "GROK_SANDBOX", "ANET_GROK_LEADER_OWNER"] | unique | sort' "$EXPECTED_GROK_ENV_KEYS" \
  > "$EXPECTED_GROK_PTY_ENV_KEYS"
jq -c '. + ["GROK_LEADER_SOCKET"] | unique | sort' "$EXPECTED_GROK_PTY_ENV_KEYS" \
  > "$EXPECTED_GROK_LEADER_ENV_KEYS"

node - <<'NODE' > "$EXPECTED_HELPER_ENV"
const keys = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const expected = {};
for (const key of keys) {
  const value = process.env[key];
  if (value !== undefined && value !== "") expected[key] = value;
}
if (!expected.PATH) expected.PATH = "/usr/local/bin:/usr/bin:/bin";
process.stdout.write(`${JSON.stringify(expected)}\n`);
NODE
chmod 600 "$EXPECTED_HELPER_ENV"

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
  tmux set-window-option -t "$session":0 remain-on-exit on >/dev/null
}

start_fake_node "$START_LOG"
wait_file "$ATTACH_SOCKET" 600 \
  || fail_with_private_log "attach socket did not appear through npx preview fallback" "$START_LOG"
grep -Fq 'agent-node is not installed globally; fetching @sleep2agi/agent-node@preview' "$START_LOG" \
  || fail "clean start did not exercise the documented npx preview fallback"
grep -Fq 'fixed commhub-only profile [todo_write,search_tool,use_tool] (no filesystem/shell/web/media/subagents)' "$START_LOG" \
  || fail "agent-node startup misreported the shared TUI effective tool boundary"
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
[ "$(readlink -f "/proc/$RUNTIME_PID/exe")" = "$(readlink -f "$(command -v node)")" ] \
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
[ "$(awk '$3 == "grok" {n++} END {print n+0}' "$FALLBACK_PID_SNAPSHOT")" -eq 2 ] \
  || fail "fallback snapshot does not contain one Grok PTY and one independent Leader"
[ "$(awk '$3 == "lock-holder" {n++} END {print n+0}' "$FALLBACK_PID_SNAPSHOT")" -eq 3 ] \
  || fail "fallback snapshot does not contain the three lifetime lock holders"
assert_lock_holder_envs_exact "$FALLBACK_PID_SNAPSHOT"

stop_node_checked "$ALIAS" legacy-reload
[ ! -e "$ATTACH_SOCKET" ] || fail "node stop returned before removing the attach socket"
[ ! -e "$LEADER_SOCKET" ] || fail "node stop returned before removing the leader socket"
assert_no_unix_listener "$LEADER_SOCKET" \
  || fail "node stop left a Leader listener after removing its pathname"
assert_snapshot_gone "$FALLBACK_PID_SNAPSHOT"
capture_stopped_pane test225-attach "$ATTACH_CAPTURE"
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
# Owner-bound state homes place the leader directory below $HOME/.anet-grok.
# Keep both compatibility roots but de-duplicate an overlapping parent/child
# traversal so one physical lock is proved exactly once.
done < <(find "$HOME/.anet-grok" "$(dirname "$LEADER_SOCKET")" \
  -type f -name '*.lock' -print0 | sort -zu)
[ "$LOCK_COUNT" -eq 3 ] || fail "fallback stop proof did not find exactly three lifetime lock files"
ln -sf /test225/old-v1-agent-node.mjs /tmp/test225-bin/agent-node
start_fake_node "$RELOAD_LOG"
wait_file "$ATTACH_SOCKET" 600 \
  || fail_with_private_log "attach socket did not return for legacy-goal reload" "$RELOAD_LOG"
grep -Fq 'installed agent-node lacks the required Grok co-presence capability; using @sleep2agi/agent-node@preview instead' "$RELOAD_LOG" \
  || fail "old V1-only global agent-node did not trigger the candidate preview fallback"
[ ! -e /tmp/test225-old-v1-agent-node-launched ] \
  || fail "old V1-only global agent-node was launched instead of only capability-probed"
rm -f /tmp/test225-bin/agent-node
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
pass "create -> start -> register -> Hub task -> real tmux attach live render -> reply"
if ! STATUS_ROW=$(curl -fsS "$HUB/api/status?network_id=$NETWORK_ID" \
  -H "Authorization: Bearer $USER_TOKEN" \
  | select_unique_status_row "$ALIAS"); then
  fail "Hub status payload was invalid or alias cardinality was not exactly one"
fi
jq -e '.agent == "agent-node:grok-build-cli"' \
  <<<"$STATUS_ROW" >/dev/null \
  || fail "Hub session did not retain the registered grok-build-cli agent identity"
jq -e '.status == "idle"' <<<"$STATUS_ROW" >/dev/null \
  || fail "Hub session was not idle after the replied task"
# 🔴 #1019 —— 判的是 Hub 那一行里的**数据**,不是源码里有没有写那一行。
#    sessions.version 长期为空(一次只读快照:223/225 是 null)。服务端一直是收也写的:
#    report_status 的 schema 里有 `version`,upsert 里 `version = COALESCE(?9, sessions.version)`。
#    缺的只有节点不发这一半 —— 而「源码里加了一行 version:」和「那一行真的到了库里」
#    是两件事,COALESCE 意味着漏发时旧值会被静默保留,看起来和"没变化"一模一样。
#    所以判据必须落在 /api/status 真返回的那一行上。
jq -e --arg v "$AGENT_NODE_VERSION" '.version == $v' <<<"$STATUS_ROW" >/dev/null \
  || fail "Hub session did not record the node's own agent-node version (expected $AGENT_NODE_VERSION, got $(jq -r '.version // "null"' <<<"$STATUS_ROW"))"
pass "Hub session registration reports agent-node:grok-build-cli and its own version"

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
assert_fake_observations_exact
if scan_fixed_file /tmp/test225-markers \
  "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$ATTACH_CAPTURE" "$RELOAD_CAPTURE"; then :; else
  fail "synthetic credential reached ordinary agent/TUI logs"
fi
SESSION_ID=$(jq -r '.grokCliSession // empty' "$CONFIG")
[ -n "$SESSION_ID" ] || fail "co-presence session id was not persisted"
GROK_STATE="$HOME/.anet-grok"
if scan_fixed_file /tmp/test225-markers "$GROK_STATE"; then :; else
  fail "synthetic credential reached Grok session or generated state"
fi
# The native TUI/transcript is part of the captured evidence boundary.  Live
# rendering is proved with a benign marker above; credential canaries must be
# absent here just like they are from ordinary logs and reports.
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
[ "$(file_mode "$NODE_LOG_DIR")" = 700 ] \
  || fail "legacy durable agent log directory was not repaired to 0700"
[ "$(file_mode "$LEGACY_DAILY_LOG")" = 600 ] \
  || fail "legacy durable agent log was not repaired to 0600"
grep -Fq '[REDACTED_CREDENTIAL]' "$LEGACY_DAILY_LOG" \
  || fail "legacy durable agent log was not scrubbed before append"
[ "$(wc -l <"$LEGACY_DAILY_LOG")" -gt 1 ] \
  || fail "production logger did not append to the repaired daily log"
grep -Fq '[grok-copresence] grok 0.2.93' "$LEGACY_DAILY_LOG" \
  || fail "production Grok startup line is absent from the repaired daily log"
scan_fixed_file /tmp/test225-markers "$NODE_LOG_DIR" \
  || fail "synthetic credential reached the durable agent log directory"
scan_fixed_file /tmp/test225-live-credentials "$NODE_LOG_DIR" \
  || fail "Hub credential reached the durable agent log directory"
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
snapshot_fallback_runtime "$FALLBACK_PID_SNAPSHOT"
stop_node_checked "$ALIAS" fallback
capture_stopped_pane test225-attach "$RELOAD_CAPTURE"
tmux kill-session -t test225-attach 2>/dev/null || true
wait_gone "$ATTACH_SOCKET" 300 || fail "attach socket survived node stop"
wait_gone "$LEADER_SOCKET" 300 || fail "leader socket survived node stop"
assert_no_unix_listener "$LEADER_SOCKET" || fail "Leader listener survived node stop"
wait "$NODE_PROCESS_PID" 2>/dev/null || true
NODE_PROCESS_PID=""
assert_snapshot_gone "$FALLBACK_PID_SNAPSHOT"
wait_no_fallback_runtime 300 \
  || fail "pre-global stop left agent-node, Grok, npm wrapper, or lock-holder processes"
assert_no_project_sandbox_placeholders

# Install the exact same unpublished tarball into an owner-only user-global
# prefix only after the fallback path has succeeded. From here onward npm is
# offline, proving start selects that candidate rather than source or another
# npx resolution without granting write access to the system prefix.
mkdir -p "$USER_NPM_PREFIX"
chmod 700 "$USER_NPM_PREFIX"
if ! npm install -g --prefix "$USER_NPM_PREFIX" --include=optional "$NODE_TGZ" \
  >"$GLOBAL_INSTALL_LOG" 2>&1; then
  fail_with_private_log "global candidate agent-node install failed" "$GLOBAL_INSTALL_LOG"
fi
command -v agent-node >/dev/null || fail "candidate agent-node global binary is missing"
agent-node --help | grep -Fq 'ANET_CAPABILITY_GROK_COPRESENCE_V2' \
  || fail "global candidate agent-node lacks the co-presence capability marker"
node -e '
  const root = process.argv[1];
  require(require.resolve("node-pty", { paths: [root] }));
' "$GLOBAL_AGENT_NODE_ROOT" \
  || fail "global candidate agent-node lacks its node-pty optional dependency"
scan_fixed_file /tmp/test225-markers "$GLOBAL_INSTALL_LOG" \
  || fail "global install output exposed a synthetic credential marker"
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
# 🔴 #1020 —— 顺序:凭据扫描必须排在功能断言**之前**。
#    原来那句 `grep -Fq ... || fail` 排在两条 scan_fixed_file 前面,而 `fail()` 是
#    `log "FAIL: $*"; exit 1` —— 一旦那句 grep 不过(它已经红了至少两个 commit),
#    这两条**安全检查根本不会执行**。也就是说:在唯一一种「拒绝路径没按预期走完」的
#    现实里,我们恰好放弃了检查它有没有把凭据打进日志。
#    把安全检查挡在功能检查后面,等于让功能回归顺手关掉安全回归。
scan_fixed_file /tmp/test225-markers "$FEISHU_LOG" \
  || fail "Feishu refusal output exposed a synthetic credential marker"
scan_fixed_file /tmp/test225-live-credentials "$FEISHU_LOG" \
  || fail "Feishu refusal output exposed a Hub credential"
if ! grep -Fq 'grok-build-cli preview currently refuses Feishu channels' "$FEISHU_LOG"; then
  # 到这里为止,上面两条扫描已经证明这份日志里没有凭据 —— 所以可以安全地把
  # 产品自己打的那几行原样带出来。只带 `[agent-node] ` 前缀的行:
  # 它们是产品的错误消息,而拒绝语句之前有 **17 处** process.exit(1),
  # 「退出码非 0」这半边判据被其中任意一条满足,区分不出是哪一条。
  # 不带这几行的话,这条 FAIL 只能说明「不是因为飞书被拒而退的」,不能说明因为什么。
  log "diagnostic: feishu_refusal actual [agent-node] output follows (credential-scanned above)"
  grep -F '[agent-node] ' "$FEISHU_LOG" | head -5 | while IFS= read -r line; do
    log "  | $line"
  done
  fail "installed candidate Feishu refusal lacked the fixed explanation"
fi
[ "$(matching_process_count '/test225/fake-grok.mjs')" -eq 0 ] \
  || fail "Feishu refusal started Grok before closing the channel boundary"
safe_rm_rf "$FEISHU_DIR" "$FEISHU_CONFIG" "$FEISHU_LOG"

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
HEADLESS_PID=""
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

GLOBAL_OBSERVATION_BASE=$(wc -l <"$FAKE_OBSERVATIONS")
GLOBAL_READINESS_BASE=$(wc -l <"$FAKE_READINESS_OBSERVATIONS")
start_fake_node_global "$RESUME_LOG"
wait_file "$ATTACH_SOCKET" 300 \
  || fail_with_private_log "attach socket did not return from global candidate" "$RESUME_LOG"
assert_installed_candidate_runtime "$ALIAS" "global resume" "$RESUME_LOG"
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
tail -n "+$((GLOBAL_OBSERVATION_BASE + 1))" "$FAKE_OBSERVATIONS" >"$GLOBAL_OBSERVATIONS"
tail -n "+$((GLOBAL_READINESS_BASE + 1))" "$FAKE_READINESS_OBSERVATIONS" \
  >"$GLOBAL_READINESS_OBSERVATIONS"
chmod 600 "$GLOBAL_OBSERVATIONS" "$GLOBAL_READINESS_OBSERVATIONS"
[ -s "$GLOBAL_OBSERVATIONS" ] || fail "global resume produced no new Grok observation"
[ -s "$GLOBAL_READINESS_OBSERVATIONS" ] || fail "global resume produced no new readiness observation"
assert_fake_observations_exact "$GLOBAL_OBSERVATIONS"
GLOBAL_RUNTIME_PID=$(<"$RUNTIME_PID_FILE")
jq -e -s --argjson pid "$GLOBAL_RUNTIME_PID" \
  '([.[] | select(.kind == "spawn")] | length) == 1
   and ([.[] | select(.kind == "spawn")][0]
     | .resume == true
       and .parentPid == $pid
       and .expectedParentPid == $pid
       and .folderTrustExact == true
       and .folderTrustMode == 384
       and .folderTrustCount == 1)' \
  "$GLOBAL_OBSERVATIONS" >/dev/null \
  || fail "global resume observation is not bound to the current installed runtime PID"
jq -e -s 'length > 0 and all(.[]; .preReadyNetworkWrites == 0)' \
  "$GLOBAL_READINESS_OBSERVATIONS" >/dev/null \
  || fail "global resume wrote a network prompt before the TUI composer readiness gate"
grep -Fq 'fetching @sleep2agi/agent-node@preview' "$START_LOG" \
  || fail "initial package-only start no longer proves the documented npx preview fallback"
grep -Fq '[anet] using installed agent-node with Grok co-presence capability.' "$RESUME_LOG" \
  || fail "resume did not identify the installed global candidate agent-node"
grep -Eq 'fetching @sleep2agi/agent-node@preview|using @sleep2agi/agent-node@preview instead' "$RESUME_LOG" \
  && fail "resume used a cached npx preview path instead of the installed global candidate"
pass "node stop/resume reused one session: first start used npx preview fallback; resume used global candidate"

snapshot_fallback_runtime "$FALLBACK_PID_SNAPSHOT"
stop_node_checked "$ALIAS" resumed
capture_stopped_pane test225-resume-attach "$RESUME_CAPTURE"
tmux kill-session -t test225-resume-attach 2>/dev/null || true
wait_gone "$ATTACH_SOCKET" 300 || fail "resumed attach socket survived node stop"
wait_gone "$LEADER_SOCKET" 300 || fail "resumed leader socket survived node stop"
assert_no_unix_listener "$LEADER_SOCKET" || fail "resumed Leader listener survived node stop"
wait "$NODE_PROCESS_PID" 2>/dev/null || true
NODE_PROCESS_PID=""
assert_snapshot_gone "$FALLBACK_PID_SNAPSHOT"
wait_no_fallback_runtime 300 \
  || fail "global resume stop left agent-node, Grok, npm wrapper, or lock-holder processes"
assert_no_project_sandbox_placeholders
pass "installed-package stop/resume removes exact pinned project sandbox placeholders"

run_keyless_gate() {
  local real_bin=${TEST225_REAL_GROK_BIN:-/host-grok/bin/grok-0.2.93}
  local profile_fixture mcp_doctor
  local -a profile_candidates=()

  [ -x "$real_bin" ] \
    || fail "RUN_KEYLESS_GROK_GATE=1 but pinned Grok binary is not executable: $real_bin"
  [[ "$("$real_bin" --version)" =~ ^grok\ 0\.2\.93\ \(f00f96316d\)(\ \[stable\])?$ ]] \
    || fail "keyless live gate requires exact Grok 0.2.93"
  mapfile -d '' profile_candidates \
    < <(find "$GROK_STATE" -type f -name 'anet-copresence-preview.md' -print0)
  [ "${#profile_candidates[@]}" -eq 1 ] \
    || fail "package gate did not produce exactly one runtime-owned co-presence profile"
  profile_fixture=${profile_candidates[0]}
  [ "$(file_mode "$profile_fixture")" = 600 ] \
    || fail "runtime-owned co-presence profile is not mode 0600"
  mcp_doctor=$(mktemp /tmp/test225-commhub-mcp-doctor.XXXXXX)
  chmod 600 "$mcp_doctor"
  if ! (cd "$WORK" && env -i \
    PATH="$PATH" HOME="$(dirname "$profile_fixture")" \
    PWD="$WORK" GROK_HOME="$(dirname "$profile_fixture")" \
    GROK_AUTH_PATH="$(dirname "$profile_fixture")/auth.json" \
    GROK_CLAUDE_MCPS_ENABLED=false GROK_CURSOR_MCPS_ENABLED=false \
    "$real_bin" mcp doctor commhub --json) >"$mcp_doctor" 2>&1; then
    fail_with_private_log "runtime-owned commhub MCP doctor failed" "$mcp_doctor"
  fi
  jq -e '
    .healthy_count == 1 and .failing_count == 0
    and (.servers | length) == 1
    and .servers[0].name == "commhub"
    and .servers[0].transport == "stdio"
    and .servers[0].healthy == true
    and any(.servers[0].checks[]; .label == "4 tools discovered" and .passed == true)
  ' "$mcp_doctor" >/dev/null \
    || fail "runtime-owned commhub MCP doctor did not prove the exact four-tool outbound-only server"
  scan_fixed_file /tmp/test225-markers "$mcp_doctor" \
    || fail "commhub MCP doctor leaked a synthetic credential marker"
  rm -f -- "$mcp_doctor"
  run_tui_inventory_gate "$real_bin" "$profile_fixture"
  # `mcp doctor` is an out-of-band vendor diagnostic, not a managed node
  # generation, so it has no runtime close hook. Remove only its exact Bun
  # cache after the probe exits; the production close path proves the same
  # cache lifecycle independently through cleanupGrokCliPostStopState.
  safe_rm_rf "$(dirname "$profile_fixture")/.bun"
  # The keyless inventory process generates an account-derived vendor
  # agent_id even though it never loads the mounted auth file. The following
  # authenticated gate treats every auth scalar (including that account id)
  # as private, so scanning both phases in one state root would misclassify
  # the already-stopped keyless fixture as a cross-node credential leak.
  # Preserve that exact phase as a separate owner-only evidence root and make
  # the authenticated node prove itself against a genuinely empty state root.
  local keyless_state_evidence="$HOME/.anet-grok-keyless-evidence"
  [ ! -e "$keyless_state_evidence" ] && [ ! -L "$keyless_state_evidence" ] \
    || fail "keyless evidence state destination already exists"
  scan_fixed_file /tmp/test225-markers "$GROK_STATE" \
    || fail "keyless Grok state contains a synthetic credential marker"
  mv -- "$GROK_STATE" "$keyless_state_evidence"
  mkdir -m 700 "$GROK_STATE"
  pass "pinned Grok TUI inventory, exact commhub MCP, unsafe mutations, and keyless todo lifecycle gate"
}

run_real_gate() {
  local real_bin=${TEST225_REAL_GROK_BIN:-/host-grok/bin/grok-0.2.93}
  local real_auth=${TEST225_REAL_GROK_AUTH:-/host-grok/auth.json}
  local real_alias=preview-grok-real-225
  local real_config="$WORK/.anet/nodes/$real_alias/config.json"
  local real_socket real_leader real_state_home real_node_id real_session first_id first_row second_id second_row continuity_nonce
  local first_task_started_ms second_task_started_ms
  local real_log_dir="$WORK/.anet/nodes/$real_alias/logs"
  local real_pending="$WORK/.anet/nodes/$real_alias/pending-replies.json"
  continuity_nonce="GROK_PREVIEW_CONTEXT_225_$(tr -d '-' </proc/sys/kernel/random/uuid)"

  [ -x "$real_bin" ] || fail "RUN_REAL_GROK=1 but real Grok binary is not executable: $real_bin"
  [ -r "$real_auth" ] || fail "RUN_REAL_GROK=1 but real Grok auth is not readable: $real_auth"
  [[ "$($real_bin --version)" =~ ^grok\ 0\.2\.93\ \(f00f96316d\)(\ \[stable\])?$ ]] \
    || fail "optional live gate requires exact Grok 0.2.93"

  [ "$KEYLESS_STATUS" = PASS ] \
    || fail "authenticated gate requires the pinned keyless live gate to pass first"

  mkdir -p "$HOME/.grok" /tmp/test225-real-auth
  cp "$real_auth" "$HOME/.grok/auth.json"
  chmod 600 "$HOME/.grok/auth.json"
  [ ! -r /host-grok/agent_id ] || cp /host-grok/agent_id "$HOME/.grok/agent_id"
  # Treat every nontrivial auth scalar value as private. Do not assume values
  # live under a token/key/secret-shaped field name; upstream schemas may use
  # generic value/content fields.
  refresh_real_auth_patterns "$HOME/.grok/auth.json"

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
  real_leader=$(jq -r '.grokLeaderSocket' "$real_config")
  real_node_id=$(jq -r '.node_id // empty' "$real_config")
  [ -n "$real_node_id" ] || fail "real Grok config omitted its immutable node id"
  real_state_home=$(realpath -m "$GROK_STATE/node-$(printf '%s' "$real_node_id" | sha256sum | cut -c1-24)")
  [ "$(realpath -m "$(dirname "$real_state_home")")" = "$(realpath -m "$GROK_STATE")" ] \
    && [ "$(realpath -m "$real_leader")" = "$real_leader" ] \
    && [ "$(realpath -m "$real_socket")" = "$real_socket" ] \
    && [ "$(dirname "$real_leader")" = "$(dirname "$real_socket")" ] \
    && [ "$real_leader" != "$real_socket" ] \
    || fail "real Grok state/socket identity is not an exact owner-bound profile"
  REAL_STATE_HOME=$real_state_home
  REAL_LEADER_SOCKET=$real_leader
  REAL_ATTACH_SOCKET=$real_socket
  REAL_CWD=$WORK

  env -u ANET_AGENT_NODE_BIN GROK_BINARY="$real_bin" npm_config_offline=true \
    anet node start "$real_alias" >"$REAL_START_LOG" 2>&1 &
  NODE_PROCESS_PID=$!
  wait_file "$real_socket" 600 \
    || fail_with_private_log "real Grok attach socket did not appear" "$REAL_START_LOG"
  assert_installed_candidate_runtime "$real_alias" "real first" "$REAL_START_LOG"
  tmux new-session -d -s test225-real-attach \
    "cd '$WORK' && env -u ANET_AGENT_NODE_BIN HOME='$HOME' PATH='$PATH' anet grok attach '$real_alias'"
  tmux set-window-option -t test225-real-attach:0 remain-on-exit on >/dev/null
  wait_pane test225-real-attach 'attached to Grok TUI' "$REAL_CAPTURE" 300 \
    || fail "optional real TUI did not attach"

  first_task_started_ms=$(date +%s%3N)
  first_id=$(curl -fsS -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg alias "$real_alias" --arg network "$NETWORK_ID" \
      --arg nonce "$continuity_nonce" \
      '{alias:$alias,task:("Do not call search_tool or use_tool. Remember this nonce for my next turn: " + $nonce + ". Reply with exactly GROK_PREVIEW_REAL_225_A and nothing else."),from:"test225-driver",priority:"high",network_id:$network}')" \
    | jq -r '.task_id // .message_id // empty')
  for _ in $(seq 1 1800); do
    first_row=$(curl -fsS "$HUB/api/tasks?limit=80&network_id=$NETWORK_ID" \
      -H "Authorization: Bearer $USER_TOKEN" \
      | jq -c --arg id "$first_id" '.tasks[]? | select(.task_id == $id)' || true)
    fail_if_task_terminal_error \
      "optional real Grok first task" "$first_row" first_task "$first_task_started_ms"
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
  REAL_SESSION_ID=$real_session

  real_first_leader_identity=/tmp/test225-real-first-leader.identity
  snapshot_unix_listener_owner "$real_leader" "$real_first_leader_identity" \
    || fail "optional real first Leader identity was not uniquely observable"
  stop_node_checked "$real_alias" real-first
  capture_stopped_pane test225-real-attach "$REAL_CAPTURE"
  tmux kill-session -t test225-real-attach 2>/dev/null || true
  wait_gone "$real_socket" 600 || fail "optional real attach socket survived stop"
  wait_gone "$real_leader" 600 || fail "optional real leader socket survived stop"
  assert_no_unix_listener "$real_leader" || fail "optional real Leader listener survived stop"
  assert_unix_listener_owner_gone "$real_first_leader_identity" "$real_leader" \
    || fail "optional real first Leader PID generation survived stop"
  wait "$NODE_PROCESS_PID" 2>/dev/null || true
  NODE_PROCESS_PID=""
  wait_no_fallback_runtime 300 \
    || fail "optional real first stop left an agent-node or lock-holder process"
  [ "$(matching_process_count "$real_bin")" -eq 0 ] \
    || fail "optional real first stop left a Grok process"
  assert_no_project_sandbox_placeholders
  refresh_real_auth_patterns "$HOME/.grok/auth.json"
  run_real_auth_evidence_gate first_turn_post_stop \
    "$real_state_home" "$real_session" "$WORK" "$real_leader" "$real_socket" \
    first_start_output "$REAL_START_LOG" \
    first_tui_capture "$REAL_CAPTURE" \
    hub_server_output "$SERVER_LOG" \
    runtime_log_store "$real_log_dir" \
    __grok_state__ "$GROK_STATE" \
    pending_reply_store "$real_pending" \
    stop_output_store "$STOP_LOG_DIR"

  env -u ANET_AGENT_NODE_BIN GROK_BINARY="$real_bin" npm_config_offline=true \
    anet node start "$real_alias" >"$REAL_RESUME_LOG" 2>&1 &
  NODE_PROCESS_PID=$!
  wait_file "$real_socket" 600 || fail "optional real attach socket did not return"
  assert_installed_candidate_runtime "$real_alias" "real resume" "$REAL_RESUME_LOG"
  tmux new-session -d -s test225-real-resume-attach \
    "cd '$WORK' && env -u ANET_AGENT_NODE_BIN HOME='$HOME' PATH='$PATH' anet grok attach '$real_alias'"
  tmux set-window-option -t test225-real-resume-attach:0 remain-on-exit on >/dev/null
  wait_pane test225-real-resume-attach 'attached to Grok TUI' "$REAL_RESUME_CAPTURE" 300 \
    || fail "optional real resume attach failed"

  second_task_started_ms=$(date +%s%3N)
  second_id=$(curl -fsS -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg alias "$real_alias" --arg network "$NETWORK_ID" \
      '{alias:$alias,task:"What nonce did I ask you to remember in the previous turn? Reply with exactly that nonce and nothing else.",from:"test225-driver",priority:"high",network_id:$network}')" \
    | jq -r '.task_id // .message_id // empty')
  for _ in $(seq 1 1800); do
    second_row=$(curl -fsS "$HUB/api/tasks?limit=80&network_id=$NETWORK_ID" \
      -H "Authorization: Bearer $USER_TOKEN" \
      | jq -c --arg id "$second_id" '.tasks[]? | select(.task_id == $id)' || true)
    fail_if_task_terminal_error \
      "optional real Grok resume task" "$second_row" resume_task "$second_task_started_ms"
    jq -e --arg nonce "$continuity_nonce" \
      '.status == "replied" and (.result | contains($nonce))' \
      <<<"$second_row" >/dev/null 2>&1 && break
    sleep 0.2
  done
  jq -e --arg nonce "$continuity_nonce" \
    '.status == "replied" and (.result | contains($nonce))' \
    <<<"$second_row" >/dev/null 2>&1 \
    || fail "optional real Grok resume did not recall the prior-turn nonce"
  wait_pane test225-real-resume-attach "$continuity_nonce" "$REAL_RESUME_CAPTURE" 300 \
    || fail "optional real TUI did not live-render the recalled prior-turn nonce"
  [ "$(jq -r '.grokCliSession' "$real_config")" = "$real_session" ] \
    || fail "optional real stop/resume changed session"

  printf '%s\n%s\n' "$first_row" "$second_row" > /tmp/test225-real-hub-rows
  chmod 600 /tmp/test225-real-hub-rows
  jq -r '.result // ""' <<<"$first_row" >> /tmp/test225-hub-results
  jq -r '.result // ""' <<<"$second_row" >> /tmp/test225-hub-results

  real_resume_leader_identity=/tmp/test225-real-resume-leader.identity
  snapshot_unix_listener_owner "$real_leader" "$real_resume_leader_identity" \
    || fail "optional real resumed Leader identity was not uniquely observable"
  stop_node_checked "$real_alias" real-resumed
  capture_stopped_pane test225-real-resume-attach "$REAL_RESUME_CAPTURE"
  tmux kill-session -t test225-real-resume-attach 2>/dev/null || true
  wait_gone "$real_socket" 600 || fail "optional real resume attach socket survived stop"
  wait_gone "$real_leader" 600 || fail "optional real resume leader socket survived stop"
  assert_no_unix_listener "$real_leader" || fail "optional real resume Leader listener survived stop"
  assert_unix_listener_owner_gone "$real_resume_leader_identity" "$real_leader" \
    || fail "optional real resumed Leader PID generation survived stop"
  wait "$NODE_PROCESS_PID" 2>/dev/null || true
  NODE_PROCESS_PID=""
  wait_no_fallback_runtime 300 \
    || fail "optional real resume stop left an agent-node or lock-holder process"
  [ "$(matching_process_count "$real_bin")" -eq 0 ] \
    || fail "optional real resume stop left a Grok process"
  assert_no_project_sandbox_placeholders
  refresh_real_auth_patterns "$HOME/.grok/auth.json"
  run_real_auth_evidence_gate final_shutdown \
    "$real_state_home" "$real_session" "$WORK" "$real_leader" "$real_socket" \
    gate_report "$REPORT" \
    first_start_output "$REAL_START_LOG" \
    resume_start_output "$REAL_RESUME_LOG" \
    first_tui_capture "$REAL_CAPTURE" \
    resume_tui_capture "$REAL_RESUME_CAPTURE" \
    hub_server_output "$SERVER_LOG" \
    runtime_log_store "$real_log_dir" \
    __grok_state__ "$GROK_STATE" \
    pending_reply_store "$real_pending" \
    stop_output_store "$STOP_LOG_DIR" \
    hub_task_snapshot /tmp/test225-real-hub-rows
  scan_fixed_file /tmp/test225-live-credentials \
    "$REAL_START_LOG" "$REAL_RESUME_LOG" "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" \
    "$real_log_dir" "$GROK_STATE" "$real_pending" "$REPORT" /tmp/test225-real-hub-rows \
    || fail "Hub credential reached a real-node evidence artifact during shutdown"
  scan_fixed_file /tmp/test225-markers \
    "$REAL_START_LOG" "$REAL_RESUME_LOG" "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" \
    "$real_log_dir" "$GROK_STATE" "$real_pending" "$REPORT" /tmp/test225-real-hub-rows \
    || fail "synthetic credential reached a real-node evidence artifact during shutdown"
  pass "optional authenticated real Grok package E2E: live render, reply, stop/resume, auth scan"
  [ "$(file_mode "$real_log_dir")" = 700 ] \
    || fail "real node durable log directory is not mode 0700"
  if find "$real_log_dir" -type f ! -perm 0600 -print -quit | grep -q .; then
    fail "real node durable log directory contains a non-0600 file"
  fi
}

log "[L5] optional pinned keyless Grok gate"
if [ "${RUN_KEYLESS_GROK_GATE:-0}" = 1 ] || [ "${RUN_REAL_GROK:-0}" = 1 ]; then
  run_keyless_gate
  KEYLESS_STATUS=PASS
else
  KEYLESS_STATUS=NOT_RUN
  log "OPTIONAL: pinned keyless Grok gate not requested"
fi

log "[L6] optional authenticated real Grok gate"
if [ "${RUN_REAL_GROK:-0}" = 1 ]; then
  run_real_gate
  REAL_STATUS=PASS
else
  REAL_STATUS='NOT_RUN (set RUN_REAL_GROK=1 and read-only TEST225_REAL_GROK_BIN/TEST225_REAL_GROK_AUTH mounts)'
  log "OPTIONAL: authenticated real Grok gate not requested"
fi

# Freeze the final producer before scanning its log. EXIT cleanup is only a
# safety net and cannot serve as evidence because it runs after the report.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

[ "$(file_mode "$NODE_LOG_DIR")" = 700 ] \
  || fail "final durable agent log directory mode is not 0700"
if find "$NODE_LOG_DIR" -type f ! -perm 0600 -print -quit | grep -q .; then
  fail "final durable agent log directory contains a non-0600 file"
fi
scan_fixed_file /tmp/test225-markers \
  /tmp/test225-candidate-extracted "$REPORT" "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
  "$REAL_START_LOG" "$REAL_RESUME_LOG" "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$RESUME_CAPTURE" \
  "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" "$GROK_STATE" "$PENDING" \
  "$WORK/.anet/nodes/$ALIAS" "$STOP_LOG_DIR" /tmp/test225-hub-results \
  "$LOCAL_REGISTRY_LOG" "$NPX_ENV_OBSERVATION" \
  "$TUI_INVENTORY_EVIDENCE" "$TUI_INVENTORY_DIAGNOSTIC" "$AUTH_EVIDENCE_DIAGNOSTIC" \
  || fail "final synthetic credential scan failed"
scan_fixed_file /tmp/test225-live-credentials \
  /tmp/test225-candidate-extracted "$SERVER_LOG" "$START_LOG" "$RELOAD_LOG" "$RESUME_LOG" \
  "$REAL_START_LOG" "$REAL_RESUME_LOG" "$ATTACH_CAPTURE" "$RELOAD_CAPTURE" "$RESUME_CAPTURE" \
  "$REAL_CAPTURE" "$REAL_RESUME_CAPTURE" "$GROK_STATE" "$PENDING" "$REPORT" \
  "$NODE_LOG_DIR" "$WORK/.anet/nodes/preview-grok-real-225/logs" \
  "$WORK/.anet/nodes/preview-grok-real-225/pending-replies.json" \
  "$STOP_LOG_DIR" /tmp/test225-hub-results /tmp/test225-real-hub-rows \
  "$LOCAL_REGISTRY_LOG" "$NPX_ENV_OBSERVATION" \
  "$TUI_INVENTORY_EVIDENCE" "$TUI_INVENTORY_DIAGNOSTIC" "$AUTH_EVIDENCE_DIAGNOSTIC" \
  || fail "final test Hub credential scan failed"
run_real_auth_evidence_gate final_scan \
  "${REAL_STATE_HOME:--}" "${REAL_SESSION_ID:--}" "${REAL_CWD:--}" \
  "${REAL_LEADER_SOCKET:--}" "${REAL_ATTACH_SOCKET:--}" \
  candidate_package /tmp/test225-candidate-extracted \
  hub_server_output "$SERVER_LOG" \
  deterministic_artifact "$START_LOG" \
  deterministic_artifact "$RELOAD_LOG" \
  deterministic_artifact "$RESUME_LOG" \
  first_start_output "$REAL_START_LOG" \
  resume_start_output "$REAL_RESUME_LOG" \
  deterministic_artifact "$ATTACH_CAPTURE" \
  deterministic_artifact "$RELOAD_CAPTURE" \
  deterministic_artifact "$RESUME_CAPTURE" \
  first_tui_capture "$REAL_CAPTURE" \
  resume_tui_capture "$REAL_RESUME_CAPTURE" \
  __grok_state__ "$GROK_STATE" \
  deterministic_artifact "$PENDING" \
  deterministic_artifact "$WORK/.anet" \
  stop_output_store "$STOP_LOG_DIR" \
  deterministic_artifact /tmp/test225-hub-results \
  hub_task_snapshot /tmp/test225-real-hub-rows \
  gate_report "$REPORT" \
  local_registry_output "$LOCAL_REGISTRY_LOG" \
  environment_observation "$NPX_ENV_OBSERVATION" \
  deterministic_artifact "$TUI_INVENTORY_EVIDENCE" \
  deterministic_artifact "$TUI_INVENTORY_DIAGNOSTIC"

log ""
log "Summary: PASS"
log "package_e2e=PASS"
log "pinned_keyless_live=$KEYLESS_STATUS"
if [ "$KEYLESS_STATUS" = PASS ]; then
  inventory_result_valid "$TUI_INVENTORY_EVIDENCE" passed \
    || fail "keyless evidence changed before report binding"
  log "pinned_keyless_artifact_sha256=$(sha256sum "$TUI_INVENTORY_EVIDENCE" | awk '{print $1}') file=$(basename "$TUI_INVENTORY_EVIDENCE")"
fi
log "real_authenticated_live=$REAL_STATUS"
log "source_escape_hatches=0"
log "npx_preview_fallback=PASS"
log "global_agent_node_resume=PASS"
log "external_publish_actions=0"
log "tmux_input_commands_issued=0"
log "failure_contract_sha256=$(sha256sum "$FAILURE_CONTRACT" | awk '{print $1}')"
while IFS= read -r tarball; do
  log "candidate_tarball_sha256=$(sha256sum "$tarball" | awk '{print $1}') file=$(basename "$tarball")"
done < <(find /candidate -maxdepth 1 -type f -name '*.tgz' | sort)
