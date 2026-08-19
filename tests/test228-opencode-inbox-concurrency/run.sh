#!/usr/bin/env bash
set -Eeuo pipefail

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：没有它这次运行钉不到任何提交，
# 而 scripts/qa.sh 在缺 ARG 时是**不传且不报错**的 —— 断言在这里才会让缺失显形。
[[ "${TEST228_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST228_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST228_SOURCE_COMMIT"

REPORT="${REPORT:-/report/report-test228.txt}"
mkdir -p "$(dirname "$REPORT")"

{
  echo "# Test 228 — OpenCode inbox concurrency and lifecycle wiring"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo
  echo "## Layer 0 — production bundle compiles"
  bun build src/cli.ts --outdir /tmp/dist --entry-naming cli.js --target node --minify \
    --external @anthropic-ai/claude-agent-sdk \
    --external '@anthropic-ai/claude-agent-sdk-*' \
    --external @openai/codex-sdk
  test -s /tmp/dist/cli.js
  echo
  echo "## Layer 1 — serialized inbox lanes"
  bun test src/runtime/inbox-drain-lane.test.ts
  echo
  echo "## Layer 2 — single-flight runtime startup"
  bun test src/util/single-flight.test.ts
  echo
  echo "## Layer 3 — CLI integration wiring"
  bun test src/runtime/opencode-copresence/inbox-wiring.test.ts
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"
