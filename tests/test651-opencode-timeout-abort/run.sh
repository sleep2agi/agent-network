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
ANCHOR='const aborted = await abortOpenCodeSession(url, password, created.id, warn);'

run_case() {
  bun test src/runtime/opencode-copresence/runtime.test.ts -t "$1"
}

{
  echo "# Test 651 — OpenCode copresence timeout aborts the session"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo
  echo "## green — failed reply aborts the session; no late reply; abort failure is logged; a busy admission does not abort"
  run_case 'board651|admission timeout on a busy human session'
  echo
  echo "## mutation — delete the abort call; the same timeout assertion must go red"
  count=$(grep -F -c "$ANCHOR" "$SRC" || true)
  if [ "$count" != "1" ]; then
    echo "MUTATION_NOT_APPLIED: anchor count=$count"
    exit 1
  fi
  cp "$SRC" /tmp/runtime.ts.bak
  bun -e '
    const fs = require("fs");
    const path = process.argv[1];
    const anchor = process.argv[2];
    const text = fs.readFileSync(path, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) {
      console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
      process.exit(1);
    }
    fs.writeFileSync(path, text.replace(anchor, "const aborted = false;"));
  ' "$SRC" "$ANCHOR"
  if grep -F -q "$ANCHOR" "$SRC"; then
    echo "MUTATION_NOT_APPLIED: anchor still present"
    exit 1
  fi
  set +e
  run_case 'board651 reply deadline aborts the session' >/tmp/mutation651.log 2>&1
  rc=$?
  set -e
  cp /tmp/runtime.ts.bak "$SRC"
  cat /tmp/mutation651.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    exit 1
  fi
  if ! grep -F "ABORT ses_test123" /tmp/mutation651.log >/dev/null; then
    echo "MUTATION_RED_FOR_THE_WRONG_REASON"
    exit 1
  fi
  echo "MUTATION_RED rc=$rc"
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"
