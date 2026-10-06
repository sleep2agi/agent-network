#!/usr/bin/env bash
set -Eeuo pipefail

# SHA binding. scripts/qa.sh passes this only when the Dockerfile declares
# ARG TEST<digits>_SOURCE_COMMIT. A missing value must fail here, not look green.
[[ "${TEST656_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST656_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST656_SOURCE_COMMIT"

cd /agent-node-src
REPORT="${REPORT:-/report/report-test656.txt}"
mkdir -p "$(dirname "$REPORT")"

SRC=src/runtime/codex-app-server/runtime.ts
ANCHOR='const capacityDecision = capacityRetryDecision(capacityRetries, raw);'
REPL='const capacityDecision = ({ action: "give_up" as const });'

# Cooperation with #651: the capacity sleep pauses the codex response-idle
# timer (it is not model-idle time) and, on the OpenCode lane, adds the
# backoff onto the reply deadline before sleeping outside AbortSignal.
# A real timeout still fails or aborts exactly as #651. This suite does not
# change that abort decision.

run_green() {
  bun test \
    src/runtime/capacity-retry.test.ts \
    src/runtime/codex-app-server/capacity-retry.test.ts
  bun test src/runtime/opencode-copresence/runtime.test.ts -t 'board656 capacity wait extends the reply deadline'
}

run_mutation_case() {
  bun test src/runtime/codex-app-server/capacity-retry.test.ts -t 'board656 capacity then one reply'
}

received_trace() {
  grep -F 'Received:' "$1" | head -n 1 | tr -d '\033'
}

apply_mutation() {
  local count
  count=$(grep -F -c "$ANCHOR" "$SRC" || true)
  if [ "$count" != "1" ]; then
    echo "MUTATION_NOT_APPLIED: anchor count=$count"
    exit 1
  fi
  cp "$SRC" /tmp/mutation656.bak
  bun -e '
    const fs = require("fs");
    const path = process.argv[1];
    const anchor = process.argv[2];
    const repl = process.argv[3];
    const text = fs.readFileSync(path, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) {
      console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
      process.exit(1);
    }
    fs.writeFileSync(path, text.replace(anchor, repl));
  ' "$SRC" "$ANCHOR" "$REPL"
  if grep -F -q "$ANCHOR" "$SRC"; then
    echo "MUTATION_NOT_APPLIED: anchor still present"
    exit 1
  fi
}

restore_mutation() {
  cp /tmp/mutation656.bak "$SRC"
}

{
  echo "# Test 656 — capacity backoff retries the same model"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo
  echo "## green — fake app-server at capacity retries; one success reply; quota does not; wait is not a timeout"
  run_green
  echo
  echo "## mutation — drop the retry decision; the success case must come back 1:0:fail"
  apply_mutation
  set +e
  run_mutation_case >/tmp/mutation656.log 2>&1
  rc=$?
  set -e
  restore_mutation
  cat /tmp/mutation656.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    exit 1
  fi
  line=$(received_trace /tmp/mutation656.log)
  case "$line" in
    *'1:0:fail'*) ;;
    *) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace was not 1:0:fail"; exit 1 ;;
  esac
  case "$line" in
    *'2:1:ok'*) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace still retried"; exit 1 ;;
  esac
  echo "MUTATION_RED rc=$rc"
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"
