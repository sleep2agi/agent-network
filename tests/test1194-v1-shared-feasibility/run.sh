#!/usr/bin/env bash
set -Eeuo pipefail
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$(id -u)" != 0
test "$(opencode --version)" = "$OPENCODE_VERSION_UNDER_TEST"
export TEST1194_ROOT
TEST1194_ROOT="$(mktemp -d /tmp/test1194-shared.XXXXXXXX)"
echo "TEST-ONLY source=$SOURCE_COMMIT native=$OPENCODE_VERSION_UNDER_TEST"
timeout 180s env -u TMUX -u TMUX_PANE bun /fixture/probe.ts
