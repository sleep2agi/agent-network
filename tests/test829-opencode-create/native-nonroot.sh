#!/usr/bin/env bash
set -euo pipefail
[[ "${SOURCE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]]
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
test "$(id -u)" = 1000
test "$(id -g)" = 1000
test "${TEST829_TMUX_SOCKET:?}" = /home/test829-native/tmux.sock
unset TMUX TMUX_PANE
mkdir -m 700 -p /home/test829-native/home /tmp/tmux-1000
env HOME=/home/test829-native/home tmux -S "$TEST829_TMUX_SOCKET" new-session -d -s test829-socket-anchor 'sleep 300'
trap 'tmux -S "$TEST829_TMUX_SOCKET" kill-session -t =test829-socket-anchor 2>/dev/null || true' EXIT
ln -s "$TEST829_TMUX_SOCKET" /tmp/tmux-1000/default
tmux -S /tmp/tmux-1000/default has-session -t =test829-socket-anchor
exec > >(tee /artifacts/report-test829-native.txt) 2>&1
echo "TEST ONLY source=$SOURCE_COMMIT client=$CLIENT_SOURCE_COMMIT uid=$(id -u) gid=$(id -g)"
timeout 200s bun /workspace/tests/test829-opencode-create/native-harness.ts
