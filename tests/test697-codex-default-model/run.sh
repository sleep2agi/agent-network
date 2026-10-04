#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ROOT=${TEST697_ROOT:-/workspace}
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test697-codex-default-model.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test697 — supported Codex default model"
echo "source_commit=${TEST697_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

HOME_DIR=$(mktemp -d /tmp/test697-home.XXXXXX)
PROJECT_DIR=$(mktemp -d /tmp/test697-project.XXXXXX)
DB_PATH=$(mktemp /tmp/test697-db.XXXXXX.sqlite)
FAKE_BIN=$(mktemp -d /tmp/test697-bin.XXXXXX)
SERVER_PID=""
NODE_PID=""
cleanup() {
  if [[ -n "$NODE_PID" ]]; then kill -TERM -- "-$NODE_PID" >/dev/null 2>&1 || true; wait "$NODE_PID" 2>/dev/null || true; fi
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
  safe_rm_rf "$HOME_DIR" "$PROJECT_DIR" "$FAKE_BIN"
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
}
trap cleanup EXIT

echo "L0 unit seams and strict runtime boundary"
bun test \
  "$ROOT/agent-network/src/codex-model-default.test.ts" \
  "$ROOT/agent-network/src/normalize-runtime.test.ts" \
  "$ROOT/agent-node/src/codex-model-default.test.ts"

echo "L1 full production denominator has no retired default"
PRODUCTION_ROOTS=(
  "$ROOT/agent-network/bin/cli.ts"
  "$ROOT/agent-network/src"
  "$ROOT/agent-node/src"
)
for production_root in "${PRODUCTION_ROOTS[@]}"; do
  [[ -e "$production_root" ]] || { echo "PRODUCTION_DENOMINATOR_MISSING $production_root"; exit 1; }
done
probe_production_denominator() {
  if rg -n 'gpt-5\.5' "${PRODUCTION_ROOTS[@]}" --glob '!*.test.ts'; then
    echo "RETIRED_CODEX_DEFAULT_REMAINS"
    return 1
  fi
  # A zero-result retired-model scan is meaningful only if the same explicit
  # production roots contain the replacement. This also catches path drift.
  rg -n 'gpt-5\.6-sol' "${PRODUCTION_ROOTS[@]}" --glob '!*.test.ts' >/dev/null
}
probe_production_denominator
if rg -n 'gpt-5\.5' \
  "$ROOT/docs/batch.md" \
  "$ROOT/docs-site/docs/guide/batch.md" \
  "$ROOT/docs-site/docs/en/guide/batch.md" \
  "$ROOT/docs/sdk/sdk-deep-dive.zh.md" \
  "$ROOT/docs/sdk/sdk-deep-dive.en.md" \
  "$ROOT/docs-site/docs/guide/runtimes.md" \
  "$ROOT/docs-site/docs/en/guide/runtimes.md" \
  "$ROOT/docs-site/docs/guide/architecture.md" \
  "$ROOT/docs-site/docs/en/guide/architecture.md"; then
  echo "CURRENT_GUIDANCE_ADVERTISES_RETIRED_DEFAULT"
  exit 1
fi

echo "L2 build agent-node and verify help text"
bun build "$ROOT/agent-node/src/cli.ts" \
  --outfile /tmp/test697-agent-node.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty >/tmp/test697-build.log
HELP=$(bun /tmp/test697-agent-node.js --help)
grep -Fq 'codex 默认: gpt-5.6-sol' <<<"$HELP"
! grep -Fq 'gpt-5.5' <<<"$HELP"

echo "L3 start real Hub and register an isolated user"
(
  cd "$ROOT/server"
  PORT=9697 HOST=127.0.0.1 COMMHUB_DB="$DB_PATH" COMMHUB_AUTH_TOKEN=test697-auth \
    bun run src/index.ts
) >/tmp/test697-hub.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do
  curl -fsS http://127.0.0.1:9697/health >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS http://127.0.0.1:9697/health >/dev/null
mkdir -p "$HOME_DIR/.anet" "$PROJECT_DIR"
ANET=(bun run "$ROOT/agent-network/bin/cli.ts")
HOME="$HOME_DIR" "${ANET[@]}" register \
  --hub http://127.0.0.1:9697 --token test697-auth \
  --username user697 --password 'Model697!' >/tmp/test697-register.log 2>&1

for tool in codex opencode claude grok; do
  printf '#!/usr/bin/env sh\nexit 0\n' > "$FAKE_BIN/$tool"
  chmod 0755 "$FAKE_BIN/$tool"
done

# #535 — a co-presence start now (a) resolves the paired agent-node BEFORE any tmux session
# and (b) stops at needs-login when the node's CODEX_HOME has no usable login. This image has
# no npx, so give the L7b starts an exact, package-shaped agent-node stub (the shape the
# identity check accepts; same recipe as test750) and each started node a clearly fake login.
PAIRED_VERSION=$(bun -e "console.log(require('$ROOT/agent-node/package.json').version)")
[[ -n "$PAIRED_VERSION" ]] || { echo "PAIRED_VERSION_UNREADABLE"; exit 1; }
PAIR_BASE="/run/user/$(id -u)/test697-paired-agent-node"
PAIR_ROOT="$PAIR_BASE/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
chmod 700 "/run/user/$(id -u)" "$PAIR_BASE"
printf '{"name":"@sleep2agi/agent-node","version":"%s","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}\n' \
  "$PAIRED_VERSION" >"$PAIR_ROOT/package.json"
printf '%s\n' '#!/usr/bin/env node' \
  'if (process.argv.includes("--help")) { console.log("--runtime codex-app-server"); process.exit(0); }' \
  'process.exit(1);' >"$PAIR_ROOT/dist/cli.js"
chmod 644 "$PAIR_ROOT/package.json"
chmod 755 "$PAIR_ROOT" "$PAIR_ROOT/dist" "$PAIR_ROOT/dist/cli.js"
PAIRED_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"
seed_fake_codex_login() {
  local home="$PROJECT_DIR/.anet/nodes/$1/codex-home"
  mkdir -p "$home" && chmod 700 "$home"
  printf '{"OPENAI_API_KEY":"sk-fake-test697-%s"}\n' "$1" >"$home/auth.json"
  chmod 600 "$home/auth.json"
}

create_node() {
  local name=$1 runtime=$2
  shift 2
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      "${ANET[@]}" node create "$name" --runtime "$runtime" "$@"
  ) >/tmp/test697-create-"$name".log 2>&1
}

# Derive the negative discriminator directly from the production runtime
# catalog.  A new supported runtime must enter this denominator automatically
# instead of relying on three hand-maintained shell/test lists.
mapfile -t NON_CODEX_RUNTIMES < <(
  bun -e 'import { SUPPORTED_RUNTIME_NAMES } from "./agent-network/src/normalize-runtime.ts";
    const codex = new Set(["codex-sdk", "codex-app-server"]);
    for (const runtime of SUPPORTED_RUNTIME_NAMES) if (!codex.has(runtime)) console.log(runtime);'
)
if [[ "${#NON_CODEX_RUNTIMES[@]}" -ne 5 ]]; then
  echo "NON_CODEX_RUNTIME_DENOMINATOR_WRONG count=${#NON_CODEX_RUNTIMES[@]} values=${NON_CODEX_RUNTIMES[*]}"
  exit 1
fi

echo "L4 real non-interactive creation uses one supported default"
create_node sdk-default codex-sdk
create_node app-default codex-app-server
for name in sdk-default app-default; do
  cfg="$PROJECT_DIR/.anet/nodes/$name/config.json"
  jq -e '.model == "gpt-5.6-sol"' "$cfg" >/dev/null || {
    echo "WRONG_CREATE_DEFAULT name=$name"
    cat "$cfg"
    exit 1
  }
