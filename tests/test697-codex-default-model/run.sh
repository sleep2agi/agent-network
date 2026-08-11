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
  "$ROOT/docs-site/docs/guide/sdk-deep-dive.md" \
  "$ROOT/docs-site/docs/en/guide/sdk-deep-dive.md" \
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

create_node() {
  local name=$1 runtime=$2
  shift 2
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      "${ANET[@]}" node create "$name" --runtime "$runtime" "$@"
  ) >/tmp/test697-create-"$name".log 2>&1
}

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
  HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" \
    timeout 5 "${ANET[@]}" node start copresence-default --copresence \
      --codex-bin "$FAKE_BIN/codex"
) >/tmp/test697-copresence.log 2>&1 || true
grep -Fq -- "-c model='gpt-5.6-sol'" "$FAKE_TMUX_LOG" || {
  echo "COPRESENCE_DEFAULT_MODEL_NOT_WIRED"
  cat "$FAKE_TMUX_LOG"
  cat /tmp/test697-copresence.log
  exit 1
}

echo "L7c real --batch --preset codex resolves the supported registry default"
probe_batch_preset_default() {
  local seq=${1:-base}
  local batch_root="$PROJECT_DIR/batch-$seq"
  safe_rm_rf "$batch_root"
  mkdir -p "$batch_root"
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      "${ANET[@]}" create --batch --preset codex --workdir "$batch_root" \
        --workdir-mode separate --prefix "preset-$seq" --count 1 \
        --leader-alias "preset-$seq" --description test697
  ) >/tmp/test697-batch-"$seq".log 2>&1
  local cfg
  cfg=$(find "$batch_root" -name config.json -type f -print -quit)
  [[ -n "$cfg" ]] || { cat /tmp/test697-batch-"$seq".log; return 1; }
  jq -e '.runtime == "codex-sdk" and .model == "gpt-5.6-sol"' "$cfg" >/dev/null
}
probe_batch_preset_default base
probe_batch_preset_mutation() { probe_batch_preset_default mutation; }

RUNTIME_CFG=/tmp/test697-runtime-config.json
GOALS_PATH=/tmp/test697-goals.json
CODEX_CAPTURE=/tmp/test697-codex-capture.jsonl
STDIO_CAPTURE=/tmp/test697-stdio-capture.jsonl
RUNTIME_LOG=/tmp/test697-runtime.log
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
  : > "$RUNTIME_LOG"
  (
    cd "$PROJECT_DIR"
    exec setsid env HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" \
      TEST697_ROOT="$ROOT" TEST697_CODEX_CAPTURE="$CODEX_CAPTURE" \
      TEST697_STDIO_CAPTURE="$STDIO_CAPTURE" "$@" \
      bun "$ROOT/agent-node/src/cli.ts" \
        --alias sdk-default --config "$RUNTIME_CFG" --runtime codex-sdk \
        --goals-path "$GOALS_PATH"
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
    -d "{\"alias\":\"sdk-default\",\"task\":\"test697 runtime model $suffix $(date +%s%N)\",\"priority\":\"normal\"}" >/tmp/test697-task.json
}

wait_for_capture() {
  local pattern=$1 file=$2
  for _ in $(seq 1 80); do grep -Fq "$pattern" "$file" 2>/dev/null && return 0; sleep 0.25; done
  echo "CAPTURE_TIMEOUT pattern=$pattern file=$file"
  cat "$file" 2>/dev/null || true
  cat "$RUNTIME_LOG"
  return 1
}

