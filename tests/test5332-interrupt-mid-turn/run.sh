#!/usr/bin/env bash
set -euo pipefail

# SHA binding. scripts/qa.sh passes this only when the Dockerfile declares
# ARG TEST<digits>_SOURCE_COMMIT. A missing value must fail here, not look green.
[[ "${TEST5332_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST5332_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST5332_SOURCE_COMMIT"

cd /workspace
SCENARIO=/workspace/tests/test5332-interrupt-mid-turn/scenario.ts
cp agent-node/src/cli.ts /tmp/cli.orig
restore() { cp /tmp/cli.orig agent-node/src/cli.ts; }
trap restore EXIT

mutate() {
  FILE="agent-node/src/cli.ts" bun -e '
    const fs = require("fs");
    const { FILE, ANCHOR, REPL } = process.env;
    const text = fs.readFileSync(FILE, "utf8");
    const n = text.split(ANCHOR).length - 1;
    if (n !== 1) { console.error("MUTATION_NOT_APPLIED: anchor count=" + n); process.exit(1); }
    fs.writeFileSync(FILE, text.replace(ANCHOR, REPL));
  '
}

settle() {
  # The oven/bun image has no pkill. Match the command lines under /proc.
  local pid cmdline
  for pid in /proc/[0-9]*; do
    pid=${pid#/proc/}
    cmdline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmdline" in
      *'/workspace/server/src/index.ts'*|*'agent-node/src/cli.ts'*|*'/opt/fake-grok/grok'*)
        kill -9 "$pid" >/dev/null 2>&1 || true ;;
    esac
  done
  sleep 0.2
}

expect_red() {
  local needle="$1" log="/tmp/scenario5332.log" rc line
  settle
  set +e; bun "$SCENARIO" >"$log" 2>&1; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then echo "MUTATION_FALSE_GREEN"; cat "$log"; exit 1; fi
  line=$(grep -F 'FAIL:' "$log" | head -n 1 || true)
  if [ "$line" != "$needle" ]; then echo "WRONG_FAILURE: ${line:-no FAIL line}"; cat "$log"; exit 1; fi
  echo "MUTATION_RED: $line"
}

echo "## green — a stop sent mid-turn cancels the turn; an idle stop says so; the node keeps working"
settle
bun "$SCENARIO"

echo "## mutation — the stream event no longer wakes the control lane (stop waits behind the turn)"
ANCHOR='if ((ev as any).control) void drainControlNow();' \
REPL='if (false && (ev as any).control) void drainControlNow();' mutate
expect_red 'FAIL: stop did not reach the runtime while the turn was running'
restore

# Not mutated here: "a handled stop is not remembered". On this path the stop is acknowledged before
# the busy work lane can fetch the same row again, so forgetting it changes nothing observable
# (tried: the scenario stays green). That race is pinned in agent-node/src/control-lane.test.ts.

echo "OVERALL: PASS"
