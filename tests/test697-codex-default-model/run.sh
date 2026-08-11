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
cleanup() {
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
if rg -n 'gpt-5\.5' \
  "$ROOT/agent-network/bin/cli.ts" "$ROOT/agent-network/src" "$ROOT/agent-node/src" \
  --glob '!*.test.ts'; then
  echo "RETIRED_CODEX_DEFAULT_REMAINS"
  exit 1
fi
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
  if ! grep -Fq 'Codex / GPT' "$transcript" || ! grep -Fq 'gpt-5.6-sol' "$transcript"; then
    echo "PTY_PICKER_TRANSCRIPT_MISSING_SELECTION"
    cat "$transcript" 2>/dev/null || true
    return 1
  fi
}
probe_picker_default

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
fi

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "RESULT: PASS"