done

echo "L4b non-Codex creation does not inherit a Codex model"
for runtime in "${NON_CODEX_RUNTIMES[@]}"; do
  name="noncodex-${runtime}"
  create_node "$name" "$runtime"
  cfg="$PROJECT_DIR/.anet/nodes/$name/config.json"
  jq -e 'has("model") | not' "$cfg" >/dev/null || {
    echo "NON_CODEX_MODEL_LEAK runtime=$runtime"
    cat "$cfg"
    exit 1
  }
done

echo "L5 explicit model remains authoritative"
create_node explicit-model codex-sdk --model operator-custom-model
jq -e '.model == "operator-custom-model"' \
  "$PROJECT_DIR/.anet/nodes/explicit-model/config.json" >/dev/null

echo "L6 agent-node startup label matches the runtime default and override"
START_CFG=/tmp/test697-start-config.json
printf '%s\n' '{"node_id":"n_test697","node_name":"startup697","alias":"startup697","hub":"http://127.0.0.1:1"}' > "$START_CFG"
set +e
DEFAULT_START=$(HOME="$HOME_DIR" timeout 3 bun /tmp/test697-agent-node.js \
  --config "$START_CFG" --alias startup697 --runtime codex-app-server 2>&1)
CUSTOM_START=$(HOME="$HOME_DIR" timeout 3 bun /tmp/test697-agent-node.js \
  --config "$START_CFG" --alias startup697 --runtime codex-sdk --model operator-custom-model 2>&1)
set -e
grep -Fq 'model:   gpt-5.6-sol (default)' <<<"$DEFAULT_START"
grep -Fq 'model:   operator-custom-model' <<<"$CUSTOM_START"

echo "L7 real PTY drives production inquirer and Enter selects the supported default"
PTY_PROBE_SEQ=0
probe_picker_default() {
  PTY_PROBE_SEQ=$((PTY_PROBE_SEQ + 1))
  local name="pty-codex-$PTY_PROBE_SEQ"
  local transcript="/tmp/test697-pty-$PTY_PROBE_SEQ.typescript"
  local stdout="/tmp/test697-pty-$PTY_PROBE_SEQ.stdout"
  local command
  command="cd '$PROJECT_DIR' && HOME='$HOME_DIR' PATH='$FAKE_BIN:$PATH' bun run '$ROOT/agent-network/bin/cli.ts' node create '$name' --runtime claude-agent-sdk"
  # The vendor picker begins on Intern. Five Down keys select Codex; the
  # first Enter accepts that visible vendor row and the second Enter accepts
  # the model row that production inquirer actually preselects.
  local rc=0
  {
    sleep 0.5
    printf '\033[B\033[B\033[B\033[B\033[B\r'
    sleep 0.5
    printf '\r'
  } | timeout 20 script -qfec "$command" "$transcript" >"$stdout" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "PTY_PICKER_FAILED rc=$rc"
    cat "$stdout"
    cat "$transcript" 2>/dev/null || true
    return 1
  fi
  local cfg="$PROJECT_DIR/.anet/nodes/$name/config.json"
  if ! jq -e '.runtime == "codex-sdk" and .model == "gpt-5.6-sol"' "$cfg" >/dev/null; then
    echo "PTY_PICKER_WRONG_CONFIG"
    cat "$cfg" 2>/dev/null || true
    cat "$transcript" 2>/dev/null || true
    return 1
  fi
  if ! bun "$ROOT/tests/test697-codex-default-model/assert-pty-selection.ts" "$transcript" "$cfg"; then
    echo "PTY_PICKER_DISPLAY_VALUE_MISMATCH"
    cat "$transcript" 2>/dev/null || true
    return 1
  fi
}
probe_picker_default

echo "L7b copresence production entry passes the supported default to tmux"
create_node copresence-default codex-app-server
# #512 — start now honours the node config's `model` (flag > config > default).
# `node create` writes the default INTO config.json, so a freshly created node
# never reaches the built-in default at start. Drop `model` to exercise the
# default leg for real (configs without `model` take exactly this path).
strip_node_model() {
  local cfg="$PROJECT_DIR/.anet/nodes/$1/config.json"
  jq 'del(.model)' "$cfg" > "$cfg.tmp"
  chmod 0600 "$cfg.tmp"
  mv "$cfg.tmp" "$cfg"
  jq -e 'has("model") | not' "$cfg" >/dev/null
}
strip_node_model copresence-default
seed_fake_codex_login copresence-default
FAKE_TMUX_LOG=/tmp/test697-fake-tmux.log
: > "$FAKE_TMUX_LOG"
cat > "$FAKE_BIN/tmux" <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "${FAKE_TMUX_LOG:?}"
case "$1" in
  -V) echo 'tmux 3.4'; exit 0 ;;
  has-session) exit 1 ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$FAKE_BIN/tmux"
(
  cd "$PROJECT_DIR"
  HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" ANET_AGENT_NODE_BIN="$PAIRED_AGENT_NODE_BIN" \
    timeout 5 "${ANET[@]}" node start copresence-default --copresence \
      --codex-bin "$FAKE_BIN/codex"
) >/tmp/test697-copresence.log 2>&1 || true
grep -Fq -- "-c model='gpt-5.6-sol'" "$FAKE_TMUX_LOG" || {
  echo "COPRESENCE_DEFAULT_MODEL_NOT_WIRED"
  cat "$FAKE_TMUX_LOG"
  cat /tmp/test697-copresence.log
  exit 1
}

echo "L7b2 copresence start uses the node config model when no --model is given (#512)"
create_node copresence-config codex-app-server --model cfg-model-697
jq -e '.model == "cfg-model-697"' "$PROJECT_DIR/.anet/nodes/copresence-config/config.json" >/dev/null
seed_fake_codex_login copresence-config
probe_copresence_node_config() {
  : > "$FAKE_TMUX_LOG"
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" ANET_AGENT_NODE_BIN="$PAIRED_AGENT_NODE_BIN" \
      timeout 5 "${ANET[@]}" node start copresence-config --copresence \
        --codex-bin "$FAKE_BIN/codex"
  ) >/tmp/test697-copresence-config.log 2>&1 || true
  grep -Fq -- "-c model='cfg-model-697'" "$FAKE_TMUX_LOG" \
    && grep -Fq "[anet] model: cfg-model-697 (source: node config" /tmp/test697-copresence-config.log
}
probe_copresence_node_config || {
  echo "COPRESENCE_NODE_CONFIG_MODEL_IGNORED"
  cat "$FAKE_TMUX_LOG"
  cat /tmp/test697-copresence-config.log
  exit 1
}

echo "L7c real --batch --preset codex resolves the supported registry default"
probe_batch_preset() {
  local seq=$1 preset=$2 expected_model=$3
  local batch_root="$PROJECT_DIR/batch-$seq"
  safe_rm_rf "$batch_root"
  mkdir -p "$batch_root"
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      "${ANET[@]}" create --batch --preset "$preset" --workdir "$batch_root" \
        --workdir-mode separate --prefix "preset-$seq" --count 1 \
        --leader-alias "preset-$seq" --description test697
  ) >/tmp/test697-batch-"$seq".log 2>&1
  local cfg
  cfg=$(find "$batch_root" -name config.json -type f -print -quit)
  [[ -n "$cfg" ]] || { cat /tmp/test697-batch-"$seq".log; return 1; }
  jq -e --arg model "$expected_model" \
    '.runtime == "codex-sdk" and .model == $model' "$cfg" >/dev/null
}
probe_batch_preset default codex gpt-5.6-sol
probe_batch_preset explicit o3 o3
probe_batch_preset_default_mutation() {
  probe_batch_preset default-mutation codex gpt-5.6-sol
}
probe_batch_preset_explicit_mutation() {
  probe_batch_preset explicit-mutation o3 o3
}

