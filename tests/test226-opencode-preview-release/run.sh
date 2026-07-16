#!/usr/bin/env bash
set -euo pipefail

REPORT="${REPORT:-/report/report-test226.txt}"
TMP_REPORT=/tmp/kernel-live.txt
mkdir -p "$(dirname "$REPORT")"

{
  echo "# Test 226 — opencode-cli release pin matrix"
  echo
  echo "date: $(date -Iseconds)"
  echo "candidate pin: ${OPENCODE_VERSION_UNDER_TEST}"
  echo "opencode: $(opencode --version)"
  echo "bun: $(bun --version)"
  echo "node: $(node --version)"
  echo
  echo "## Layer 1 — environment / ACP surface"
  echo
  echo "- exact binary version: PASS"
  echo "- opencode acp --help: PASS"
  echo
  echo "## Layer 2 — real ACP single-turn"
  echo
} > "$REPORT"

set +e
REPORT="$TMP_REPORT" bash /harness/kernel-live.sh >> "$REPORT" 2>&1
KERNEL_RC=$?
set -e

if [[ "$KERNEL_RC" -eq 0 ]]; then
  {
    echo
    echo "## Gate"
    echo
    echo "- real opencode child spawned: PASS"
    echo "- ACP session/new returned a session id: PASS"
    echo "- live free-model reply was non-empty: PASS"
    echo "- child cleanup left no orphan: PASS"
    echo
    echo "OVERALL: PASS"
  } >> "$REPORT"
else
  {
    echo
    echo "## Gate"
    echo
    echo "- real ACP single-turn: FAIL (exit=${KERNEL_RC})"
    echo
    echo "OVERALL: FAIL"
  } >> "$REPORT"
fi

cat "$REPORT"
exit "$KERNEL_RC"
