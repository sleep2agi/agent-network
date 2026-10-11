#!/bin/sh
set -eu
test -f /.dockerenv
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ]; then
  test "${#SOURCE_COMMIT}" = 40
  test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
fi
printf 'source=%s\n' "${SOURCE_COMMIT:-local-worktree}"
test "$(opencode --version)" = 'opencode v2.0.22'
bun test agent-node/src/runtime/opencode-v2-catalog.test.ts
bun tests/test906-daemon-catalog/native.ts
