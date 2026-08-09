#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test606-node-start-help.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test606 — node start headless help"
echo "source_commit=${TEST606_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_help_test() {
  bun test agent-network/src/node-start-help.test.ts
}

echo "L0 typecheck"
cd agent-network
bun run typecheck
cd /workspace

echo "L1 real source CLI help"
run_help_test

echo "L2 packaged/obfuscated CLI help"
cd agent-network
bun run build
node dist/bin/cli.js node start --help >/tmp/test606-packed-help.txt
cd /workspace
grep -Fq -- '--accept-dev-channels' /tmp/test606-packed-help.txt
grep -Fq -- 'Headless / CI / no-TTY' /tmp/test606-packed-help.txt
grep -Fq -- 'requires tmux' /tmp/test606-packed-help.txt

echo "L3 witnessed-red: removing the start-help route hides the flag"
cp agent-network/bin/cli.ts /tmp/test606-cli.ts
sed -i 's/if (args\[1\] === "start")/if (false \&\& args[1] === "start")/' agent-network/bin/cli.ts
grep -Fq 'if (false && args[1] === "start")' agent-network/bin/cli.ts
set +e
run_help_test >/tmp/test606-red.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: node-start-specific-help-route"
  sed -n '1,200p' /tmp/test606-red.log
  exit 1
fi
echo "MUTATION_RED: node-start-specific-help-route rc=$rc"
cp /tmp/test606-cli.ts agent-network/bin/cli.ts

echo "L4 restored green"
run_help_test

echo "RESULT: PASS"
