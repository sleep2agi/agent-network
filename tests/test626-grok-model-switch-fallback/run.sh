#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test626.txt}"
RUNTIME="$ROOT/agent-node/src/runtime/grok-copresence/runtime.ts"
BACKUP=/tmp/test626-runtime.ts
TARGET_TEST="src/runtime/grok-copresence/slash-gate.test.ts"
TARGET_NAME="incompatible-agent"
RELATED_TESTS=(
  src/runtime/grok-copresence/runtime.test.ts
  src/runtime/grok-copresence/slash-gate.test.ts
)

mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test626 - Grok /model hot switch with restart fallback"
echo "date: $(date -Is)"
echo "mode: pure-bun witnessed-red-green"

cd "$ROOT/agent-node"
node --version
bun --version

cp "$RUNTIME" "$BACKUP"
restore_runtime() {
  cp "$BACKUP" "$RUNTIME"
}
trap restore_runtime EXIT

echo
echo "## witnessed-red: fallback disabled mutation"
python3 - <<'PY'
from pathlib import Path

path = Path("/workspace/agent-node/src/runtime/grok-copresence/runtime.ts")
text = path.read_text()
needle = "      try {\n        const fallback = fallbackGrokModelSwitchRestart();"
replacement = "      try {\n        throw error;\n        const fallback = fallbackGrokModelSwitchRestart();"
if needle not in text:
    raise SystemExit("mutation target not found")
path.write_text(text.replace(needle, replacement, 1))
PY

set +e
bun test "$TARGET_TEST" -t "$TARGET_NAME" 2>&1 | tee /tmp/test626-red.log
red_rc=$?
set -e
if grep -Fq "matched 0 tests" /tmp/test626-red.log; then
  echo "FAIL: witnessed-red selector matched 0 tests"
  exit 1
fi
if [[ "$red_rc" -eq 0 ]]; then
  echo "FAIL: witnessed-red mutation unexpectedly passed"
  exit 1
fi
echo "PASS: witnessed-red mutation failed as expected"

restore_runtime

echo
echo "## green: current source"
bun test "$TARGET_TEST" -t "$TARGET_NAME"
echo "PASS: green fallback test passed"

echo
echo "## full related suite"
bun test "${RELATED_TESTS[@]}"
echo "PASS: full related suite passed"
