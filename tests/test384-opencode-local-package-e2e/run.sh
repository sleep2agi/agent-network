#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

REPORT_DIR="${REPORT_DIR:-/report}"
REPORT="$REPORT_DIR/report-test384.txt"
ROOT=/tmp/test384
WORK_DIR="$ROOT/project"
HUB_PORT=9384
HUB="http://127.0.0.1:${HUB_PORT}"
HUB_DB="$ROOT/commhub-test384.db"
ADMIN_USER=test384_admin
ADMIN_PASSWORD='Test384-Strong-Password!'
LIVE_ALIAS=wizard-openai
FREE_MODEL="${OPENCODE_FREE_MODEL:-opencode/deepseek-v4-flash-free}"
EXPECTED_OPENCODE="${OPENCODE_VERSION_UNDER_TEST:-1.18.1}"
EXPECTED_NETWORK="${AGENT_NETWORK_VERSION_UNDER_TEST:-2.3.0-preview.34}"
EXPECTED_NODE="${AGENT_NODE_VERSION_UNDER_TEST:-2.5.0-preview.26}"
REAL_PATH="$PATH"
FAKE_BIN_DIR=/test384/fake-bin
FAKE_CANONICAL_BIN=/test384/fake-global/node_modules/opencode-ai/bin/opencode.exe
PROFILE_STALE_BIN_DIR=/test384/profile-stale-bin
PROFILE_STALE_MARKER="$ROOT/profile-stale-opencode-was-executed"
PROJECT_LOCAL_BIN_DIR="$WORK_DIR/project-local-bin"
PROJECT_LOCAL_PACKAGE_ROOT="$WORK_DIR/node_modules/opencode-ai"
PROJECT_LOCAL_MARKER="$ROOT/project-local-opencode-was-executed"
PERSISTENT_DATA_ESCAPE="$ROOT/persistent-data-escape"
HOSTILE_ROOT="$ROOT/hostile-parent"
RUN_USER_DIR="/run/user/$(id -u)"
SAFE_BASE="$RUN_USER_DIR/anet-test384-safe"
export ANET_OPENCODE_SAFE_BASE="$SAFE_BASE"
HOSTILE_CONFIG_CONTENT='{"model":"hostile/provider-model","tools":{"bash":true,"read":true,"glob":true,"grep":true,"edit":true,"write":true,"list":true,"task":true,"skill":true,"question":true}}'
ANCESTOR_PLUGIN_MARKER="$WORK_DIR/ancestor-plugin-executed"
ANCESTOR_PLUGIN_URI="file://$WORK_DIR/ancestor-plugin.mjs"
ANCESTOR_PLUGIN_CANARY='sk-ant-test384-ancestor-plugin-NOT-A-REAL-KEY'

# Clearly synthetic placeholders. Values are used for equality assertions but
# never printed or sent to a vendor.
export TEST384_ANTHROPIC_DUMMY='sk-ant-test384-NOT-A-REAL-KEY-REDACTED'
export TEST384_OPENAI_DUMMY='sk-openai-test384-NOT-A-REAL-KEY-REDACTED'
export TEST384_WORK_DIR="$WORK_DIR"
export TEST384_TRACE_DIR="$ROOT/traces"
export AUTH_LOGIN_ANCESTOR_MARKER="$ANCESTOR_PLUGIN_MARKER"

HUB_PID=""
NODE_PID=""
REPORT_PIPE_PID=""
CURRENT_LAYER="bootstrap"
mkdir -p "$REPORT_DIR" "$WORK_DIR" "$TEST384_TRACE_DIR"
mkdir -p /run/user "$RUN_USER_DIR" "$SAFE_BASE"
chmod 755 /run/user
chmod 700 "$RUN_USER_DIR" "$SAFE_BASE"

redact_stream() {
  # Unbuffered output is required because Docker stops the process-substitution
  # helper as soon as PID 1 exits; otherwise a short early failure can leave a
  # zero-byte report and hide the failing assertion.
  sed -u -E \
    -e 's/((ntok|utok|atok)_)[A-Za-z0-9_-]+/\1[REDACTED]/g' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=:-]+/\1[REDACTED]/Ig' \
    -e 's/sk-(ant-|openai-)?[A-Za-z0-9._-]+/sk-[REDACTED]/g'
}

stop_node() {
  local forced=0
  if [[ -n "$NODE_PID" ]] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
    for _ in $(seq 1 150); do
      kill -0 "$NODE_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$NODE_PID" 2>/dev/null; then
      echo "node launcher did not exit within 15s of SIGTERM"
      kill -KILL "$NODE_PID" 2>/dev/null || true
      forced=1
    fi
    wait "$NODE_PID" 2>/dev/null || true
  fi
  NODE_PID=""
  if ! assert_no_opencode_transient_roots "${OPENAI_NODE:-}"; then
    forced=1
  fi
  return "$forced"
}

cleanup() {
  rm -f -- "$SAFE_BASE/opencode.json"
  stop_node || true
  if [[ -n "$HUB_PID" ]] && kill -0 "$HUB_PID" 2>/dev/null; then
    kill -TERM "$HUB_PID" 2>/dev/null || true
    wait "$HUB_PID" 2>/dev/null || true
  fi
}

finish() {
  local rc=$?
  trap - EXIT
  cleanup
  echo
  if [[ "$rc" -eq 0 ]]; then
    echo "OVERALL: PASS"
    echo "trailer: test384 local package -> picker -> security/lifecycle gates -> real OpenCode reply — PASS"
  else
    echo "OVERALL: FAIL at ${CURRENT_LAYER} (exit=${rc})"
    echo "trailer: test384 local package -> picker -> security/lifecycle gates -> real OpenCode reply — FAIL"
  fi
  if [[ -n "$REPORT_PIPE_PID" ]]; then
    exec 1>&3 2>&3
    wait "$REPORT_PIPE_PID" || rc=1
    exec 3>&-
  fi
  exit "$rc"
}
trap finish EXIT

clear_opencode_session() {
  local config="$1/config.json"
  local tmp
  tmp=$(mktemp)
  jq 'del(.session, .resume, .sessionId)' "$config" >"$tmp"
  mv "$tmp" "$config"
  chmod 600 "$config"
}

plant_hostile_ancestor_config() {
  install -m 600 /test384/ancestor_plugin.mjs "$WORK_DIR/ancestor-plugin.mjs"
  jq -nc --arg model 'ancestor-hostile/no-such-model' --arg plugin "$ANCESTOR_PLUGIN_URI" '
    {
      model: $model,
      plugin: [$plugin],
      tools: {
        bash: true, read: true, glob: true, grep: true, edit: true,
        write: true, list: true, task: true, skill: true, question: true
      }
    }
  ' >"$WORK_DIR/opencode.json"
  chmod 600 "$WORK_DIR/opencode.json"
  rm -f -- "$ANCESTOR_PLUGIN_MARKER"
  jq -e --arg plugin "$ANCESTOR_PLUGIN_URI" '
    .model == "ancestor-hostile/no-such-model" and .plugin == [$plugin]
  ' "$WORK_DIR/opencode.json" >/dev/null
}

