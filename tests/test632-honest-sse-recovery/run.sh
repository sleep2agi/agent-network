#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test632-honest-sse-recovery.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test632 — honest SSE abandon recovery guidance"
echo "source_commit=${TEST632_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

cd /workspace

run_tests() {
  bun test agent-node/src/sse-recovery-guidance.test.ts
}

echo "L0 helper behaviour + production wiring"
run_tests

echo "L1 real agent-node bundle"
bun build agent-node/src/cli.ts \
  --outdir /tmp/test632-dist \
  --entry-naming cli.js \
  --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk \
  --external node-pty
test -s /tmp/test632-dist/cli.js

echo "L2 witnessed-red: restore the dangerous duplicate-start guidance"
cp agent-node/src/sse-recovery-guidance.ts /tmp/test632-guidance.ts
sed -i 's/`当前 agent-node 实例（alias=${alias}）仍在运行；不要另起同 alias 实例，否则会产生重复消费者。`/`运行 `anet node start ${alias}` 手动恢复。`/' agent-node/src/sse-recovery-guidance.ts
grep -Fq 'anet node start ${alias}' agent-node/src/sse-recovery-guidance.ts
set +e
run_tests >/tmp/test632-guidance-mutation.log 2>&1
guidance_rc=$?
set -e
if [ "$guidance_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: duplicate-start-guidance"
  exit 1
fi
echo "MUTATION_RED: duplicate-start-guidance rc=$guidance_rc"
cp /tmp/test632-guidance.ts agent-node/src/sse-recovery-guidance.ts

echo "L3 witnessed-red: bypass the helper in the production abandon hook"
cp agent-node/src/cli.ts /tmp/test632-cli.ts
sed -i 's/onAbandon: () => error(sseAbandonGuidance(ALIAS, COMMHUB_URL))/onAbandon: () => error(`abandoned`)/' agent-node/src/cli.ts
grep -Fq 'onAbandon: () => error(`abandoned`)' agent-node/src/cli.ts
set +e
run_tests >/tmp/test632-wiring-mutation.log 2>&1
wiring_rc=$?
set -e
if [ "$wiring_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: production-hook-bypass"
  exit 1
fi
echo "MUTATION_RED: production-hook-bypass rc=$wiring_rc"
cp /tmp/test632-cli.ts agent-node/src/cli.ts

echo "L4 restored green"
run_tests

echo "RESULT: PASS"
