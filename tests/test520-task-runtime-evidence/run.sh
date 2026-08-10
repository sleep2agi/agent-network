#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
NODE="$ROOT/agent-node"
ARTIFACT_DIR=/artifacts
mkdir -p "$ARTIFACT_DIR"
REPORT="$ARTIFACT_DIR/report-test520-task-runtime-evidence.txt"
exec > >(tee "$REPORT") 2>&1

echo "source_commit=$TEST520_SOURCE_COMMIT"
echo "layer=agent-node exact runtime evidence"

cd "$NODE"
bun run build

bun test \
  src/task-runtime-evidence.test.ts \
  src/runtime/codex-app-server/runtime.test.ts \
  src/runtime/codex-app-server-bridge.test.ts \
  src/runtime/grok-build-acp/runtime.test.ts \
  src/runtime/grok-build-cli.test.ts \
  src/runtime/opencode-acp/runtime.test.ts \
  src/runtime/opencode-copresence/runtime.test.ts \
  src/runtime/opencode-copresence/inbox-wiring.test.ts

# The full Grok copresence file owns process-wide project locks. Run the new
# evidence case alone so unrelated lifetime fixtures cannot create a false red.
bun test src/runtime/grok-copresence/runtime.test.ts \
  --test-name-pattern 'reports exact submission'

MUTATIONS=0
expect_mutation_red() {
  local name=$1 file=$2 before=$3 after=$4 test_file=$5 pattern=${6:-}
  local backup
  backup=$(mktemp)
  cp "$file" "$backup"
  bun "$ROOT/tests/test520-task-runtime-evidence/mutate.mjs" \
    "$file" "$before" "$after"
  if cmp -s "$file" "$backup"; then
    echo "MUTATION INVALID byte-identical: $name" >&2
    cp "$backup" "$file"
    rm -f "$backup"
    exit 1
  fi
  set +e
  if [[ -n "$pattern" ]]; then
    bun test "$test_file" --test-name-pattern "$pattern" >/tmp/test520-mutation.log 2>&1
  else
    bun test "$test_file" >/tmp/test520-mutation.log 2>&1
  fi
  local rc=$?
  set -e
  cp "$backup" "$file"
  rm -f "$backup"
  if [[ $rc -eq 0 ]]; then
    echo "MUTATION SURVIVED: $name" >&2
    cat /tmp/test520-mutation.log >&2
    exit 1
  fi
  MUTATIONS=$((MUTATIONS + 1))
  echo "MUTATION RED: $name rc=$rc"
}

expect_mutation_red \
  logical-task-id \
  src/task-runtime-evidence.ts \
  'return message.task_id;' \
  'return String(message.id);' \
  src/task-runtime-evidence.test.ts \
  'retry/reassign task rows'

expect_mutation_red \
  reporter-dispatch \
  src/task-runtime-evidence.ts \
  'attempted.add(level);' \
  'return;' \
  src/task-runtime-evidence.test.ts \
  'submission and many runtime events'

expect_mutation_red \
  codex-appserver-consumed \
  src/runtime/codex-app-server/runtime.ts \
  'opts.onConsumed?.(ev);' \
  'void ev;' \
  src/runtime/codex-app-server/runtime.test.ts \
  'exact runtime submission'

expect_mutation_red \
  grok-copresence-consumed \
  src/runtime/grok-copresence/runtime.ts \
  'pending.onConsumed?.();' \
  'void pending;' \
  src/runtime/grok-copresence/runtime.test.ts \
  'reports exact submission'

expect_mutation_red \
  opencode-acp-consumed \
  src/runtime/opencode-acp/runtime.ts \
  'opts.onConsumed?.();' \
  'void opts;' \
  src/runtime/opencode-acp/runtime.test.ts \
  'reports submission before exact'

expect_mutation_red \
  grok-acp-consumed \
  src/runtime/grok-build-acp/runtime.ts \
  'opts.onConsumed?.();' \
  'void opts;' \
  src/runtime/grok-build-acp/runtime.test.ts

expect_mutation_red \
  grok-cli-consumed \
  src/runtime/grok-build-cli.ts \
  'opts.onConsumed?.();' \
  'void opts;' \
  src/runtime/grok-build-cli.test.ts \
  'reports spawn submission'

expect_mutation_red \
  opencode-copresence-consumed \
  src/runtime/opencode-copresence/runtime.ts \
  'evidence?.onConsumed?.();' \
  'void evidence;' \
  src/runtime/opencode-copresence/runtime.test.ts \
  'one authenticated loopback session'

expect_mutation_red \
  claude-sdk-consumed \
  src/cli.ts \
  $'for await (const message of messages) {\n            evidence?.consumed();' \
  $'for await (const message of messages) {\n            void evidence;' \
  src/task-runtime-evidence.test.ts \
  'SDK and direct-stdio boundaries'

expect_mutation_red \
  codex-sdk-consumed \
  src/cli.ts \
  $'for await (const ev of events) {\n          evidence?.consumed();' \
  $'for await (const ev of events) {\n          void evidence;' \
  src/task-runtime-evidence.test.ts \
  'SDK and direct-stdio boundaries'

expect_mutation_red \
  codex-stdio-submitted \
  src/cli.ts \
  $'evidence?.submitted();\n      log(`[codex-stdio]' \
  $'void evidence;\n      log(`[codex-stdio]' \
  src/task-runtime-evidence.test.ts \
  'SDK and direct-stdio boundaries'

if [[ $MUTATIONS -ne 11 ]]; then
  echo "mutation denominator mismatch: $MUTATIONS/11" >&2
  exit 1
fi

echo "mutation_red=$MUTATIONS/11"
echo "RESULT: PASS"
