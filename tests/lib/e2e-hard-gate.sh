#!/usr/bin/env bash
set -euo pipefail

LOG_FILE=${1:-}
RUNNER_RC=${2:-}
MIN_PASS=${E2E_MIN_PASS:-175}

if [[ -z "$LOG_FILE" || ! -s "$LOG_FILE" ]]; then
  echo "ERROR: test-all.sh produced no output" >&2
  exit 1
fi
if [[ ! "$RUNNER_RC" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid or missing runner exit code: ${RUNNER_RC:-<empty>}" >&2
  exit 1
fi
if [[ ! "$MIN_PASS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid minimum pass count: $MIN_PASS" >&2
  exit 1
fi

mapfile -t total_lines < <(grep -F 'TOTAL: ' "$LOG_FILE" || true)
if (( ${#total_lines[@]} != 1 )); then
  echo "ERROR: expected exactly one structured TOTAL line, found ${#total_lines[@]}" >&2
  exit 1
fi

total_line=${total_lines[0]}
if [[ ! "$total_line" =~ TOTAL:\ ([0-9]+)\ passed,\ ([0-9]+)\ failed ]]; then
  echo "ERROR: malformed TOTAL line" >&2
  exit 1
fi
passed=${BASH_REMATCH[1]}
failed=${BASH_REMATCH[2]}

echo "runner exit code: $RUNNER_RC"
echo "$total_line"

if (( passed < MIN_PASS )); then
  echo "ERROR: incomplete regression: $passed passes is below minimum $MIN_PASS" >&2
  exit 1
fi
if (( failed > 0 )); then
  echo "ERROR: Docker E2E reported $failed failing tests" >&2
  exit 1
fi
if (( RUNNER_RC != 0 )); then
  echo "ERROR: Docker E2E runner exited non-zero ($RUNNER_RC)" >&2
  exit 1
fi

echo "PASS: full Docker E2E regression is complete and green"