plant_project_local_opencode_fake() {
  mkdir -p "$PROJECT_LOCAL_PACKAGE_ROOT/bin" "$PROJECT_LOCAL_BIN_DIR"
  install -m 755 /test384/project-local-opencode \
    "$PROJECT_LOCAL_PACKAGE_ROOT/bin/opencode.exe"
  install -m 644 /test384/fake-global/node_modules/opencode-ai/package.json \
    "$PROJECT_LOCAL_PACKAGE_ROOT/package.json"
  ln -s "$PROJECT_LOCAL_PACKAGE_ROOT/bin/opencode.exe" \
    "$PROJECT_LOCAL_BIN_DIR/opencode"
  rm -f -- "$PROJECT_LOCAL_MARKER"
}

wait_node_idle() {
  local log_file="$1"
  local idle=0
  for _ in $(seq 1 300); do
    if grep -q 'SSE connected' "$log_file" 2>/dev/null \
      && curl -fsS "$HUB/api/status?network_id=$NETWORK_ID" \
        -H "Authorization: Bearer $USER_TOKEN" 2>/dev/null \
        | jq -e --arg alias "$LIVE_ALIAS" \
            '.ok == true and any(.sessions[]?; .alias == $alias and .status == "idle")' >/dev/null 2>&1; then
      idle=1
      break
    fi
    kill -0 "$NODE_PID" 2>/dev/null || break
    sleep 0.2
  done
  if [[ "$idle" -ne 1 ]]; then
    echo "node failed to reach idle; safe log tail:"
    tail -80 "$log_file" 2>/dev/null | redact_stream
    return 1
  fi
}

submit_task() {
  local task_text="$1"
  local response
  response=$(curl -fsS -X POST "$HUB/api/task" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg alias "$LIVE_ALIAS" --arg network "$NETWORK_ID" --arg task "$task_text" \
      '{alias:$alias,task:$task,priority:"normal",network_id:$network}')")
  TASK_ID=$(jq -r '.task_id // .message_id // empty' <<<"$response")
  [[ -n "$TASK_ID" ]]
}

wait_task_replied() {
  local expected_text="${1:-}"
  TASK_ROW=""
  for _ in $(seq 1 1200); do
    TASK_ROW=$(curl -fsS "$HUB/api/tasks?limit=50&network_id=$NETWORK_ID" \
      -H "Authorization: Bearer $USER_TOKEN" \
      | jq -c --arg id "$TASK_ID" '.tasks[]? | select((.task_id // .message_id) == $id)' || true)
    jq -e '.status == "replied" and (.result | type == "string" and length > 0)' \
      <<<"$TASK_ROW" >/dev/null 2>&1 && break
    jq -e '.status == "failed" or .status == "cancelled"' <<<"$TASK_ROW" >/dev/null 2>&1 && break
    kill -0 "$NODE_PID" 2>/dev/null || break
    sleep 0.2
  done
  jq -e '.status == "replied" and (.result | type == "string" and length > 0)' \
    <<<"$TASK_ROW" >/dev/null
  if [[ -n "$expected_text" ]]; then
    jq -e --arg expected "$expected_text" '.result == $expected' <<<"$TASK_ROW" >/dev/null
  fi
}

fake_pid_running() {
  local mode="$1"
  local pid_file="$ROOT/fake-opencode-pid-$mode"
  [[ -s "$pid_file" ]] || return 1
  local pid
  pid=$(<"$pid_file")
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq "$FAKE_CANONICAL_BIN"
}

wait_fake_started() {
  local mode="$1"
  for _ in $(seq 1 100); do
    [[ -s "$ROOT/fake-opencode-pid-$mode" && -s "$ROOT/fake-opencode-env-$mode.json" ]] && return 0
    kill -0 "$NODE_PID" 2>/dev/null || break
    sleep 0.1
  done
  echo "fake OpenCode child did not start in mode=$mode"
  return 1
}

wait_fake_gone() {
  local mode="$1"
  for _ in $(seq 1 100); do
    fake_pid_running "$mode" || return 0
    sleep 0.1
  done
  echo "fake OpenCode child survived mode=$mode"
  return 1
}

assert_no_opencode_transient_roots() {
  local node_dir="${1:-}"
  local leaked=""
  for _ in $(seq 1 100); do
    leaked=$(
      if [[ -n "$node_dir" && -d "$node_dir/.runtime" ]]; then
        find "$node_dir/.runtime" -mindepth 1 -maxdepth 1 \
          \( -name 'opencode-launch-*' -o -name '.anet-opencode-launch-*' \
             -o -name 'opencode-auth-login-*' -o -name '.opencode-cleanup-*' \
             -o -name '.anet-opencode-cleanup-*' \
             -o -name '.anet-opencode-auth-cleanup-*' \) -print -quit
      fi
      if [[ -d "$WORK_DIR/.anet/nodes" ]]; then
        while IFS= read -r runtime_dir; do
          [[ "$runtime_dir" == "$node_dir/.runtime" ]] && continue
          find "$runtime_dir" -mindepth 1 -maxdepth 1 \
            \( -name 'opencode-launch-*' -o -name '.anet-opencode-launch-*' \
               -o -name 'opencode-auth-login-*' -o -name '.opencode-cleanup-*' \
               -o -name '.anet-opencode-cleanup-*' \
               -o -name '.anet-opencode-auth-cleanup-*' \) -print -quit
        done < <(find "$WORK_DIR/.anet/nodes" -type d -name .runtime -print)
      fi
      if [[ -d "$SAFE_BASE" ]]; then
        find "$SAFE_BASE" -mindepth 1 -maxdepth 1 \
          \( -name '.anet-opencode-launch-*' -o -name 'opencode-auth-login-*' \
             -o -name '.anet-opencode-version-*' -o -name '.anet-opencode-smoke-*' \
             -o -name '.anet-opencode-upgrade-version-*' \
             -o -name '.anet-opencode-cleanup-*' \
             -o -name '.anet-opencode-auth-cleanup-*' \) -print -quit
      fi
    )
    [[ -z "$leaked" ]] && return 0
    sleep 0.05
  done
  echo "transient OpenCode root survived cleanup: $leaked"
  return 1
}

start_fake_node() {
  local mode="$1"
  local log_file="$2"
  clear_opencode_session "$OPENAI_NODE"
  printf '%s\n' "$mode" >"$ROOT/fake-opencode-mode"
  rm -f -- "$ROOT/fake-opencode-pid-$mode" "$ROOT/fake-opencode-env-$mode.json"
  env \
    PATH="$PROJECT_LOCAL_BIN_DIR:$FAKE_BIN_DIR:$REAL_PATH" \
    TMPDIR="$HOSTILE_ROOT/tmpdir" \
    TMP="$HOSTILE_ROOT/tmp" \
    TEMP="$HOSTILE_ROOT/temp" \
    XDG_CONFIG_HOME="$HOSTILE_ROOT/xdg-config" \
    XDG_DATA_HOME="$HOSTILE_ROOT/xdg-data" \
    XDG_CACHE_HOME="$HOSTILE_ROOT/xdg-cache" \
    XDG_STATE_HOME="$HOSTILE_ROOT/xdg-state" \
    XDG_RUNTIME_DIR="$HOSTILE_ROOT/xdg-runtime" \
    OPENCODE_CONFIG="$HOSTILE_ROOT/opencode-hostile.json" \
    OPENCODE_CONFIG_DIR="$HOSTILE_ROOT/opencode-dir" \
    OPENCODE_CONFIG_CONTENT="$HOSTILE_CONFIG_CONTENT" \
    ANTHROPIC_API_KEY='test384-parent-anthropic-canary' \
    OPENAI_API_KEY='test384-parent-openai-canary' \
    COMMHUB_AUTH_TOKEN='test384-parent-auth-canary' \
    GH_TOKEN='test384-parent-gh-canary' \
    GITHUB_TOKEN='test384-parent-github-canary' \
    NODE_OPTIONS='--no-warnings' \
    NPM_TOKEN='test384-parent-npm-canary' \
    SLACK_BOT_TOKEN='test384-parent-slack-canary' \
    anet node start "$LIVE_ALIAS" >"$log_file" 2>&1 &
  NODE_PID=$!
  wait_node_idle "$log_file"
}

