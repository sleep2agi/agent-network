#!/usr/bin/env bash
set -Eeuo pipefail

# SHA binding. scripts/qa.sh passes this only when the Dockerfile declares
# ARG TEST<digits>_SOURCE_COMMIT. A missing value must fail here, not look green.
[[ "${TEST651_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST651_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST651_SOURCE_COMMIT"

cd /agent-node-src
REPORT="${REPORT:-/report/report-test651.txt}"
mkdir -p "$(dirname "$REPORT")"

SRC=src/runtime/opencode-copresence/runtime.ts
OWN=src/runtime/opencode-copresence/reply-ownership.ts
ANCHOR='const aborted = await abortOpenCodeSession(url, password, created.id, warn);'
ANCHOR_UNREADABLE='if (!Array.isArray(history)) return "leave_running";'
ANCHOR_LIVE='if (liveId !== submittedId) return "leave_running";'

run_case() {
  bun test src/runtime/opencode-copresence/runtime.test.ts -t "$1"
}

# bun prints the failing expect's actual value on one `Received:` line.
# The expected literal also appears on the `Expected ...` line; that line is
# not evidence of what the fake server did. Color codes sit between the label
# and the quote when stdout is a TTY, so match the label and strip ESC.
received_trace() {
  grep -F 'Received:' "$1" | head -n 1 | tr -d '\033'
}

apply_mutation() {
  local file="$1" anchor="$2" repl="$3"
  local count
  count=$(grep -F -c "$anchor" "$file" || true)
  if [ "$count" != "1" ]; then
    echo "MUTATION_NOT_APPLIED: anchor count=$count"
    exit 1
  fi
  cp "$file" /tmp/mutation651.bak
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
  ' "$file" "$anchor" "$repl"
  if grep -F -q "$anchor" "$file"; then
    echo "MUTATION_NOT_APPLIED: anchor still present"
    exit 1
  fi
}

restore_mutation() {
  cp /tmp/mutation651.bak "$1"
}

{
  echo "# Test 651 — OpenCode copresence timeout aborts the session"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo
  echo "## green — abort only when the live turn is ours; unread history and a human turn ahead do not abort"
  run_case 'board651|admission timeout on a busy human session|timed out without landing'
  echo
  echo "## green — abort decision"
  bun test src/runtime/opencode-copresence/reply-ownership.test.ts -t 'timedOutTurnAbortDecision'
  echo
  echo "## mutation — delete the abort call; the timeout trace must show the message POST and no abort"
  apply_mutation "$SRC" "$ANCHOR" 'const aborted = false;'
  set +e
  run_case 'board651 reply deadline aborts the session' >/tmp/mutation651.log 2>&1
  rc=$?
  set -e
  restore_mutation "$SRC"
  cat /tmp/mutation651.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    exit 1
  fi
  line=$(received_trace /tmp/mutation651.log)
  case "$line" in
    *'POST /session/ses_test123/message'*) ;;
    *) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace has no message POST"; exit 1 ;;
  esac
  case "$line" in
    *'ABORT ses_test123'*) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace still aborted"; exit 1 ;;
  esac
  echo "MUTATION_RED rc=$rc"
  echo
  echo "## mutation — unreadable history treated as abort must go red"
  apply_mutation "$OWN" "$ANCHOR_UNREADABLE" 'if (!Array.isArray(history)) return "abort";'
  set +e
  run_case 'board651 history read failure does not abort' >/tmp/mutation651.log 2>&1
  rc=$?
  set -e
  restore_mutation "$OWN"
  cat /tmp/mutation651.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    exit 1
  fi
  line=$(received_trace /tmp/mutation651.log)
  case "$line" in
    *'ABORT ses_test123'*) ;;
    *) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace was not an abort"; exit 1 ;;
  esac
  echo "MUTATION_RED rc=$rc"
  echo
  echo "## mutation — human turn ahead treated as ours must go red"
  apply_mutation "$OWN" "$ANCHOR_LIVE" ''
  set +e
  run_case 'board651 human turn ahead of ours does not abort' >/tmp/mutation651.log 2>&1
  rc=$?
  set -e
  restore_mutation "$OWN"
  cat /tmp/mutation651.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    exit 1
  fi
  line=$(received_trace /tmp/mutation651.log)
  case "$line" in
    *'ABORT ses_test123'*) ;;
    *) echo "MUTATION_RED_FOR_THE_WRONG_REASON: received trace was not an abort"; exit 1 ;;
  esac
  echo "MUTATION_RED rc=$rc"
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"
