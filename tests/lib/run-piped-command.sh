#!/usr/bin/env bash
set -u -o pipefail

if (( $# < 3 )); then
  echo "usage: run-piped-command.sh <log-file> <exit-code-file> <command> [args...]" >&2
  exit 2
fi

LOG_FILE=$1
EXIT_CODE_FILE=$2
shift 2

# The caller needs the complete log even when the runner fails. Keep this
# wrapper successful so the following `if: always()` gate can print the final
# report, but persist the *left side* of the pipeline rather than tee's status.
set +e
"$@" 2>&1 | tee "$LOG_FILE"
pipeline_status=("${PIPESTATUS[@]}")
runner_rc=${pipeline_status[0]}
tee_rc=${pipeline_status[1]}
if (( tee_rc != 0 )); then
  # An incomplete log is not a trustworthy verdict. Keep the value deliberately
  # non-numeric so the hard gate fails closed instead of trusting runner_rc.
  printf 'tee_failed_%s\n' "$tee_rc" > "$EXIT_CODE_FILE"
else
  printf '%s\n' "$runner_rc" > "$EXIT_CODE_FILE"
fi
exit 0
