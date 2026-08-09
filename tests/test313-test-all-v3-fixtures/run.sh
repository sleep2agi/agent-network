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
case "${TEST639_MUTATION:-none}" in
  none) ;;
  drop-node-registration)
    sed -i '/^register_agent agent-[ab] /d' /app/test-networks.sh
    ;;
  drop-login-bootstrap)
    sed -i '/^anet login .*test639-login\.log$/d' /app/test-config.sh
    ;;
  *) echo "FAIL: unknown TEST639_MUTATION"; exit 2 ;;
esac

case "${TEST639_CASE:-all}" in
  networks) run_case networks /app/test-networks.sh ;;
  config) run_case config /app/test-config.sh ;;
  all)
    echo "FAIL: run the two legacy scripts in separate containers so their fixed port cannot interfere"
    exit 2
    ;;
  *) echo "FAIL: unknown TEST639_CASE"; exit 2 ;;
esac

case "${TEST639_EXPECT:-green}" in
green)
  rc=$(cat "$ARTIFACT_DIR/${TEST639_CASE}.rc")
  [[ "$rc" -eq 0 ]] || { cat "$ARTIFACT_DIR/${TEST639_CASE}.log"; echo "FAIL: repaired script returned $rc"; exit 1; }
  grep -q "Results:" "$ARTIFACT_DIR/${TEST639_CASE}.log" \
    || { echo "FAIL: repaired script did not finish its assertions"; exit 1; }
  grep -q '❌' "$ARTIFACT_DIR/${TEST639_CASE}.log" \
    && { echo "FAIL: repaired script reported a failed assertion"; exit 1; }
  echo "RESULT: PASS"
  ;;
red)
if [[ "${TEST639_CASE}" == networks ]]; then
  network_rc=$(cat "$ARTIFACT_DIR/networks.rc")
  [[ "$network_rc" -ne 0 ]] || { echo "FAIL: broken network fixture unexpectedly passed"; exit 1; }
  grep -q "alpha task missing" "$ARTIFACT_DIR/networks.log" \
    || { echo "FAIL: network red was not the missing alias fixture"; exit 1; }
else
  config_rc=$(cat "$ARTIFACT_DIR/config.rc")
  [[ "$config_rc" -ne 0 ]] || { echo "FAIL: broken config fixture unexpectedly passed"; exit 1; }
  if grep -q "Results:" "$ARTIFACT_DIR/config.log"; then
    echo "FAIL: config script reached its assertions instead of aborting during setup"
    exit 1
  fi
fi
echo "RESULT: WITNESSED RED"
;;
*) echo "FAIL: unknown TEST639_EXPECT"; exit 2 ;;
esac