: >"$REPORT"
exec 3>&1
exec > >(redact_stream | tee -a "$REPORT" >&3) 2>&1
REPORT_PIPE_PID=$!

echo "# test384 — opencode local-package preview release gate"
echo
echo "date: $(date -Iseconds)"
echo "node: $(node --version)"
echo "bun: $(bun --version)"
echo "opencode expected: $EXPECTED_OPENCODE"
echo "agent-network expected: $EXPECTED_NETWORK (publish tag preview)"
echo "agent-node expected: $EXPECTED_NODE (publish tag preview)"
echo "free model: $FREE_MODEL"
echo "hub: isolated loopback :$HUB_PORT, db=$HUB_DB"
echo "external safe base: $SAFE_BASE (mode $(stat -c %a "$SAFE_BASE"))"

CURRENT_LAYER="L0 environment + locally packed artifacts"
echo
echo "## L0 — environment + locally packed artifacts"
GLOBAL_ROOT=$(npm root -g)
NETWORK_ROOT="$GLOBAL_ROOT/@sleep2agi/agent-network"
NODE_ROOT="$GLOBAL_ROOT/@sleep2agi/agent-node"
NETWORK_BUNDLE="$NETWORK_ROOT/dist/bin/cli.js"
NODE_BUNDLE="$NODE_ROOT/dist/cli.js"

[[ -x "$(command -v anet)" ]]
[[ -x "$(command -v agent-node)" ]]
[[ -x "$(command -v opencode)" ]]
[[ -f "$NETWORK_BUNDLE" ]]
[[ -f "$NODE_BUNDLE" ]]
[[ "$(opencode --version | tr -d '\r\n')" == "$EXPECTED_OPENCODE" ]]
timeout 20 opencode acp --help >/dev/null

NETWORK_VERSION=$(node -p "require('$NETWORK_ROOT/package.json').version")
NODE_VERSION=$(node -p "require('$NODE_ROOT/package.json').version")
NETWORK_TAG=$(node -p "require('$NETWORK_ROOT/package.json').publishConfig?.tag || ''")
NODE_TAG=$(node -p "require('$NODE_ROOT/package.json').publishConfig?.tag || ''")
NETWORK_TGZ=$(find /artifacts -maxdepth 1 -name 'sleep2agi-agent-network-*.tgz' -print -quit)
NODE_TGZ=$(find /artifacts -maxdepth 1 -name 'sleep2agi-agent-node-*.tgz' -print -quit)
[[ -n "$NETWORK_TGZ" && -n "$NODE_TGZ" ]]
[[ "$NETWORK_VERSION" == "$EXPECTED_NETWORK" ]]
[[ "$NODE_VERSION" == "$EXPECTED_NODE" ]]
[[ "$NETWORK_TAG" == "preview" ]]
[[ "$NODE_TAG" == "preview" ]]

# The function name is intentionally a stable release marker; runtime behavior
# is proved again below through the installed package and a real task.
grep -aFq 'processWithOpencode' "$NODE_BUNDLE"
grep -aFq 'opencode-cli' "$NODE_BUNDLE"
echo "PASS: exact local tarballs installed — agent-network=$NETWORK_VERSION agent-node=$NODE_VERSION; both publishConfig.tag=preview"
echo "PASS: tarball sha256 network=$(sha256sum "$NETWORK_TGZ" | cut -d' ' -f1)"
echo "PASS: tarball sha256 node=$(sha256sum "$NODE_TGZ" | cut -d' ' -f1)"
echo "PASS: agent-node bundle markers processWithOpencode + opencode-cli present"
echo "PASS: opencode-ai exact pin=$EXPECTED_OPENCODE and acp smoke passed"

CURRENT_LAYER="L1 isolated hub + auth"
echo
echo "## L1 — isolated CommHub + real CLI login"
export HOME="$ROOT/home"
mkdir -p "$HOME"
rm -f -- "$HUB_DB"
COMMHUB_DB="$HUB_DB" HOST=127.0.0.1 PORT="$HUB_PORT" \
  bun run /repo/server/bin/commhub.ts --port "$HUB_PORT" --host 127.0.0.1 --db "$HUB_DB" \
  >"$ROOT/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 100); do
  curl -fsS "$HUB/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "$HUB/health" | jq -e '.ok == true' >/dev/null

REGISTER=$(curl -fsS -X POST "$HUB/api/auth/register" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg u "$ADMIN_USER" --arg p "$ADMIN_PASSWORD" '{username:$u,password:$p}')")
echo "$REGISTER" | jq -e '.ok == true and (.token | startswith("utok_")) and (.network_id | startswith("net_"))' >/dev/null
NETWORK_ID=$(echo "$REGISTER" | jq -r '.network_id')

