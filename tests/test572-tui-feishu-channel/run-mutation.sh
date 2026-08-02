#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
bun tests/test572-tui-feishu-channel/mutate.mjs "$mode"

set +e
case "$mode" in
  origin) bun agent-network/tests/feishu-envelope-compat.test.ts ;;
  codex) bun test agent-node/src/runtime/codex-app-server-bridge.test.ts ;;
  *) echo "unknown mutation: $mode" >&2; exit 2 ;;
esac
test_rc=$?
set -e

echo "MUTATION_TEST_RC=$test_rc"
if [[ "$test_rc" -eq 0 ]]; then
  echo "MUTATION SURVIVED: expected the production guard test to fail" >&2
  exit 1
fi
echo "WITNESSED_RED: $mode mutation was caught"