probe_goal_wake_model() {
  : > "$CODEX_CAPTURE"
  cat > "$GOALS_PATH" <<JSON
{"version":1,"goals":[{"goal_id":"69700000-0000-4000-8000-000000000001","text":"test697 wake","status":"active","interval_ms":3600000,"next_wake_at":"2000-01-01T00:00:00.000Z","parent_task_id":"task-test697","report_to":"admin","runtime":"codex-sdk","created_at":"2000-01-01T00:00:00.000Z","updated_at":"2000-01-01T00:00:00.000Z","progress_log":[]}]}
JSON
  start_runtime_node wake || return 1
  wait_for_capture '"kind":"startThread"' "$CODEX_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se 'map(select(.kind=="startThread")) | length >= 1 and all(.[]; .value.model=="gpt-5.6-sol")' "$CODEX_CAPTURE" >/dev/null || {
    echo "WAKE_MODEL_INJECTION_WRONG"; cat "$CODEX_CAPTURE"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

probe_sdk_task_models() {
  : > "$CODEX_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  start_runtime_node sdk TEST697_CODEX_FAIL_FIRST=1 || return 1
  send_runtime_task sdk || { stop_runtime_node; return 1; }
  wait_for_capture '"kind":"run"' "$CODEX_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se 'map(select(.kind=="startThread")) | length >= 2 and all(.[]; .value.model=="gpt-5.6-sol")' "$CODEX_CAPTURE" >/dev/null || {
    echo "SDK_THREAD_MODEL_INJECTION_WRONG"; cat "$CODEX_CAPTURE"; stop_runtime_node; return 1;
  }
  grep -Fq '[codex] model=gpt-5.6-sol' "$RUNTIME_LOG" || {
    echo "SDK_LOG_MODEL_INJECTION_WRONG"; cat "$RUNTIME_LOG"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

probe_stdio_task_model() {
  : > "$STDIO_CAPTURE"
  printf '%s\n' '{"version":1,"goals":[]}' > "$GOALS_PATH"
  cp "$ROOT/tests/test697-codex-default-model/fake-codex-app-server.mjs" "$FAKE_BIN/codex"
  chmod 0755 "$FAKE_BIN/codex"
  start_runtime_node stdio ANET_CODEX_STDIO_DIRECT=1 || return 1
  send_runtime_task stdio || { stop_runtime_node; return 1; }
  wait_for_capture '"model"' "$STDIO_CAPTURE" || { stop_runtime_node; return 1; }
  jq -se 'length >= 1 and all(.[]; .model=="gpt-5.6-sol")' "$STDIO_CAPTURE" >/dev/null || {
    echo "STDIO_MODEL_INJECTION_WRONG"; cat "$STDIO_CAPTURE"; stop_runtime_node; return 1;
  }
  stop_runtime_node
}

echo "L7d real agent-node executes every default-model injection lane with fake transports"
probe_goal_wake_model
probe_sdk_task_models
probe_stdio_task_model

if [[ "${TEST697_SKIP_MUTATIONS:-0}" != "1" ]]; then
  echo "L8 witnessed-red mutations"
  run_mutation() {
    local name=$1 expected_layer=$2 file=$3 from=$4 to=$5 probe=$6
    local backup
    backup=$(mktemp /tmp/test697-mutation.XXXXXX)
    cp "$file" "$backup"
    local before after rc
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
    local before after rc
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

  probe_create_default() {
    create_node mutation-default codex-sdk
    jq -e '.model == "gpt-5.6-sol"' \
      "$PROJECT_DIR/.anet/nodes/mutation-default/config.json" >/dev/null
  }
  probe_explicit_model() {
    create_node mutation-explicit codex-sdk --model operator-custom-model
    jq -e '.model == "operator-custom-model"' \
      "$PROJECT_DIR/.anet/nodes/mutation-explicit/config.json" >/dev/null
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
      HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_LOG="$FAKE_TMUX_LOG" \
        timeout 5 "${ANET[@]}" node start copresence-default --copresence \
          --codex-bin "$FAKE_BIN/codex"
    ) >/tmp/test697-mut-copresence.log 2>&1 || true
    grep -Fq -- "-c model='gpt-5.6-sol'" "$FAKE_TMUX_LOG"
  }

  run_mutation denominator-retired-default L1 \
    "$ROOT/agent-network/src/codex-model-default.ts" \
    'DEFAULT_CODEX_MODEL = "gpt-5.6-sol"' 'DEFAULT_CODEX_MODEL = "gpt-5.5"' probe_production_denominator
  run_mutation default-regressed L4 \
    "$ROOT/agent-network/src/codex-model-default.ts" \
    'DEFAULT_CODEX_MODEL = "gpt-5.6-sol"' 'DEFAULT_CODEX_MODEL = "gpt-5.5"' probe_create_default
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
  run_mutation copresence-default-regressed L7b \
    "$ROOT/agent-network/bin/cli.ts" \
    'const model = opts.model || DEFAULT_CODEX_MODEL;' \
    'const model = opts.model || "gpt-4.1-legacy";' probe_copresence_default
  run_mutation batch-preset-default-regressed L7c \
    "$ROOT/agent-network/bin/cli.ts" \
    'vendor.models.find(m => m.default)' 'vendor.models.find(m => !m.default)' \
    probe_batch_preset_mutation
  run_mutation wake-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'model: resolveCodexModel(MODEL),' 'model: MODEL || "gpt-4.1-legacy",' \
    probe_goal_wake_model
  run_mutation sdk-thread-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'const codexModel = resolveCodexModel(MODEL);' 'const codexModel = MODEL || "gpt-4.1-legacy";' \
    probe_sdk_task_models
  run_mutation sdk-log-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    'const codexModelName = resolveCodexModel(MODEL);' 'const codexModelName = MODEL || "gpt-4.1-legacy";' \
    probe_sdk_task_models
  run_mutation sdk-retry-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    $'      model: resolveCodexModel(MODEL),\n      sandboxMode: "danger-full-access" as const,' \
    $'      model: MODEL || "gpt-4.1-legacy",\n      sandboxMode: "danger-full-access" as const,' \
    probe_sdk_task_models
  run_mutation stdio-model-injection-regressed L7d \
    "$ROOT/agent-node/src/cli.ts" \
    $'      model: resolveCodexModel(MODEL),\n      approvalPolicy: "on-request",' \
    $'      model: MODEL || "gpt-4.1-legacy",\n      approvalPolicy: "on-request",' \
    probe_stdio_task_model
fi

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "RESULT: PASS"
