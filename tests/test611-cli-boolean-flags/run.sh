#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test611-cli-boolean-flags.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test611 — CLI presence-only boolean flags"
echo "source_commit=${TEST611_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_unit() {
  bun test \
    agent-network/src/cli-args.test.ts \
    agent-network/src/cli-args-wiring.test.ts
}

echo "L0 typecheck"
cd /workspace/agent-network
bun run typecheck
cd /workspace

echo "L1 parser matrix"
run_unit

echo "L2 full CLI build with shared parser wiring"
cd /workspace/agent-network
bun run build
cd /workspace
grep -Fq 'import { parseCliOptions, positionalArgs } from "../src/cli-args";' \
  agent-network/bin/cli.ts
grep -Fq 'const parsed = parseCliOptions(args);' agent-network/bin/cli.ts

echo "L3 witnessed-red: each formerly missing flag"
cp agent-network/src/cli-args.ts /tmp/test611-cli-args.ts
for flag in \
  accept-dev-channels \
  dev-open \
  dry-run \
  follow \
  no-auto-self \
  no-yolo \
  resume-latest \
  self \
  f
do
  cp /tmp/test611-cli-args.ts agent-network/src/cli-args.ts
  sed -i "/\"--${flag}\",/d" agent-network/src/cli-args.ts
  if grep -Fq "\"--${flag}\"," agent-network/src/cli-args.ts; then
    echo "FAIL: mutation did not remove --${flag}"
    exit 1
  fi
  set +e
  bun test agent-network/src/cli-args.test.ts \
    -t "--${flag} does not swallow a following positional operand" \
    >/tmp/test611-${flag}.log 2>&1
  mutation_rc=$?
  set -e
  if [ "$mutation_rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: boolean-${flag}"
    exit 1
  fi
  grep -Fq 'expect(received).toEqual(expected)' /tmp/test611-${flag}.log
  echo "MUTATION_RED: boolean-${flag} rc=$mutation_rc"
done
cp /tmp/test611-cli-args.ts agent-network/src/cli-args.ts

echo "L4 witnessed-red: disconnecting the CLI wrapper"
cp agent-network/bin/cli.ts /tmp/test611-cli.ts
sed -i 's/const parsed = parseCliOptions(args);/const parsed = { _channels: [], _envs: [] };/' \
  agent-network/bin/cli.ts
set +e
bun test agent-network/src/cli-args-wiring.test.ts >/tmp/test611-wiring.log 2>&1
wiring_rc=$?
set -e
if [ "$wiring_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: cli-parser-wiring"
  exit 1
fi
grep -Fq 'toContain' /tmp/test611-wiring.log
echo "MUTATION_RED: cli-parser-wiring rc=$wiring_rc"
cp /tmp/test611-cli.ts agent-network/bin/cli.ts

echo "L5 restored green"
run_unit

echo "RESULT: PASS"