LOGIN_OUT=""
for _ in $(seq 1 30); do
  LOGIN_OUT=$(cd "$WORK_DIR" && anet login --hub "$HUB" --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" 2>&1 || true)
  grep -q 'Logged in as' <<<"$LOGIN_OUT" && break
  sleep 0.2
done
grep -q 'Logged in as' <<<"$LOGIN_OUT"
USER_TOKEN=$(jq -r '.token // empty' "$HOME/.anet/config.json")
[[ "$USER_TOKEN" == utok_* ]]
[[ "$(jq -r '.network_id' "$HOME/.anet/config.json")" == "$NETWORK_ID" ]]
echo "PASS: secured local hub ready; registration + anet login + default network persisted"

CURRENT_LAYER="L1.5 pre-seeded state symlink rejection"
echo
echo "## L1.5 — pre-seeded node-state symlink is rejected before profile secret write"
SYMLINK_OUTSIDE="$ROOT/profile-symlink-outside"
SYMLINK_NODE="$WORK_DIR/.anet/nodes/preseed-link"
mkdir -p "$WORK_DIR/.anet/nodes" "$SYMLINK_OUTSIDE"
chmod 700 "$SYMLINK_OUTSIDE"
ln -s "$SYMLINK_OUTSIDE" "$SYMLINK_NODE"
set +e
(cd "$WORK_DIR" && anet node create preseed-link --runtime opencode-cli) \
  >"$ROOT/preseed-link.log" 2>&1
PRESEED_RC=$?
set -e
[[ "$PRESEED_RC" -ne 0 ]]
[[ ! -e "$SYMLINK_OUTSIDE/config.json" && ! -e "$SYMLINK_OUTSIDE/.env" ]]
grep -Eqi 'refuses|symlink|canonical real directory' "$ROOT/preseed-link.log"
rm -f -- "$SYMLINK_NODE"
assert_no_opencode_transient_roots
echo "PASS: malicious node-root symlink failed closed; ntok profile/config dotenv did not escape"

REGULAR_NODE="$WORK_DIR/.anet/nodes/preseed-regular"
mkdir -m 700 "$REGULAR_NODE"
mkdir -m 700 "$REGULAR_NODE/.config" "$REGULAR_NODE/.local"
mkdir -m 700 "$REGULAR_NODE/.config/opencode" "$REGULAR_NODE/.local/share"
mkdir -m 700 "$REGULAR_NODE/.local/share/opencode"
printf '%s\n' 'PATH=/attacker/bin' 'ANET_OPENCODE_BIN=/attacker/opencode' >"$REGULAR_NODE/.env"
printf '%s\n' '{not valid json' >"$REGULAR_NODE/.config/opencode/opencode.json"
printf '%s\n' '{"anthropic":{"type":"api","key":"preplanted-must-clear"}}' \
  >"$REGULAR_NODE/.local/share/opencode/auth.json"
chmod 600 "$REGULAR_NODE/.env" "$REGULAR_NODE/.config/opencode/opencode.json" \
  "$REGULAR_NODE/.local/share/opencode/auth.json"
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
  bash -c 'cd "$1" && anet node create preseed-regular --runtime opencode-cli' _ "$WORK_DIR" \
  >"$ROOT/preseed-regular.log" 2>&1
[[ ! -s "$REGULAR_NODE/.env" ]]
jq -e '. == {}' "$REGULAR_NODE/.local/share/opencode/auth.json" >/dev/null
jq -e '
  (.model == null)
  and .provider == {anthropic:{options:{}}}
  and .plugin == [] and .mcp == {}
' "$REGULAR_NODE/.config/opencode/opencode.json" >/dev/null
for hint in 'anet opencode auth-login' '--provider anthropic' 'auth.json reset to an empty object'; do
  grep -Fq -- "$hint" "$ROOT/preseed-regular.log"
done
assert_no_opencode_transient_roots "$REGULAR_NODE"
echo "PASS: ordinary pre-planted dotenv/auth/invalid config were atomically reset on keyless create; login hint uses the sandboxed helper"

CURRENT_LAYER="L1.6 exact auth-login isolation + atomic import"
echo
echo "## L1.6 — exact 1.18.1 auth-login uses a disposable root and imports only validated API auth"

# A credential-writing command must not let resolveNodeRef's legacy raw path
# lookup escape .anet/nodes. The outside profile is intentionally valid enough
# that an unsafe implementation would reach its persistent auth file.
TRAVERSAL_NODE="$WORK_DIR/.anet/outside-node"
mkdir -m 700 -p "$TRAVERSAL_NODE/.local/share/opencode"
printf '%s\n' '{"runtime":"opencode-cli","node_name":"outside-node"}' \
  >"$TRAVERSAL_NODE/config.json"
printf '%s\n' '{"anthropic":{"type":"api","key":"sk-ant-traversal-must-stay"}}' \
  >"$TRAVERSAL_NODE/.local/share/opencode/auth.json"
chmod 600 "$TRAVERSAL_NODE/config.json" "$TRAVERSAL_NODE/.local/share/opencode/auth.json"
TRAVERSAL_AUTH_BEFORE=$(sha256sum "$TRAVERSAL_NODE/.local/share/opencode/auth.json" | cut -d' ' -f1)
set +e
(cd "$WORK_DIR" && anet opencode auth-login ../outside-node --provider anthropic) \
  >"$ROOT/auth-login-traversal.log" 2>&1
TRAVERSAL_RC=$?
set -e
[[ "$TRAVERSAL_RC" -ne 0 ]]
[[ "$(sha256sum "$TRAVERSAL_NODE/.local/share/opencode/auth.json" | cut -d' ' -f1)" == "$TRAVERSAL_AUTH_BEFORE" ]]
grep -Fq 'node not found' "$ROOT/auth-login-traversal.log"
assert_no_opencode_transient_roots "$REGULAR_NODE"

# Plant standard OpenCode DB/log/cache/state names as symlinks to a wholly
# empty outside directory. The real upstream login must never see these roots.
AUTH_ESCAPE="$ROOT/auth-login-persistent-escape"
mkdir -m 700 "$AUTH_ESCAPE"
printf '%s\n' '{"anthropic":{"type":"api","key":"sk-ant-old-auth-must-survive-interrupt"}}' \
  >"$REGULAR_NODE/.local/share/opencode/auth.json"
chmod 600 "$REGULAR_NODE/.local/share/opencode/auth.json"
ln -s "$AUTH_ESCAPE/log" "$REGULAR_NODE/.local/share/opencode/log"
ln -s "$AUTH_ESCAPE/db" "$REGULAR_NODE/.local/share/opencode/opencode.db"
ln -s "$AUTH_ESCAPE/cache" "$REGULAR_NODE/.cache/opencode"
ln -s "$AUTH_ESCAPE/state" "$REGULAR_NODE/.local/state/opencode"
ln -s "$AUTH_ESCAPE/runtime" "$REGULAR_NODE/.runtime/persistent-escape-canary"
ln -s "$AUTH_ESCAPE/tmp" "$REGULAR_NODE/.tmp/persistent-escape-canary"

# Put the real 1.18.1 project-discovery exploit fixture in place before the
# first interactive prompt. The pexpect driver checks the marker immediately
# after the prompt is rendered and once more after the helper exits.
plant_hostile_ancestor_config
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]

AUTH_BEFORE_INTERRUPT=$(sha256sum "$REGULAR_NODE/.local/share/opencode/auth.json" | cut -d' ' -f1)
python3 /test384/auth_login_probe.py interrupt "$WORK_DIR" preseed-regular
[[ "$(sha256sum "$REGULAR_NODE/.local/share/opencode/auth.json" | cut -d' ' -f1)" == "$AUTH_BEFORE_INTERRUPT" ]]
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]
assert_no_opencode_transient_roots "$REGULAR_NODE"
[[ -z "$(find "$AUTH_ESCAPE" -mindepth 1 -print -quit)" ]]

TEST_AUTH_LOGIN_KEY="$TEST384_ANTHROPIC_DUMMY" \
  python3 /test384/auth_login_probe.py success "$WORK_DIR" preseed-regular
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]
jq -e --arg expected "$TEST384_ANTHROPIC_DUMMY" \
  '. == {anthropic:{type:"api",key:$expected}}' \
  "$REGULAR_NODE/.local/share/opencode/auth.json" >/dev/null
[[ "$(stat -c %a "$REGULAR_NODE/.local/share/opencode/auth.json")" == 600 ]]
for planted in \
  "$REGULAR_NODE/.local/share/opencode/log" \
  "$REGULAR_NODE/.local/share/opencode/opencode.db" \
  "$REGULAR_NODE/.cache/opencode" \
  "$REGULAR_NODE/.local/state/opencode" \
  "$REGULAR_NODE/.runtime/persistent-escape-canary" \
  "$REGULAR_NODE/.tmp/persistent-escape-canary"; do
  [[ -L "$planted" ]]
done
assert_no_opencode_transient_roots "$REGULAR_NODE"
[[ -z "$(find "$AUTH_ESCAPE" -mindepth 1 -print -quit)" ]]
echo "PASS: traversal ref rejected; interrupted login preserved old auth; successful exact-pin login atomically imported only anthropic API auth"
echo "PASS: auth-login temporary roots=0 and planted persistent DB/log/cache/state/runtime/tmp links caused zero outside writes"
echo "PASS: real auth prompt/interrupt/success never executed the malicious project-ancestor plugin"

