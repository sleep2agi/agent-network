#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
mkdir -p "$ARTIFACT_DIR"

run_case() {
  local name=$1
  local script=$2
  local home="/tmp/test639-${name}-home"
  local rc=0
  HOME="$home" timeout 90 "$script" >"$ARTIFACT_DIR/${name}.log" 2>&1 || rc=$?
  printf '%s' "$rc" >"$ARTIFACT_DIR/${name}.rc"
  echo "$name rc=$rc"
}

echo "source_commit=$TEST639_SOURCE_COMMIT"
run_case networks /app/test-networks.sh
run_case config /app/test-config.sh

network_rc=$(cat "$ARTIFACT_DIR/networks.rc")
config_rc=$(cat "$ARTIFACT_DIR/config.rc")

[[ "$network_rc" -ne 0 ]] || { echo "FAIL: legacy network test unexpectedly passed"; exit 1; }
grep -q "alpha task missing" "$ARTIFACT_DIR/networks.log" \
  || { echo "FAIL: network red was not the missing unregistered alias fixture"; exit 1; }
[[ "$config_rc" -ne 0 ]] || { echo "FAIL: legacy config test unexpectedly passed"; exit 1; }
if grep -q "Results:" "$ARTIFACT_DIR/config.log"; then
  echo "FAIL: config script reached its assertions instead of aborting during setup"
  exit 1
fi

echo "RESULT: WITNESSED RED"
