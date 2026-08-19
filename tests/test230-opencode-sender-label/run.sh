#!/usr/bin/env bash
set -Eeuo pipefail

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：没有它这次运行钉不到任何提交，
# 而 scripts/qa.sh 在缺 ARG 时是**不传且不报错**的 —— 断言在这里才会让缺失显形。
[[ "${TEST230_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST230_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST230_SOURCE_COMMIT"

REPORT="${REPORT:-/report/report-test230.txt}"
mkdir -p "$(dirname "$REPORT")"

{
  echo "# Test 230 — OpenCode TUI sender-visible notification"
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
  echo "## Layer 1 — native runtime notification payload"
  bun test src/runtime/opencode-copresence/runtime.test.ts
  echo
  echo "## Layer 2 — production inbox-to-notification wiring"
  bun test src/runtime/opencode-copresence/inbox-wiring.test.ts
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"