RUNTIME_CFG=/tmp/test697-runtime-config.json
GOALS_PATH=/tmp/test697-goals.json
CODEX_CAPTURE=/tmp/test697-codex-capture.jsonl
STDIO_CAPTURE=/tmp/test697-stdio-capture.jsonl
CLAUDE_CAPTURE=/tmp/test697-claude-capture.json
RUNTIME_LOG=/tmp/test697-runtime.log
EXPECTED_RUNTIME_MODEL="${TEST697_RUNTIME_MODEL:-gpt-5.6-sol}"
RUNTIME_NODE_ALIAS=sdk-default
RUNTIME_NODE_RUNTIME=codex-sdk
RUNTIME_NODE_CONFIG="$RUNTIME_CFG"
RUNTIME_PRELOAD=""
EXTRA_RUNTIME_ENV=()
CODEX_SDK_ENTRY="$ROOT/agent-node/node_modules/@openai/codex-sdk/dist/index.js"
[[ -f "$CODEX_SDK_ENTRY" ]] || { echo "CODEX_SDK_ENTRY_MISSING $CODEX_SDK_ENTRY"; exit 1; }
cp "$ROOT/tests/test697-codex-default-model/fake-codex-sdk.mjs" "$CODEX_SDK_ENTRY"
jq 'del(.model) | .runtime="codex-sdk"' \
  "$PROJECT_DIR/.anet/nodes/sdk-default/config.json" > "$RUNTIME_CFG"
chmod 0600 "$RUNTIME_CFG"

stop_runtime_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && break; sleep 0.1; done
  [[ ! -e "/proc/$pid" ]] || kill -KILL -- "-$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
}

start_runtime_node() {
  local mode=$1
  shift
  local -a runtime_cmd=(bun)
  [[ -n "$RUNTIME_PRELOAD" ]] && runtime_cmd+=(--preload "$RUNTIME_PRELOAD")
  runtime_cmd+=("$ROOT/agent-node/src/cli.ts"
    --alias "$RUNTIME_NODE_ALIAS" --config "$RUNTIME_NODE_CONFIG" --runtime "$RUNTIME_NODE_RUNTIME"
    --goals-path "$GOALS_PATH")
  : > "$RUNTIME_LOG"
  (
    cd "$PROJECT_DIR"
    exec setsid env HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      TEST697_ROOT="$ROOT" TEST697_CODEX_CAPTURE="$CODEX_CAPTURE" \
      TEST697_STDIO_CAPTURE="$STDIO_CAPTURE" TEST697_CLAUDE_CAPTURE="$CLAUDE_CAPTURE" \
      "${EXTRA_RUNTIME_ENV[@]}" "$@" \
      "${runtime_cmd[@]}"
  ) >"$RUNTIME_LOG" 2>&1 &
  NODE_PID=$!
  for _ in $(seq 1 80); do
    grep -Fq '已注册到 CommHub' "$RUNTIME_LOG" && return 0
    [[ -e "/proc/$NODE_PID" ]] || break
    sleep 0.25
  done
  echo "RUNTIME_NODE_START_FAILED mode=$mode"
  cat "$RUNTIME_LOG"
  return 1
}

send_runtime_task() {
  local suffix=$1
  curl -fsS -X POST http://127.0.0.1:9697/api/task \
    -H "Authorization: Bearer $(jq -r '.token' "$HOME_DIR/.anet/config.json")" \
    -H 'Content-Type: application/json' \
    -d "{\"alias\":\"$RUNTIME_NODE_ALIAS\",\"task\":\"test697 runtime model $suffix $(date +%s%N)\",\"priority\":\"normal\"}" >/tmp/test697-task.json
}

wait_for_capture() {
  local pattern=$1 file=$2
  for _ in $(seq 1 80); do grep -Fq "$pattern" "$file" 2>/dev/null && return 0; sleep 0.25; done
  echo "CAPTURE_TIMEOUT pattern=$pattern file=$file"
  cat "$file" 2>/dev/null || true
  cat "$RUNTIME_LOG"
  return 1
}

reset_runtime_session() {
  local next
  next=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  jq 'del(.session)' "$RUNTIME_CFG" > "$next"
  mv "$next" "$RUNTIME_CFG"
  chmod 0600 "$RUNTIME_CFG"
}