CURRENT_LAYER="L2 real PTY picker, both create entry points"
echo
echo "## L2 — real pexpect picker: unnamed/Anthropic + named/OpenAI"
python3 /test384/wizard_probe.py
echo "PASS: both installed-bundle picker paths rendered the exact 6-choice canonical-main set/order, selected opencode-cli, and exited 0"

CURRENT_LAYER="L3 preset materialization"
echo
echo "## L3 — preset auth/config materialization and permissions"
ANTHROPIC_NODE="$WORK_DIR/.anet/nodes/wizard-anthropic"
OPENAI_NODE="$WORK_DIR/.anet/nodes/wizard-openai"

for node in "$ANTHROPIC_NODE" "$OPENAI_NODE"; do
  [[ -f "$node/config.json" ]]
  jq -e '.runtime == "opencode-cli"' "$node/config.json" >/dev/null
  [[ -f "$node/.local/share/opencode/auth.json" ]]
  [[ -f "$node/.config/opencode/opencode.json" ]]
  [[ "$(stat -c %a "$node/.local/share/opencode/auth.json")" == 600 ]]
  [[ "$(stat -c %a "$node/.config/opencode/opencode.json")" == 600 ]]
  for private_dir in \
    "$node" "$node/.config" "$node/.config/opencode" \
    "$node/.local" "$node/.local/share" "$node/.local/share/opencode" \
    "$node/.local/state" "$node/.cache" "$node/.runtime" "$node/.tmp"; do
    [[ "$(stat -c %a "$private_dir")" == 700 ]]
  done
  jq -e '
    .tools as $t
    | $t.bash == false and $t.read == false and $t.glob == false
      and $t.grep == false and $t.edit == false and $t.write == false
      and $t.list == false and $t.task == false and $t.skill == false
      and $t.question == false
  ' "$node/.config/opencode/opencode.json" >/dev/null
done

jq -e --arg expected "$TEST384_ANTHROPIC_DUMMY" \
  '.anthropic.type == "api" and .anthropic.key == $expected and (keys == ["anthropic"])' \
  "$ANTHROPIC_NODE/.local/share/opencode/auth.json" >/dev/null
jq -e '.provider.anthropic.options | type == "object"' \
  "$ANTHROPIC_NODE/.config/opencode/opencode.json" >/dev/null
jq -e --arg expected "$TEST384_OPENAI_DUMMY" \
  '.openai.type == "api" and .openai.key == $expected and (keys == ["openai"])' \
  "$OPENAI_NODE/.local/share/opencode/auth.json" >/dev/null
jq -e '.provider.openai.options | type == "object"' \
  "$OPENAI_NODE/.config/opencode/opencode.json" >/dev/null
HOME="$ANTHROPIC_NODE" \
  XDG_CONFIG_HOME="$ANTHROPIC_NODE/.config" \
  XDG_DATA_HOME="$ANTHROPIC_NODE/.local/share" \
  XDG_CACHE_HOME="$ANTHROPIC_NODE/.cache" \
  XDG_STATE_HOME="$ANTHROPIC_NODE/.local/state" \
  opencode auth list >"$ROOT/opencode-auth-anthropic.txt" 2>&1
HOME="$OPENAI_NODE" \
  XDG_CONFIG_HOME="$OPENAI_NODE/.config" \
  XDG_DATA_HOME="$OPENAI_NODE/.local/share" \
  XDG_CACHE_HOME="$OPENAI_NODE/.cache" \
  XDG_STATE_HOME="$OPENAI_NODE/.local/state" \
  opencode auth list >"$ROOT/opencode-auth-openai.txt" 2>&1
grep -q 'Anthropic' "$ROOT/opencode-auth-anthropic.txt"
grep -q 'OpenAI' "$ROOT/opencode-auth-openai.txt"

