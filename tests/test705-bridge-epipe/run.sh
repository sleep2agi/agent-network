#!/usr/bin/env bash
set -euo pipefail
REPORT=${REPORT:-/repo/docs/tests/report-test705-bridge-epipe.txt}
mkdir -p "$(dirname "$REPORT")"

expect_red() {
  local label=$1 needle=$2
  shift 2
  local rc=0
  "$@" >/tmp/test705-red.log 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"; cat /tmp/test705-red.log; exit 1
  fi
  if ! grep -Fq "$needle" /tmp/test705-red.log; then
    echo "MUTATION_RED_FOR_WRONG_REASON: $label wanted=$needle"; cat /tmp/test705-red.log; exit 1
  fi
  echo "WITNESSED_RED: $label ($needle)"
}

{
  echo "Test 705 — bridge survives a broken stdout tee"
  echo "source_commit=${SOURCE_COMMIT:-unknown}"
  echo
  echo "Layer 1: process + tee behavior"
  (cd /repo/agent-node && bun test src/process-survival-log.test.ts)
  (cd /repo/agent-network && bun test src/codex-copresence-bridge-log.test.ts)

  echo
  echo "Layer 2: typecheck and production builds"
  (cd /repo/agent-node && bun run build)
  (cd /repo/agent-network && bun run typecheck)

  echo
  echo "Layer 3: witnessed-red mutations"
  cp /repo/agent-node/src/process-survival-log.ts /tmp/process-survival-log.ts
  bun /repo/mutation.mjs /repo/agent-node/src/process-survival-log.ts \
    '  stdout.on("error", streamError("stdout"));' ''
  expect_red no-stdout-epipe-listener "closed stdout records EPIPE" \
    bash -lc 'cd /repo/agent-node && bun test src/process-survival-log.test.ts -t "closed stdout records EPIPE"'
  cp /tmp/process-survival-log.ts /repo/agent-node/src/process-survival-log.ts

  cp /repo/agent-node/src/cli.ts /tmp/agent-node-cli.ts
  bun /repo/mutation.mjs /repo/agent-node/src/cli.ts \
    'if (!processSurvivalLog.outputBroken()) console.log(line);' 'console.log(line);'
  expect_red cli-does-not-switch-to-file-only "the production logger switches to file-only output after EPIPE" \
    bash -lc 'cd /repo/agent-node && bun test src/process-survival-log.test.ts -t "production logger switches"'
  cp /tmp/agent-node-cli.ts /repo/agent-node/src/cli.ts

  bun /repo/mutation.mjs /repo/agent-node/src/process-survival-log.ts \
    '  process.on("uncaughtException", (cause) => fatal("uncaughtException", cause));' ''
  expect_red no-uncaught-diagnostic "uncaught exception preserves its stack" \
    bash -lc 'cd /repo/agent-node && bun test src/process-survival-log.test.ts -t "uncaught exception preserves its stack"'
  cp /tmp/process-survival-log.ts /repo/agent-node/src/process-survival-log.ts

  bun /repo/mutation.mjs /repo/agent-node/src/process-survival-log.ts \
    '        writeSync(2, `${detail}\n`);' '        // mutation: swallowed the fatal stack instead of preserving stderr'
  expect_red no-fatal-stderr-stack "uncaught exception preserves its stack" \
    bash -lc 'cd /repo/agent-node && bun test src/process-survival-log.test.ts -t "uncaught exception preserves its stack"'
  cp /tmp/process-survival-log.ts /repo/agent-node/src/process-survival-log.ts

  cp /repo/agent-network/src/codex-copresence-bridge-log.ts /tmp/codex-copresence-bridge-log.ts
  bun /repo/mutation.mjs /repo/agent-network/src/codex-copresence-bridge-log.ts \
    'then tee_arg=-p; fi;' 'then tee_arg=; fi;'
  expect_red tee-without-p "tee keeps the writer alive" \
    bash -lc 'cd /repo/agent-network && bun test src/codex-copresence-bridge-log.test.ts -t "tee keeps the writer alive"'
  cp /tmp/codex-copresence-bridge-log.ts /repo/agent-network/src/codex-copresence-bridge-log.ts

  bun /repo/mutation.mjs /repo/agent-network/src/codex-copresence-bridge-log.ts \
    'tee_arg=; if tee -p </dev/null >/dev/null 2>&1;' 'tee_arg=-p; if false;'
  expect_red tee-without-portable-fallback "a non-GNU tee falls back" \
    bash -lc 'cd /repo/agent-network && bun test src/codex-copresence-bridge-log.test.ts -t "a non-GNU tee falls back"'
  cp /tmp/codex-copresence-bridge-log.ts /repo/agent-network/src/codex-copresence-bridge-log.ts

  echo
  echo "RESULT: PASS"
} 2>&1 | sed 's/[[:space:]]*$//' | tee "$REPORT"