probe_goal_wake_model() {
  reset_runtime_session
  : > "$CODEX_CAPTURE"
  cat > "$GOALS_PATH" <<JSON
{"version":1,"goals":[{"goal_id":"69700000-0000-4000-8000-000000000001","text":"test697 wake","status":"active","interval_ms":3600000,"next_wake_at":"2000-01-01T00:00:00.000Z","parent_task_id":"task-test697","report_to":"admin","runtime":"codex-sdk","created_at":"2000-01-01T00:00:00.000Z","updated_at":"2000-01-01T00:00:00.000Z","progress_log":[]}]}
JSON
  start_runtime_node wake || return 1
  wait_for_capture '"kind":"startThread"' "$CODEX_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se --arg model "$EXPECTED_RUNTIME_MODEL" 'map(select(.kind=="startThread")) | length >= 1 and all(.[]; .value.model==$model)' "$CODEX_CAPTURE" >/dev/null || {
    echo "WAKE_MODEL_INJECTION_WRONG"; cat "$CODEX_CAPTURE"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

probe_sdk_task_models() {
  reset_runtime_session
  : > "$CODEX_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  start_runtime_node sdk TEST697_CODEX_FAIL_FIRST=1 || return 1
  send_runtime_task sdk || { stop_runtime_node; return 1; }
  wait_for_capture '"kind":"run"' "$CODEX_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se --arg model "$EXPECTED_RUNTIME_MODEL" 'map(select(.kind=="startThread")) | length >= 2 and all(.[]; .value.model==$model)' "$CODEX_CAPTURE" >/dev/null || {
    echo "SDK_THREAD_MODEL_INJECTION_WRONG"; cat "$CODEX_CAPTURE"; stop_runtime_node; return 1;
  }
  grep -Fq "[codex] model=$EXPECTED_RUNTIME_MODEL" "$RUNTIME_LOG" || {
    echo "SDK_LOG_MODEL_INJECTION_WRONG"; cat "$RUNTIME_LOG"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

probe_sdk_resume_model() {
  local backup
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  jq '.session="thread-test697-resume"' "$backup" > "$RUNTIME_CFG"
  : > "$CODEX_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  if ! start_runtime_node resume; then
    cp "$backup" "$RUNTIME_CFG"
    rm -f "$backup"
    return 1
  fi
  if ! send_runtime_task resume || ! wait_for_capture '"kind":"resumeThread"' "$CODEX_CAPTURE"; then
    stop_runtime_node
    cp "$backup" "$RUNTIME_CFG"
    rm -f "$backup"
    return 1
  fi
  if ! jq -se --arg model "$EXPECTED_RUNTIME_MODEL" '
    map(select(.kind == "startThread" or .kind == "resumeThread"))
    | length >= 1
      and all(.[];
        if .kind == "resumeThread" then .value.opts.model == $model
        else .value.model == $model
        end)
  ' "$CODEX_CAPTURE" >/dev/null; then
    echo "SDK_RESUME_MODEL_INJECTION_WRONG"
    cat "$CODEX_CAPTURE"
    stop_runtime_node
    cp "$backup" "$RUNTIME_CFG"
    rm -f "$backup"
    return 1
  fi
  stop_runtime_node
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
}

probe_stdio_task_model() {
  reset_runtime_session
  : > "$STDIO_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  cp "$ROOT/tests/test697-codex-default-model/fake-codex-app-server.mjs" "$FAKE_BIN/codex"
  chmod 0755 "$FAKE_BIN/codex"
  start_runtime_node stdio ANET_CODEX_STDIO_DIRECT=1 || return 1
  send_runtime_task stdio || { stop_runtime_node; return 1; }
  wait_for_capture '"model"' "$STDIO_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se --arg model "$EXPECTED_RUNTIME_MODEL" 'length >= 1 and all(.[]; .model==$model)' "$STDIO_CAPTURE" >/dev/null || {
    echo "STDIO_MODEL_INJECTION_WRONG"; cat "$STDIO_CAPTURE"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

echo "L7d real agent-node executes every default-model injection lane with fake transports"
probe_goal_wake_model
probe_sdk_task_models
probe_sdk_resume_model
probe_stdio_task_model

probe_explicit_runtime_models() {
  local backup previous_expected
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  jq '.model="o3" | del(.session)' "$backup" > "$RUNTIME_CFG"
  previous_expected=$EXPECTED_RUNTIME_MODEL
  EXPECTED_RUNTIME_MODEL=o3
  probe_goal_wake_model \
    && probe_sdk_task_models \
    && probe_sdk_resume_model \
    && probe_stdio_task_model
  local rc=$?
  EXPECTED_RUNTIME_MODEL=$previous_expected
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
  return "$rc"
}

echo "L7e explicit configured model crosses every agent-node runtime injection lane"
probe_explicit_runtime_models

probe_env_runtime_models() {
  local backup previous_expected
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  jq 'del(.model, .session)' "$backup" > "$RUNTIME_CFG"
  previous_expected=$EXPECTED_RUNTIME_MODEL
  EXPECTED_RUNTIME_MODEL=o3
  EXTRA_RUNTIME_ENV=(MODEL=o3)
  probe_goal_wake_model \
    && probe_sdk_task_models \
    && probe_sdk_resume_model \
    && probe_stdio_task_model
  local rc=$?
  EXTRA_RUNTIME_ENV=()
  EXPECTED_RUNTIME_MODEL=$previous_expected
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
  return "$rc"
}

echo "L7f MODEL env override crosses every agent-node Codex injection lane"
probe_env_runtime_models

probe_non_codex_runtime_model_absent() {
  local config="$PROJECT_DIR/.anet/nodes/noncodex-claude-agent-sdk/config.json"
  local probe_config=/tmp/test697-claude-runtime-config.json
  jq 'del(.model, .session)' "$config" > "$probe_config"
  chmod 0600 "$probe_config"
  : > "$CLAUDE_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  RUNTIME_NODE_ALIAS=noncodex-claude-agent-sdk
  RUNTIME_NODE_RUNTIME=claude-agent-sdk
  RUNTIME_NODE_CONFIG="$probe_config"
  RUNTIME_PRELOAD="$ROOT/tests/test697-codex-default-model/fake-claude-sdk-preload.ts"
  if ! start_runtime_node noncodex-claude; then
    RUNTIME_NODE_ALIAS=sdk-default
    RUNTIME_NODE_RUNTIME=codex-sdk
    RUNTIME_NODE_CONFIG="$RUNTIME_CFG"
    RUNTIME_PRELOAD=""
    return 1
  fi
  if ! send_runtime_task noncodex-claude \
      || ! wait_for_capture '"runtime_probe":"claude-agent-sdk"' "$CLAUDE_CAPTURE"; then
    stop_runtime_node
    RUNTIME_NODE_ALIAS=sdk-default
    RUNTIME_NODE_RUNTIME=codex-sdk
    RUNTIME_NODE_CONFIG="$RUNTIME_CFG"
    RUNTIME_PRELOAD=""
    return 1
  fi
  if ! jq -e '.runtime_probe == "claude-agent-sdk" and .model == null' "$CLAUDE_CAPTURE" >/dev/null; then
    echo "NON_CODEX_RUNTIME_MODEL_INJECTED"
    cat "$CLAUDE_CAPTURE"
    stop_runtime_node
    RUNTIME_NODE_ALIAS=sdk-default
    RUNTIME_NODE_RUNTIME=codex-sdk
    RUNTIME_NODE_CONFIG="$RUNTIME_CFG"
    RUNTIME_PRELOAD=""
    return 1
  fi
  stop_runtime_node
  RUNTIME_NODE_ALIAS=sdk-default
  RUNTIME_NODE_RUNTIME=codex-sdk
  RUNTIME_NODE_CONFIG="$RUNTIME_CFG"
  RUNTIME_PRELOAD=""
}

echo "L7g non-Codex agent-node runtime does not receive the Codex default"
probe_non_codex_runtime_model_absent

# #534 — a node configured read-only / on-request must keep that posture on
# every codex-sdk lane: goal wake, first-turn startThread, and the
# "codex thread error, 重建" retry (forced by TEST697_CODEX_FAIL_FIRST=1).
probe_configured_flags_every_sdk_lane() {
  local backup rc=0 flags_ok
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  jq 'del(.session) | .flags = ((.flags // {}) + {sandboxMode:"read-only",approvalPolicy:"on-request",skipGitRepoCheck:false})' \
    "$backup" > "$RUNTIME_CFG"
  flags_ok='.sandboxMode=="read-only" and .approvalPolicy=="on-request" and .skipGitRepoCheck==false'
  if probe_goal_wake_model; then
    jq -se "map(select(.kind==\"startThread\")) | length >= 1 and all(.[]; .value | $flags_ok)" "$CODEX_CAPTURE" >/dev/null \
      || { echo "WAKE_FLAGS_IGNORED"; cat "$CODEX_CAPTURE"; rc=1; }
  else
    rc=1
  fi
  if [[ "$rc" -eq 0 ]]; then
    if probe_sdk_task_models; then
      jq -se "(map(select(.kind==\"startThread\")) | length >= 2 and all(.[]; .value | $flags_ok))
              and (map(select(.kind==\"run\")) | length >= 1 and all(.[]; .value | $flags_ok))" "$CODEX_CAPTURE" >/dev/null \
        || { echo "SDK_RETRY_FLAGS_IGNORED"; cat "$CODEX_CAPTURE"; rc=1; }
    else
      rc=1
    fi
  fi
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
  return "$rc"
}

echo "L7h configured sandbox/approval flags survive wake, first turn and retry (#534)"
probe_configured_flags_every_sdk_lane

# #538 — the ANET_CODEX_STDIO_DIRECT=1 lane must send the node's configured
# sandbox / approval on thread/start (`sandbox` + `approvalPolicy`, the
# ThreadStartParams wire names), and an unconfigured node must not be given a
# sandbox override (no silent escalation) nor the dead `sandboxPolicy` key.
probe_configured_flags_stdio_lane() {
  local backup rc=0
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  jq 'del(.session) | .flags = ((.flags // {}) + {sandboxMode:"read-only",approvalPolicy:"never"})' \
    "$backup" > "$RUNTIME_CFG"
  if probe_stdio_task_model; then
    jq -se 'length >= 1 and all(.[]; .sandbox=="read-only" and .approvalPolicy=="never" and (has("sandboxPolicy") | not))' \
      "$STDIO_CAPTURE" >/dev/null || { echo "STDIO_FLAGS_IGNORED"; cat "$STDIO_CAPTURE"; rc=1; }
  else
    rc=1
  fi
  if [[ "$rc" -eq 0 ]]; then
    jq 'del(.session) | .flags = ((.flags // {}) | del(.sandboxMode, .approvalPolicy))' \
      "$backup" > "$RUNTIME_CFG"
    if probe_stdio_task_model; then
      jq -se 'length >= 1 and all(.[]; (has("sandbox") | not) and .approvalPolicy=="on-request" and (has("sandboxPolicy") | not))' \
        "$STDIO_CAPTURE" >/dev/null || { echo "STDIO_UNCONFIGURED_POSTURE_CHANGED"; cat "$STDIO_CAPTURE"; rc=1; }
    else
      rc=1
    fi
  fi
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
  return "$rc"
}

echo "L7i configured sandbox/approval flags reach the direct-stdio thread/start (#538)"
probe_configured_flags_stdio_lane

# #553 — the direct-stdio lane against the REAL `codex app-server` bundled with
# agent-node (no fake). `thread/start` ignores a threadId key, so a recorded
# thread must come back through `thread/resume`; a thread whose rollout is gone
# must fail the task with one actionable line and NEVER open a fresh thread.
# Hermetic: throwaway CODEX_HOME whose only model provider is 127.0.0.1:9
# (connection refused → the 0.133 turn fails at once, rollout still written);
# nothing reaches the network, no login, no real ~/.codex.
REAL_CODEX_LIST=$(find "$ROOT/agent-node/node_modules/@openai" -path '*/vendor/*/bin/codex' -type f)
REAL_CODEX=${REAL_CODEX_LIST%%$'\n'*}
[[ -n "$REAL_CODEX" && -x "$REAL_CODEX" ]] || { echo "REAL_CODEX_MISSING under $ROOT/agent-node/node_modules/@openai"; exit 1; }
REAL_CAPTURE=/tmp/test697-real-appserver-requests.jsonl

real_capture_count() { # method → number of requests of that method in $REAL_CAPTURE
  jq -s --arg m "$1" 'map(select(.method==$m)) | length' "$REAL_CAPTURE"
}

wait_for_real_count() { # method count
  for _ in $(seq 1 120); do
    [[ "$(real_capture_count "$1" 2>/dev/null || echo 0)" -ge "$2" ]] && return 0
    sleep 0.25
  done
  echo "REAL_CAPTURE_TIMEOUT method=$1 want>=$2"; cat "$REAL_CAPTURE" 2>/dev/null || true; cat "$RUNTIME_LOG"
  return 1
}

wait_for_log() { # fixed-string pattern in $RUNTIME_LOG, Nth occurrence
  local want=${2:-1} n
  for _ in $(seq 1 120); do
    n=$(grep -Fc -- "$1" "$RUNTIME_LOG" || true)
    [[ "${n:-0}" -ge "$want" ]] && return 0
    sleep 0.25
  done
  echo "LOG_TIMEOUT pattern=$1 want>=$want"; cat "$RUNTIME_LOG"
  return 1
}

probe_real_appserver_resume() {
  local backup codex_home codex_shim_backup rc=0 t1 t2 n_start n_resume
  backup=$(mktemp /tmp/test697-runtime-config.XXXXXX)
  cp "$RUNTIME_CFG" "$backup"
  codex_shim_backup=$(mktemp /tmp/test697-codex-shim.XXXXXX)
  cp "$FAKE_BIN/codex" "$codex_shim_backup"
  codex_home=$(mktemp -d "$HOME_DIR/codex-home-553.XXXXXX")
  cat > "$codex_home/config.toml" <<'TOML'
model_provider = "test697offline"
[model_providers.test697offline]
name = "test697offline"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
TOML
  # `codex` on PATH = the real binary, with every JSON-RPC request agent-node
  # sends teed into $REAL_CAPTURE (one JSON object per line).
  cat > "$FAKE_BIN/codex" <<'SH'
#!/usr/bin/env bash
exec "$TEST697_REAL_CODEX" "$@" < <(tee -a "$TEST697_REAL_CAPTURE")
SH
  chmod 0755 "$FAKE_BIN/codex"
  jq 'del(.session) | .flags = ((.flags // {}) + {sandboxMode:"read-only",approvalPolicy:"never"})' \
    "$backup" > "$RUNTIME_CFG"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  local -a env553=(ANET_CODEX_STDIO_DIRECT=1 CODEX_HOME="$codex_home"
    TEST697_REAL_CODEX="$REAL_CODEX" TEST697_REAL_CAPTURE="$REAL_CAPTURE")

  # Run 1 — nothing recorded: one thread/start, then the id is recorded once the turn ran.
  : > "$REAL_CAPTURE"
  start_runtime_node real1 "${env553[@]}" || rc=1
  if [[ "$rc" -eq 0 ]]; then
    send_runtime_task real1 && wait_for_real_count turn/start 1 && wait_for_log '[codex-stdio] turn done' 1 || rc=1
  fi
  if [[ "$rc" -eq 0 ]]; then
    t1=$(jq -r '.session // ""' "$RUNTIME_CFG")
    n_start=$(real_capture_count thread/start); n_resume=$(real_capture_count thread/resume)
    if [[ -z "$t1" || "$n_start" -ne 1 || "$n_resume" -ne 0 ]]; then
      echo "REAL_RUN1_WRONG session=$t1 thread/start=$n_start thread/resume=$n_resume"; rc=1
    elif ! jq -se 'map(select(.method=="thread/start")) | all(.[]; (.params|has("threadId")|not) and .params.sandbox=="read-only" and .params.approvalPolicy=="never")' "$REAL_CAPTURE" >/dev/null; then
      echo "REAL_RUN1_START_PARAMS_WRONG"; cat "$REAL_CAPTURE"; rc=1
    elif [[ -z "$(find "$codex_home/sessions" -name "rollout-*-$t1.jsonl" -type f 2>/dev/null)" ]]; then
      echo "REAL_RUN1_NO_ROLLOUT for recorded $t1"; find "$codex_home" -type f; rc=1
    fi
  fi
  # Same process, second task: same thread, no new start/resume.
  if [[ "$rc" -eq 0 ]]; then
    send_runtime_task real1b && wait_for_real_count turn/start 2 && wait_for_log '[codex-stdio] turn done' 2 || rc=1
  fi
  if [[ "$rc" -eq 0 ]]; then
    if [[ "$(real_capture_count thread/start)" -ne 1 || "$(real_capture_count thread/resume)" -ne 0 ]] \
      || ! jq -se --arg t "$t1" 'map(select(.method=="turn/start")) | length == 2 and all(.[]; .params.threadId==$t)' "$REAL_CAPTURE" >/dev/null; then
      echo "REAL_SAME_PROCESS_SECOND_TASK_WRONG t1=$t1"; cat "$REAL_CAPTURE"; rc=1
    else
      echo "  run1: one thread/start → recorded $t1 (rollout present); second task reused it"
    fi
  fi
  stop_runtime_node

  # Run 2 — node restarted with session=t1: the next task resumes t1 (no thread/start).
  if [[ "$rc" -eq 0 ]]; then
    : > "$REAL_CAPTURE"
    start_runtime_node real2 "${env553[@]}" || rc=1
    if [[ "$rc" -eq 0 ]]; then
      send_runtime_task real2 && wait_for_real_count turn/start 1 && wait_for_log '[codex-stdio] turn done' 1 || rc=1
    fi
    if [[ "$rc" -eq 0 ]]; then
      t2=$(jq -r '.session // ""' "$RUNTIME_CFG")
      if [[ "$(real_capture_count thread/start)" -ne 0 || "$(real_capture_count thread/resume)" -ne 1 ]] \
        || ! jq -se --arg t "$t1" '
            (map(select(.method=="thread/resume")) | all(.[]; .params.threadId==$t and .params.sandbox=="read-only" and .params.approvalPolicy=="never"))
            and (map(select(.method=="turn/start")) | all(.[]; .params.threadId==$t))' "$REAL_CAPTURE" >/dev/null \
        || [[ "$t2" != "$t1" ]] \
        || ! grep -Fq "[codex-stdio] thread/resume → $t1" "$RUNTIME_LOG"; then
        echo "REAL_RESTART_DID_NOT_RESUME t1=$t1 session_after=$t2"; cat "$REAL_CAPTURE"; cat "$RUNTIME_LOG"; rc=1
      else
        echo "  restart resumed $t1 via thread/resume (thread/start=0, session unchanged)"
      fi
    fi
    stop_runtime_node
  fi

  # Run 3 — t1's rollout is gone: the task fails with the actionable line, no fresh thread.
  if [[ "$rc" -eq 0 ]]; then
    mv "$codex_home/sessions" "$codex_home/sessions.gone"
    : > "$REAL_CAPTURE"
    start_runtime_node real3 "${env553[@]}" || rc=1
    if [[ "$rc" -eq 0 ]]; then
      send_runtime_task real3 && wait_for_log "recorded codex thread $t1 cannot be resumed" 1 || rc=1
    fi
    if [[ "$rc" -eq 0 ]]; then
      sleep 1
      if [[ "$(real_capture_count thread/start)" -ne 0 || "$(real_capture_count turn/start)" -ne 0 ]] \
        || ! grep -Fq "refusing to start a fresh thread in its place. Pick another: anet resume $RUNTIME_NODE_ALIAS --pick" "$RUNTIME_LOG" \
        || [[ "$(jq -r '.session // ""' "$RUNTIME_CFG")" != "$t1" ]]; then
        echo "REAL_GONE_THREAD_NOT_REFUSED t1=$t1"; cat "$REAL_CAPTURE"; cat "$RUNTIME_LOG"; rc=1
      else
        echo "  gone thread refused (thread/start=0 turn/start=0): $(grep -F -m1 'cannot be resumed' "$RUNTIME_LOG")"
      fi
    fi
    stop_runtime_node
  fi

  cp "$codex_shim_backup" "$FAKE_BIN/codex"
  chmod 0755 "$FAKE_BIN/codex"
  rm -f "$codex_shim_backup"
  cp "$backup" "$RUNTIME_CFG"
  rm -f "$backup"
  safe_rm_rf "$codex_home"
  return "$rc"
}

echo "L7j direct-stdio lane resumes the recorded thread on the real codex app-server (#553)"
probe_real_appserver_resume

if [[ "${TEST697_SKIP_MUTATIONS:-0}" != "1" ]]; then
  echo "L8 witnessed-red mutations"
  run_mutation() {
    local name=$1 expected_layer=$2 file=$3 from=$4 to=$5 probe=$6
    local backup
    backup=$(mktemp /tmp/test697-mutation.XXXXXX)
    cp "$file" "$backup"
    local before after rc baseline_rc
    set +e
    "$probe" >/tmp/test697-baseline-"$name".log 2>&1
    baseline_rc=$?
    set -e
    if [[ "$baseline_rc" -ne 0 ]]; then
      echo "MUTATION_BASELINE_RED $name rc=$baseline_rc"
      cat /tmp/test697-baseline-"$name".log
      rm -f "$backup"
      exit 1
    fi
    before=$(sha256sum "$file" | awk '{print $1}')
    MUTATION_FILE="$file" MUTATION_FROM="$from" MUTATION_TO="$to" bun -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const file = process.env.MUTATION_FILE!;
      const from = process.env.MUTATION_FROM!;
      const to = process.env.MUTATION_TO!;
      const source = readFileSync(file, "utf8");
      writeFileSync(file, source.replace(from, to));
    '
    after=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$before" == "$after" ]]; then
      echo "MUTATION_NOOP $name"
      cp "$backup" "$file"
      rm -f "$backup"
      exit 1
    fi
    set +e
    "$probe" >/tmp/test697-mut-"$name".log 2>&1
    rc=$?
    set -e
    cp "$backup" "$file"
    rm -f "$backup"
    if [[ "$rc" -eq 0 ]]; then
      echo "MUTATION_SURVIVED $name"
      cat /tmp/test697-mut-"$name".log
      exit 1
    fi
    echo "MUTATION_RED $name layer=$expected_layer rc=$rc"
  }

  run_mutation_pair() {
    local name=$1 expected_layer=$2 file=$3 from1=$4 to1=$5 from2=$6 to2=$7 probe=$8
    local backup
    backup=$(mktemp /tmp/test697-mutation.XXXXXX)
    cp "$file" "$backup"
    local before after rc baseline_rc
    set +e
    "$probe" >/tmp/test697-baseline-"$name".log 2>&1
    baseline_rc=$?
    set -e
    if [[ "$baseline_rc" -ne 0 ]]; then
      echo "MUTATION_BASELINE_RED $name rc=$baseline_rc"
      cat /tmp/test697-baseline-"$name".log
      rm -f "$backup"
      exit 1
    fi
    before=$(sha256sum "$file" | awk '{print $1}')
    MUTATION_FILE="$file" MUTATION_FROM1="$from1" MUTATION_TO1="$to1" \
      MUTATION_FROM2="$from2" MUTATION_TO2="$to2" bun -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const file = process.env.MUTATION_FILE!;
        const from1 = process.env.MUTATION_FROM1!;
        const to1 = process.env.MUTATION_TO1!;
        const from2 = process.env.MUTATION_FROM2!;
        const to2 = process.env.MUTATION_TO2!;
        const source = readFileSync(file, "utf8");
        if (!source.includes(from1) || !source.includes(from2)) process.exit(2);
        const marker = "__TEST697_PAIR_MUTATION_MARKER__";
        if (source.includes(marker)) process.exit(2);
        writeFileSync(file, source.replace(from1, marker).replace(from2, to2).replace(marker, to1));
      '
    after=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$before" == "$after" ]]; then
      echo "MUTATION_NOOP $name"
      cp "$backup" "$file"
      rm -f "$backup"
      exit 1
    fi
    set +e
    "$probe" >/tmp/test697-mut-"$name".log 2>&1
    rc=$?
    set -e
    cp "$backup" "$file"
    rm -f "$backup"
    if [[ "$rc" -eq 0 ]]; then
      echo "MUTATION_SURVIVED $name"
      cat /tmp/test697-mut-"$name".log
      exit 1
    fi
    echo "MUTATION_RED $name layer=$expected_layer rc=$rc"
  }

  run_mutation_all() {
    local name=$1 expected_layer=$2 file=$3 from=$4 to=$5 expected_count=$6 probe=$7
    local backup
    backup=$(mktemp /tmp/test697-mutation.XXXXXX)
    cp "$file" "$backup"
    local before after rc count baseline_rc
    set +e
    "$probe" >/tmp/test697-baseline-"$name".log 2>&1
    baseline_rc=$?
    set -e
    if [[ "$baseline_rc" -ne 0 ]]; then
      echo "MUTATION_BASELINE_RED $name rc=$baseline_rc"
      cat /tmp/test697-baseline-"$name".log
      rm -f "$backup"
      exit 1
    fi
    before=$(sha256sum "$file" | awk '{print $1}')
    count=$(MUTATION_FILE="$file" MUTATION_FROM="$from" bun -e '
      import { readFileSync } from "node:fs";
      const source = readFileSync(process.env.MUTATION_FILE!, "utf8");
      console.log(source.split(process.env.MUTATION_FROM!).length - 1);
    ')
    if [[ "$count" -ne "$expected_count" ]]; then
      echo "MUTATION_DENOMINATOR_MISMATCH $name expected=$expected_count actual=$count"
      cp "$backup" "$file"
      rm -f "$backup"
      exit 1
    fi
    MUTATION_FILE="$file" MUTATION_FROM="$from" MUTATION_TO="$to" bun -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const file = process.env.MUTATION_FILE!;
      writeFileSync(file, readFileSync(file, "utf8").split(process.env.MUTATION_FROM!).join(process.env.MUTATION_TO!));
    '
    after=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$before" == "$after" ]]; then
      echo "MUTATION_NOOP $name"
      cp "$backup" "$file"
      rm -f "$backup"
      exit 1
    fi
    set +e
    "$probe" >/tmp/test697-mut-"$name".log 2>&1
    rc=$?
    set -e
    cp "$backup" "$file"
    rm -f "$backup"
    if [[ "$rc" -eq 0 ]]; then
      echo "MUTATION_SURVIVED $name"
      cat /tmp/test697-mut-"$name".log
      exit 1
    fi
    echo "MUTATION_RED $name layer=$expected_layer rc=$rc"
  }

  MUTATION_CREATE_SEQ=0
  next_mutation_name() {
    local prefix=$1 outvar=$2
    MUTATION_CREATE_SEQ=$((MUTATION_CREATE_SEQ + 1))
    printf -v "$outvar" '%s-%s' "$prefix" "$MUTATION_CREATE_SEQ"
  }
  probe_create_default() {
    local name
    next_mutation_name mutation-default name
    create_node "$name" codex-sdk || return 1
    jq -e '.model == "gpt-5.6-sol"' \
      "$PROJECT_DIR/.anet/nodes/$name/config.json" >/dev/null
  }
  probe_explicit_model() {
    local name
    next_mutation_name mutation-explicit name
    create_node "$name" codex-sdk --model operator-custom-model || return 1
    jq -e '.model == "operator-custom-model"' \
      "$PROJECT_DIR/.anet/nodes/$name/config.json" >/dev/null
  }
  probe_non_codex_model_absent() {
    local runtime name cfg
    for runtime in "${NON_CODEX_RUNTIMES[@]}"; do
      next_mutation_name "mutation-noncodex-${runtime}" name
      create_node "$name" "$runtime" || return 1
      cfg="$PROJECT_DIR/.anet/nodes/$name/config.json"
      jq -e 'has("model") | not' "$cfg" >/dev/null
    done
  }
  probe_help_text() {
    bun build "$ROOT/agent-node/src/cli.ts" --outfile /tmp/test697-mut-help.js --target node \
      --external @anthropic-ai/claude-agent-sdk \
      --external '@anthropic-ai/claude-agent-sdk-*' \
      --external @openai/codex-sdk --external node-pty >/dev/null
    local help
    help=$(bun /tmp/test697-mut-help.js --help)
    grep -Fq 'codex 默认: gpt-5.6-sol' <<<"$help"
    ! grep -Fq 'gpt-5.5' <<<"$help"
  }
  probe_startup_label() {
    bun build "$ROOT/agent-node/src/cli.ts" --outfile /tmp/test697-mut-start.js --target node \
      --external @anthropic-ai/claude-agent-sdk \
      --external '@anthropic-ai/claude-agent-sdk-*' \
      --external @openai/codex-sdk --external node-pty >/dev/null
    local output
    output=$(HOME="$HOME_DIR" timeout 3 bun /tmp/test697-mut-start.js \
      --config "$START_CFG" --alias startup697 --runtime codex-app-server 2>&1) || true
    grep -Fq 'model:   gpt-5.6-sol (default)' <<<"$output"
    ! grep -Fq 'gpt-5.5' <<<"$output"
  }
  probe_copresence_default() {
    : > "$FAKE_TMUX_LOG"
    (
      cd "$PROJECT_DIR"
      HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" ANET_AGENT_NODE_BIN="$PAIRED_AGENT_NODE_BIN" \
        timeout 5 "${ANET[@]}" node start copresence-default --copresence \
          --codex-bin "$FAKE_BIN/codex"
    ) >/tmp/test697-mut-copresence.log 2>&1 || true
    grep -Fq -- "-c model='gpt-5.6-sol'" "$FAKE_TMUX_LOG"
  }
  probe_copresence_explicit() {
    : > "$FAKE_TMUX_LOG"
    (
      cd "$PROJECT_DIR"
      HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" ANET_AGENT_NODE_BIN="$PAIRED_AGENT_NODE_BIN" \
        timeout 5 "${ANET[@]}" node start copresence-default --copresence \
          --model o3 --codex-bin "$FAKE_BIN/codex"
    ) >/tmp/test697-mut-copresence-explicit.log 2>&1 || true
    grep -Fq -- "-c model='o3'" "$FAKE_TMUX_LOG"
  }

  run_mutation denominator-retired-default L1 \
    "$ROOT/agent-network/src/codex-model-default.ts" \
    'DEFAULT_CODEX_MODEL = "gpt-5.6-sol"' 'DEFAULT_CODEX_MODEL = "gpt-5.5"' probe_production_denominator
  run_mutation default-regressed L4 \
    "$ROOT/agent-network/src/codex-model-default.ts" \
    'DEFAULT_CODEX_MODEL = "gpt-5.6-sol"' 'DEFAULT_CODEX_MODEL = "gpt-5.5"' probe_create_default
  run_mutation non-codex-default-leak L4b \
    "$ROOT/agent-network/bin/cli.ts" \
    'const defaultModel = defaultCodexModelForRuntime(runtime);' \
    'const defaultModel = defaultCodexModelForRuntime("codex-sdk");' \
    probe_non_codex_model_absent
  run_mutation picker-default-regressed L7 \
    "$ROOT/agent-network/bin/cli.ts" \
    '(b.default ? 1 : 0) - (a.default ? 1 : 0)' \
    '(a.default ? 1 : 0) - (b.default ? 1 : 0)' probe_picker_default
  run_mutation picker-display-order-reversed L7 \
    "$ROOT/agent-network/bin/cli.ts" \
    'choices: choices.map((choice) => ({' \
    'choices: [...choices].reverse().map((choice) => ({' probe_picker_default
  run_mutation picker-vendor-value-miswired L7 \
    "$ROOT/agent-network/bin/cli.ts" \
    'choices: VENDORS.map(v => ({ value: v.key, name: v.label }))' \
    'choices: VENDORS.map(v => ({ value: v.runtime, name: v.label }))' probe_picker_default
  run_mutation_pair picker-vendor-labels-swapped L7 \
    "$ROOT/agent-network/bin/cli.ts" \
    'key: "intern", label: "上海 AI Lab 书生 (Intern)",' \
    'key: "intern", label: "Codex / GPT (海外，需 codex login)",' \
    'key: "codex", label: "Codex / GPT (海外，需 codex login)",' \
    'key: "codex", label: "上海 AI Lab 书生 (Intern)",' probe_picker_default
  run_mutation_pair picker-model-label-value-decoupled L7 \
    "$ROOT/agent-network/bin/cli.ts" \
    'choices: choices.map((choice) => ({' \
    'choices: choices.map((choice, idx) => ({' \
    'name: choice.label,' \
    'name: choices[choices.length - 1 - idx].label,' probe_picker_default
  run_mutation explicit-model-overwritten L5 \
    "$ROOT/agent-network/bin/cli.ts" \
    '...(opts.model || defaultModel ? { model: opts.model || defaultModel } : {}),' \
    '...(opts.model || defaultModel ? { model: defaultModel || opts.model } : {}),' probe_explicit_model
  run_mutation help-advertises-retired-default L2 \
    "$ROOT/agent-node/src/cli.ts" \
    'codex 默认: ${DEFAULT_CODEX_MODEL}' 'codex 默认: gpt-5.5' probe_help_text
  run_mutation startup-label-regressed L6 \
    "$ROOT/agent-node/src/cli.ts" \
    '? DEFAULT_CODEX_MODEL' '? "gpt-5.5"' probe_startup_label
  # #512 moved the co-presence default out of cli.ts into the resolver.
  run_mutation copresence-default-regressed L7b \
    "$ROOT/agent-network/src/codex-copresence-model.ts" \
    'fallback: string = DEFAULT_CODEX_MODEL,' \
    'fallback: string = "gpt-4.1-legacy",' probe_copresence_default
  run_mutation copresence-node-config-ignored L7b2 \
    "$ROOT/agent-network/bin/cli.ts" \
    'resolveCodexCopresenceModel(opts.model, (profile as { model?: unknown }).model)' \
    'resolveCodexCopresenceModel(opts.model, undefined)' probe_copresence_node_config
  run_mutation copresence-explicit-overwritten L7b \
    "$ROOT/agent-network/bin/cli.ts" \
    'model: opts.model,' 'model: undefined,' probe_copresence_explicit
  run_mutation batch-preset-default-regressed L7c \
    "$ROOT/agent-network/bin/cli.ts" \
    'vendor.models.find(m => m.default)' 'vendor.models.find(m => !m.default)' \
    probe_batch_preset_default_mutation
  run_mutation batch-preset-explicit-overwritten L7c \
    "$ROOT/agent-network/bin/cli.ts" \
    '        model: modelId,' '        model: defaultCodexModelForRuntime(vendor.runtime) || modelId,' \
    probe_batch_preset_explicit_mutation
  run_mutation wake-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'buildOpts: () => buildCodexSdkThreadOptions(fileConfig?.flags, resolveCodexModel(MODEL)),' \
    'buildOpts: () => buildCodexSdkThreadOptions(fileConfig?.flags, MODEL || "gpt-4.1-legacy"),' \
    probe_goal_wake_model
  run_mutation sdk-thread-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'const codexModel = resolveCodexModel(MODEL);' 'const codexModel = MODEL || "gpt-4.1-legacy";' \
    probe_sdk_task_models
  run_mutation sdk-resume-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'codexThread = codex.resumeThread(SESSION_ID, codexOpts);' \
    'codexThread = codex.resumeThread(SESSION_ID, { ...codexOpts, model: "gpt-4.1-legacy" });' \
    probe_sdk_resume_model
  run_mutation sdk-log-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'const codexModelName = resolveCodexModel(MODEL);' 'const codexModelName = MODEL || "gpt-4.1-legacy";' \
    probe_sdk_task_models
  run_mutation sdk-retry-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'codexThread = rebuildCodexSdkThread(codex, fileConfig?.flags, resolveCodexModel(MODEL));' \
    'codexThread = rebuildCodexSdkThread(codex, fileConfig?.flags, MODEL || "gpt-4.1-legacy");' \
    probe_sdk_task_models
  # #534 — the retry used to hard-code full access; putting that literal back
  # must turn the configured-flags probe red.
  run_mutation sdk-retry-flags-hardcoded-regressed L7h \
    "$ROOT/agent-node/src/cli.ts" \
    'codexThread = rebuildCodexSdkThread(codex, fileConfig?.flags, resolveCodexModel(MODEL));' \
    'codexThread = codex.startThread({ skipGitRepoCheck: true, approvalPolicy: "never" as const, model: resolveCodexModel(MODEL), sandboxMode: "danger-full-access" as const, modelReasoningEffort: "low" as const });' \
    probe_configured_flags_every_sdk_lane
  run_mutation wake-flags-ignored-regressed L7h \
    "$ROOT/agent-node/src/cli.ts" \
    'buildOpts: () => buildCodexSdkThreadOptions(fileConfig?.flags, resolveCodexModel(MODEL)),' \
    'buildOpts: () => buildCodexSdkThreadOptions(undefined, resolveCodexModel(MODEL)),' \
    probe_configured_flags_every_sdk_lane
  run_mutation stdio-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    $'      flags: fileConfig?.flags,\n      model: resolveCodexModel(MODEL),' \
    $'      flags: fileConfig?.flags,\n      model: MODEL || "gpt-4.1-legacy",' \
    probe_stdio_task_model
  # #538 — the stdio lane used to ignore the node's flags; dropping them again
  # (or restoring the old full-access literal) must turn L7i red.
  run_mutation stdio-flags-ignored-regressed L7i \
    "$ROOT/agent-node/src/cli.ts" \
    $'      flags: fileConfig?.flags,\n      model: resolveCodexModel(MODEL),' \
    $'      flags: undefined,\n      model: resolveCodexModel(MODEL),' \
    probe_configured_flags_stdio_lane
  run_mutation stdio-flags-hardcoded-regressed L7i \
    "$ROOT/agent-node/src/codex-sdk-thread-options.ts" \
    '  if (typeof cfgFlags.sandboxMode === "string") params.sandbox = cfgFlags.sandboxMode;' \
    '  (params as unknown as Record<string, unknown>).sandboxPolicy = { type: "dangerFullAccess" }; params.approvalPolicy = "on-request";' \
    probe_configured_flags_stdio_lane
  # #553 — the recorded thread must be resumed on the real app-server, and a
  # thread that is gone must never be replaced by a fresh one.
  run_mutation stdio-recorded-thread-ignored L7j \
    "$ROOT/agent-node/src/cli.ts" \
    '      recordedThreadId: codexStdioRecordedThreadId,' \
    '      recordedThreadId: null,' \
    probe_real_appserver_resume
  run_mutation stdio-resume-via-thread-start L7j \
    "$ROOT/agent-node/src/codex-sdk-thread-options.ts" \
    '  const recorded = o.recordedThreadId || "";' \
    '  const recorded = ""; const _legacy = o.recordedThreadId;' \
    probe_real_appserver_resume
  run_mutation stdio-gone-thread-silently-replaced L7j \
    "$ROOT/agent-node/src/codex-sdk-thread-options.ts" \
    '      const cause = e instanceof Error ? e.message : String(e);' \
    '      const cause = e instanceof Error ? e.message : String(e); { const r = await rpc.request<{ thread: { id: string } }>("thread/start", buildCodexStdioThreadStartParams(o.flags, o.model)); return { threadId: r.thread.id, resumed: false }; }' \
    probe_real_appserver_resume
  run_mutation_all explicit-runtime-model-ignored L7e \
    "$ROOT/agent-node/src/cli.ts" \
    'resolveCodexModel(MODEL)' 'resolveCodexModel(undefined)' 5 \
    probe_explicit_runtime_models
  run_mutation persisted-runtime-model-ignored L7e \
    "$ROOT/agent-node/src/cli.ts" \
    'const MODEL = opts.model || process.env.MODEL || fileConfig.model;' \
    'const MODEL = opts.model || process.env.MODEL;' \
    probe_explicit_runtime_models
  run_mutation environment-runtime-model-ignored L7f \
    "$ROOT/agent-node/src/cli.ts" \
    'const MODEL = opts.model || process.env.MODEL || fileConfig.model;' \
    $'delete process.env.MODEL;\nconst MODEL = opts.model || process.env.MODEL || fileConfig.model;' \
    probe_env_runtime_models
  run_mutation non-codex-runtime-default-injected L7g \
    "$ROOT/agent-node/src/cli.ts" \
    $'  const options: any = {\n    model: MODEL || undefined,' \
    $'  const options: any = {\n    model: MODEL || DEFAULT_CODEX_MODEL,' \
    probe_non_codex_runtime_model_absent
fi

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "RESULT: PASS"