# Ask the exact upstream binary to resolve its effective default-agent tool
# inventory from each preset. Config-file assertions alone would miss an
# upstream schema/merge change that silently re-enabled a tool.
for pair in "anthropic:$ANTHROPIC_NODE" "openai:$OPENAI_NODE"; do
  label=${pair%%:*}
  node=${pair#*:}
  env -i \
    PATH="$REAL_PATH" HOME="$node" \
    XDG_CONFIG_HOME="$node/.config" \
    XDG_DATA_HOME="$node/.local/share" \
    XDG_CACHE_HOME="$node/.cache" \
    XDG_STATE_HOME="$node/.local/state" \
    OPENCODE_CONFIG="$node/.config/opencode/opencode.json" \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    timeout 30 opencode debug agent build >"$ROOT/opencode-effective-$label.json"
  jq -e '
    .tools as $t
    | $t.bash == false and $t.read == false and $t.glob == false
      and $t.grep == false and ($t.edit // false) == false
      and ($t.write // false) == false and ($t.list // false) == false
      and $t.task == false and $t.skill == false
      and $t.question == false
  ' "$ROOT/opencode-effective-$label.json" >/dev/null
done
echo "PASS: Anthropic/OpenAI provider shapes and synthetic dummy-key equality verified (values redacted)"
echo "PASS: opencode-ai@$EXPECTED_OPENCODE auth list consumed both node-scoped preset files"
echo "PASS: both auth.json and opencode.json are mode 600 for both nodes"
echo "PASS: node and persistent OpenCode state roots are pre-created mode 700"
echo "PASS: preset + upstream effective config disable bash/read/glob/grep/edit/write/list/task/skill/question"

CURRENT_LAYER="L3.5 post-create state replacement rejection"
echo
echo "## L3.5 — post-create config/dotenv replacement cannot bypass the OpenCode binding"
POSTCREATE_PAYLOAD="$ROOT/postcreate-node-options.cjs"
POSTCREATE_MARKER="$ROOT/postcreate-node-options-executed"
printf '%s\n' \
  "require('node:fs').writeFileSync('/tmp/test384/postcreate-node-options-executed', 'executed\\n');" \
  >"$POSTCREATE_PAYLOAD"
chmod 600 "$POSTCREATE_PAYLOAD"

# A profile that was safe when created must not become attacker-controlled via
# a later config.json symlink. Keep the outside target valid and alias-matching
# so a non-zero exit cannot be credited to malformed JSON or failed lookup.
CONFIG_BACKUP="$ROOT/wizard-openai-config.before-symlink"
CONFIG_OUTSIDE="$ROOT/wizard-openai-config.outside"
cp -p -- "$OPENAI_NODE/config.json" "$CONFIG_BACKUP"
jq '.postCreateSentinel = "must-not-change"' "$CONFIG_BACKUP" >"$CONFIG_OUTSIDE"
chmod 600 "$CONFIG_OUTSIDE"
CONFIG_OUTSIDE_BEFORE=$(sha256sum "$CONFIG_OUTSIDE" | cut -d' ' -f1)
rm -f -- "$OPENAI_NODE/config.json"
ln -s "$CONFIG_OUTSIDE" "$OPENAI_NODE/config.json"
set +e
timeout --signal=TERM --kill-after=2 10 \
  anet node start "$LIVE_ALIAS" >"$ROOT/postcreate-config-symlink.log" 2>&1
CONFIG_SYMLINK_RC=$?
set -e
rm -f -- "$OPENAI_NODE/config.json"
mv -- "$CONFIG_BACKUP" "$OPENAI_NODE/config.json"
chmod 600 "$OPENAI_NODE/config.json"
CONFIG_OUTSIDE_AFTER=$(sha256sum "$CONFIG_OUTSIDE" | cut -d' ' -f1)
[[ "$CONFIG_SYMLINK_RC" -ne 0 ]]
[[ "$CONFIG_SYMLINK_RC" -ne 124 && "$CONFIG_SYMLINK_RC" -ne 137 ]]
[[ "$CONFIG_OUTSIDE_AFTER" == "$CONFIG_OUTSIDE_BEFORE" ]]

# A regular-file replacement is more subtle than a symlink: switch the stored
# runtime to Claude and plant NODE_OPTIONS in profile.env. The external binding
# must keep this node on the hardened OpenCode start path and reject the runtime
# mismatch before any agent-node process can execute the payload.
CONFIG_BACKUP="$ROOT/wizard-openai-config.before-downgrade"
CONFIG_MUTATED="$ROOT/wizard-openai-config.downgraded"
cp -p -- "$OPENAI_NODE/config.json" "$CONFIG_BACKUP"
jq --arg payload "$POSTCREATE_PAYLOAD" '
  .runtime = "claude-agent-sdk"
  | .env = ((.env // {}) + {NODE_OPTIONS: ("--require=" + $payload)})
' "$CONFIG_BACKUP" >"$CONFIG_MUTATED"
mv -- "$CONFIG_MUTATED" "$OPENAI_NODE/config.json"
chmod 600 "$OPENAI_NODE/config.json"
rm -f -- "$POSTCREATE_MARKER"
set +e
timeout --signal=TERM --kill-after=2 10 \
  anet node start "$LIVE_ALIAS" >"$ROOT/postcreate-runtime-downgrade.log" 2>&1
RUNTIME_DOWNGRADE_RC=$?
set -e
mv -- "$CONFIG_BACKUP" "$OPENAI_NODE/config.json"
chmod 600 "$OPENAI_NODE/config.json"
[[ "$RUNTIME_DOWNGRADE_RC" -ne 0 ]]
[[ "$RUNTIME_DOWNGRADE_RC" -ne 124 && "$RUNTIME_DOWNGRADE_RC" -ne 137 ]]
[[ ! -e "$POSTCREATE_MARKER" ]]

# Dotenv gets the same post-create treatment. A symlinked external dotenv must
# fail closed before its NODE_OPTIONS value is read or a child process starts.
DOTENV_BACKUP="$ROOT/wizard-openai-dotenv.before-symlink"
DOTENV_OUTSIDE="$ROOT/wizard-openai-dotenv.outside"
DOTENV_WAS_PRESENT=0
if [[ -e "$OPENAI_NODE/.env" ]]; then
  cp -p -- "$OPENAI_NODE/.env" "$DOTENV_BACKUP"
  DOTENV_WAS_PRESENT=1
fi
printf '%s\n' \
  "NODE_OPTIONS=--require=$POSTCREATE_PAYLOAD" \
  'TEST384_POSTCREATE_SENTINEL=must-not-change' \
  >"$DOTENV_OUTSIDE"
chmod 600 "$DOTENV_OUTSIDE"
DOTENV_OUTSIDE_BEFORE=$(sha256sum "$DOTENV_OUTSIDE" | cut -d' ' -f1)
rm -f -- "$OPENAI_NODE/.env" "$POSTCREATE_MARKER"
ln -s "$DOTENV_OUTSIDE" "$OPENAI_NODE/.env"
set +e
timeout --signal=TERM --kill-after=2 10 \
  anet node start "$LIVE_ALIAS" >"$ROOT/postcreate-dotenv-symlink.log" 2>&1
DOTENV_SYMLINK_RC=$?
set -e
rm -f -- "$OPENAI_NODE/.env"
if [[ "$DOTENV_WAS_PRESENT" -eq 1 ]]; then
  mv -- "$DOTENV_BACKUP" "$OPENAI_NODE/.env"
  chmod 600 "$OPENAI_NODE/.env"
fi
DOTENV_OUTSIDE_AFTER=$(sha256sum "$DOTENV_OUTSIDE" | cut -d' ' -f1)
[[ "$DOTENV_SYMLINK_RC" -ne 0 ]]
[[ "$DOTENV_SYMLINK_RC" -ne 124 && "$DOTENV_SYMLINK_RC" -ne 137 ]]
[[ "$DOTENV_OUTSIDE_AFTER" == "$DOTENV_OUTSIDE_BEFORE" ]]
[[ ! -e "$POSTCREATE_MARKER" ]]
assert_no_opencode_transient_roots "$OPENAI_NODE"
echo "PASS: post-create config.json symlink was refused; external target stayed byte-identical"
echo "PASS: regular runtime downgrade was refused by the external OpenCode binding before NODE_OPTIONS execution"
echo "PASS: post-create .env symlink was refused; external target stayed byte-identical and payload did not run"

CURRENT_LAYER="L4 hostile parent env + authoritative safe child env"
echo
echo "## L4 — hostile inherited config/XDG + child env allowlist"
# Keep the safe tool policy written by the create flow while switching only
# the provider/model for the later free-model call.
rm -f -- "$OPENAI_NODE/.local/share/opencode/auth.json"
MODEL_CONFIG_TMP=$(mktemp)
jq --arg model "$FREE_MODEL" '.model = $model | del(.provider)' \
  "$OPENAI_NODE/.config/opencode/opencode.json" >"$MODEL_CONFIG_TMP"
mv "$MODEL_CONFIG_TMP" "$OPENAI_NODE/.config/opencode/opencode.json"
chmod 600 "$OPENAI_NODE/.config/opencode/opencode.json"
PROFILE_TMP=$(mktemp)
jq --arg path "$PROFILE_STALE_BIN_DIR:$REAL_PATH" '
  .env = ((.env // {}) + {
    PATH: $path,
    ANET_OPENCODE_BIN: "/test384/profile-stale-bin/opencode",
    ANET_OPENCODE_VERSION: "1.17.13"
  })
' "$OPENAI_NODE/config.json" >"$PROFILE_TMP"
mv "$PROFILE_TMP" "$OPENAI_NODE/config.json"
chmod 600 "$OPENAI_NODE/config.json"
rm -f -- "$PROFILE_STALE_MARKER"

# Exact 1.18.1 writes databases/logs below XDG_DATA_HOME and follows planted
# descendants. Plant both known escape shapes in the persistent node tree;
# the runtime must use a fresh launch data root and leave this outside target
# completely empty through fake and real ACP turns.
PERSISTENT_DATA_DIR="$OPENAI_NODE/.local/share/opencode"
safe_rm_rf "$PERSISTENT_DATA_DIR/log"
rm -f -- "$PERSISTENT_DATA_DIR"/opencode.db*
safe_rm_rf "$PERSISTENT_DATA_ESCAPE"
mkdir -m 700 "$PERSISTENT_DATA_ESCAPE"
ln -s "$PERSISTENT_DATA_ESCAPE" "$PERSISTENT_DATA_DIR/log"
ln -s "$PERSISTENT_DATA_ESCAPE/opencode.db" "$PERSISTENT_DATA_DIR/opencode.db"

# The hostile ancestor fixture was planted before L1.6 and must remain
# unchanged and unexecuted. Do not recreate it here and hide an earlier hit.
jq -e --arg plugin "$ANCESTOR_PLUGIN_URI" '
  .model == "ancestor-hostile/no-such-model" and .plugin == [$plugin]
' "$WORK_DIR/opencode.json" >/dev/null
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]

# This exact-version, package-shaped executable lives below the requested
# project and is first on PATH. The launchers must skip it in favor of the
# external package-owned fixture.
plant_project_local_opencode_fake

mkdir -p "$HOSTILE_ROOT/opencode-dir" "$HOSTILE_ROOT/xdg-config" \
  "$HOSTILE_ROOT/xdg-data" "$HOSTILE_ROOT/xdg-cache" "$HOSTILE_ROOT/xdg-state" \
  "$HOSTILE_ROOT/xdg-runtime" "$HOSTILE_ROOT/tmpdir" "$HOSTILE_ROOT/tmp" "$HOSTILE_ROOT/temp"
printf '%s\n' "$HOSTILE_CONFIG_CONTENT" >"$HOSTILE_ROOT/opencode-hostile.json"

cd "$WORK_DIR"
start_fake_node good "$ROOT/node-fake-good.log"
submit_task "Return the deterministic security probe response."
wait_fake_started good
wait_task_replied "[$LIVE_ALIAS] SECURITY_PROBE_OK"
python3 /test384/assert_security_dump.py \
  "$ROOT/fake-opencode-env-good.json" "$OPENAI_NODE" "$WORK_DIR" \
  "$HOSTILE_ROOT" "$SAFE_BASE" "$FAKE_CANONICAL_BIN"
[[ ! -e "$PROFILE_STALE_MARKER" ]]
[[ ! -e "$PROJECT_LOCAL_MARKER" ]]
[[ -z "$(find "$PERSISTENT_DATA_ESCAPE" -mindepth 1 -print -quit)" ]]
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]
stop_node
wait_fake_gone good
assert_no_opencode_transient_roots "$OPENAI_NODE"
echo "PASS: fake ACP task replied through installed launchers; credential env names were absent"
echo "PASS: same-version project-local opencode-ai impersonator was skipped; canonical external package fake ran"
echo "PASS: hostile XDG/OPENCODE_CONFIG* lost precedence; discovery controls present; fresh launch root cleaned"

CURRENT_LAYER="L5 handshake failure + opening-window orphan cleanup"
echo
echo "## L5 — rejected handshake and SIGTERM during opening leave no child"
start_fake_node reject "$ROOT/node-fake-reject.log"
submit_task "Trigger the intentional rejected ACP handshake."
wait_fake_started reject
wait_fake_gone reject
assert_no_opencode_transient_roots "$OPENAI_NODE"
kill -0 "$NODE_PID"
stop_node
echo "PASS: child that rejected initialize and stayed alive was explicitly reaped"

start_fake_node hang "$ROOT/node-fake-hang.log"
submit_task "Hold the ACP initialize request open until supervisor shutdown."
wait_fake_started hang
stop_node
wait_fake_gone hang
assert_no_opencode_transient_roots "$OPENAI_NODE"
echo "PASS: SIGTERM during unresolved initialize reaped agent-node + opening OpenCode child"

CURRENT_LAYER="L5.5 external safe-base ancestor candidate pre-spawn refusal"
echo
echo "## L5.5 — external safe-base ancestor candidate refuses before ACP spawn"
clear_opencode_session "$OPENAI_NODE"
printf '%s\n' good >"$ROOT/fake-opencode-mode"
rm -f -- "$ROOT/fake-opencode-pid-good" "$ROOT/fake-opencode-env-good.json"
printf '%s\n' '{}' >"$SAFE_BASE/opencode.json"
chmod 600 "$SAFE_BASE/opencode.json"
set +e
env PATH="$PROJECT_LOCAL_BIN_DIR:$FAKE_BIN_DIR:$REAL_PATH" \
  timeout --signal=TERM --kill-after=2 10 \
  anet node start "$LIVE_ALIAS" >"$ROOT/node-safe-base-candidate.log" 2>&1
SAFE_BASE_CANDIDATE_RC=$?
set -e
rm -f -- "$SAFE_BASE/opencode.json"
assert_no_opencode_transient_roots "$OPENAI_NODE"
[[ "$SAFE_BASE_CANDIDATE_RC" -ne 0 ]]
[[ "$SAFE_BASE_CANDIDATE_RC" -ne 124 && "$SAFE_BASE_CANDIDATE_RC" -ne 137 ]]
[[ ! -e "$ROOT/fake-opencode-pid-good" ]]
grep -Eqi 'ancestor discovery candidate|safe workspace|refuses' \
  "$ROOT/node-safe-base-candidate.log"
echo "PASS: candidate in trusted-base ancestor chain hard-failed before OpenCode ACP spawn; transient roots=0"

CURRENT_LAYER="L6 exact 1.18.1 ancestor config/plugin isolation + real replied task"
echo
echo "## L6 — exact 1.18.1 real task ignores malicious ancestor config/plugin"
clear_opencode_session "$OPENAI_NODE"
[[ "$(opencode --version | tr -d '\r\n')" == "$EXPECTED_OPENCODE" ]]
jq -e --arg model "$FREE_MODEL" '.model == $model' \
  "$OPENAI_NODE/.config/opencode/opencode.json" >/dev/null
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]
env -u OPENAI_API_KEY \
  ANTHROPIC_API_KEY="$ANCESTOR_PLUGIN_CANARY" \
  PATH="$REAL_PATH" \
  TMPDIR="$HOSTILE_ROOT/tmpdir" \
  TMP="$HOSTILE_ROOT/tmp" \
  TEMP="$HOSTILE_ROOT/temp" \
  XDG_CONFIG_HOME="$HOSTILE_ROOT/xdg-config" \
  XDG_DATA_HOME="$HOSTILE_ROOT/xdg-data" \
  XDG_CACHE_HOME="$HOSTILE_ROOT/xdg-cache" \
  XDG_STATE_HOME="$HOSTILE_ROOT/xdg-state" \
  XDG_RUNTIME_DIR="$HOSTILE_ROOT/xdg-runtime" \
  OPENCODE_CONFIG="$HOSTILE_ROOT/opencode-hostile.json" \
  OPENCODE_CONFIG_DIR="$HOSTILE_ROOT/opencode-dir" \
  OPENCODE_CONFIG_CONTENT="$HOSTILE_CONFIG_CONTENT" \
  GH_TOKEN='test384-parent-gh-canary' \
  NODE_OPTIONS='--no-warnings' \
  NPM_TOKEN='test384-parent-npm-canary' \
  anet node start "$LIVE_ALIAS" >"$ROOT/node.log" 2>&1 &
NODE_PID=$!
wait_node_idle "$ROOT/node.log"
echo "PASS: installed agent-network launched installed agent-node; alias reached idle"

submit_task "Reply in one short sentence confirming the preview OpenCode end-to-end test."
wait_task_replied
jq -e '.result | test("[A-Za-z]")' <<<"$TASK_ROW" >/dev/null
if [[ -e "$ANCESTOR_PLUGIN_MARKER" ]]; then
  echo "malicious ancestor OpenCode plugin execution marker detected"
  false
fi
if [[ -e "$PROFILE_STALE_MARKER" ]]; then
  echo "profile-controlled stale OpenCode executable was invoked"
  false
fi
if [[ -n "$(find "$PERSISTENT_DATA_ESCAPE" -mindepth 1 -print -quit)" ]]; then
  echo "persistent node-data symlink caused an external DB/log write"
  false
fi
if grep -Fq -- "$ANCESTOR_PLUGIN_CANARY" "$ROOT/node.log" \
  || grep -Fq -- "$ANCESTOR_PLUGIN_CANARY" <<<"$TASK_ROW"; then
  echo "synthetic ancestor-plugin canary reached task output or node log"
  false
fi
RESULT_LEN=$(jq -r '.result | length' <<<"$TASK_ROW")
echo "PASS: task ${TASK_ID:0:8}... reached replied under hostile parent overrides; result length=$RESULT_LEN"
echo "PASS: exact opencode-ai@$EXPECTED_OPENCODE kept node free model authoritative; ancestor file-plugin marker absent"
echo "safe node-log evidence:"
grep -E 'SSE connected|processing \[opencode\]|session/new|turn done|sending reply' "$ROOT/node.log" \
  | tail -20 \
  | redact_stream || true
kill -0 "$NODE_PID"

CURRENT_LAYER="L7 clean shutdown + orphan audit"
echo
echo "## L7 — graceful shutdown + global orphan audit"
stop_node
sleep 0.5
assert_no_opencode_transient_roots "$OPENAI_NODE"
[[ ! -e "$ANCESTOR_PLUGIN_MARKER" ]]
[[ ! -e "$PROFILE_STALE_MARKER" ]]
[[ ! -e "$PROJECT_LOCAL_MARKER" ]]
[[ -z "$(find "$PERSISTENT_DATA_ESCAPE" -mindepth 1 -print -quit)" ]]

ORPHANS=$(python3 - <<'PY'
from pathlib import Path

rows = []
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        cmd = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if not cmd:
        continue
    if 'agent-node' in cmd or ('opencode' in cmd and ' acp' in f' {cmd}'):
        rows.append(f'{entry.name} {cmd}')
print('\n'.join(rows))
PY
)
if [[ -n "$ORPHANS" ]]; then
  echo "orphan process(es) detected:"
  echo "$ORPHANS"
  false
fi
echo "PASS: launcher exited on SIGTERM; zero agent-node/opencode-acp orphan processes"

CURRENT_LAYER="L8 binding rename/delete lifecycle"
echo
echo "## L8 — external OpenCode binding follows rename/delete lifecycle"
BINDING_ROOT="$HOME/.anet/opencode-runtime-bindings"
BINDINGS_BEFORE=$(find "$BINDING_ROOT" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
# 3 = wizard-openai + wizard-anthropic + preseed-regular: saveProfile writes a
# runtime binding for EVERY opencode-cli node by design (immutable runtime
# identity recorded outside the project — see opencode-runtime-binding.ts).
[[ "$BINDINGS_BEFORE" -eq 3 ]]

# A project-local runtime downgrade must not be launderable through rename.
# The preflight gate runs before save/copy/lock, leaving the original binding
# and directory byte-for-byte recoverable for the operator.
ANTHROPIC_CONFIG="$ANTHROPIC_NODE/config.json"
ANTHROPIC_CONFIG_BACKUP="$ROOT/wizard-anthropic-config.before-rename-downgrade"
cp "$ANTHROPIC_CONFIG" "$ANTHROPIC_CONFIG_BACKUP"
jq '.runtime = "claude-code-cli"' "$ANTHROPIC_CONFIG_BACKUP" >"$ANTHROPIC_CONFIG"
chmod 600 "$ANTHROPIC_CONFIG"
set +e
DOWNGRADE_RENAME_OUT=$(cd "$WORK_DIR" && anet node rename wizard-anthropic should-not-exist 2>&1)
DOWNGRADE_RENAME_RC=$?
set -e
[[ "$DOWNGRADE_RENAME_RC" -ne 0 ]]
grep -q 'Refusing to rename externally-bound OpenCode node' <<<"$DOWNGRADE_RENAME_OUT"
[[ -d "$ANTHROPIC_NODE" ]]
[[ ! -e "$WORK_DIR/.anet/nodes/should-not-exist" ]]
[[ ! -e "$ANTHROPIC_NODE/rename.lock" ]]
[[ "$(find "$BINDING_ROOT" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')" -eq "$BINDINGS_BEFORE" ]]
grep -Rqs '"nodeId": "wizard-anthropic"' "$BINDING_ROOT"
cp "$ANTHROPIC_CONFIG_BACKUP" "$ANTHROPIC_CONFIG"
chmod 600 "$ANTHROPIC_CONFIG"
echo "PASS: downgraded bound OpenCode profile cannot launder its runtime through rename"

# This node was created but never started, so rename exercises the local-only
# rollback-safe branch. The external binding must move with the node identity:
# one new record, no stale old-name record, and no net count change.
(cd "$WORK_DIR" && anet node rename wizard-anthropic wizard-anthropic-renamed)
[[ ! -e "$ANTHROPIC_NODE" ]]
RENAMED_ANTHROPIC_NODE="$WORK_DIR/.anet/nodes/wizard-anthropic-renamed"
[[ -d "$RENAMED_ANTHROPIC_NODE" ]]
BINDINGS_AFTER_RENAME=$(find "$BINDING_ROOT" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
[[ "$BINDINGS_AFTER_RENAME" -eq "$BINDINGS_BEFORE" ]]
! grep -Rqs '"nodeId": "wizard-anthropic"' "$BINDING_ROOT"
grep -Rqs '"nodeId": "wizard-anthropic-renamed"' "$BINDING_ROOT"
echo "PASS: local-only OpenCode rename replaced the external binding without a stale old-name record"

# Delete must remove the exact external record before deleting project state.
# Reusing the same alias as an unrelated runtime then proves both cleanup and
# that an existing binding root plus HOME/.anet=0775 cannot gate other nodes.
(cd "$WORK_DIR" && anet node delete "$LIVE_ALIAS" --force)
[[ ! -e "$OPENAI_NODE" ]]
BINDINGS_AFTER_DELETE=$(find "$BINDING_ROOT" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
[[ "$BINDINGS_AFTER_DELETE" -eq $((BINDINGS_BEFORE - 1)) ]]
! grep -Rqs '"nodeId": "wizard-openai"' "$BINDING_ROOT"

chmod 775 "$HOME/.anet"
mkdir -p "$OPENAI_NODE"
chmod 700 "$OPENAI_NODE"
cat >"$OPENAI_NODE/config.json" <<'JSON'
{
  "anet_version": "test384-reuse",
  "node_id": "n_test384_reuse",
  "node_name": "wizard-openai",
  "alias": "wizard-openai",
  "runtime": "future-runtime-after-delete"
}
JSON
chmod 600 "$OPENAI_NODE/config.json"
set +e
REUSE_OUT=$(cd "$WORK_DIR" && anet node start "$LIVE_ALIAS" 2>&1)
REUSE_RC=$?
set -e
[[ "$REUSE_RC" -ne 0 ]]
grep -q 'unsupported runtime "future-runtime-after-delete"' <<<"$REUSE_OUT"
echo "PASS: delete removed the binding; same-name non-OpenCode reuse bypassed HOME/.anet=0775 and reached strict runtime validation"
