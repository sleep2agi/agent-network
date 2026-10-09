#!/usr/bin/env bash
# Exploratory only: run inside test827 native image AFTER integrated source copy.
# Does not claim an immutable-source image or formal release gate.
set -euo pipefail
[[ "${OVERLAY_SOURCE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]]
test "$OVERLAY_SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
unset TMUX TMUX_PANE
mkdir -p /artifacts /tmp/tmux-0
chmod 700 /tmp/tmux-0
# daemon intentionally drops ANET_TMUX_SOCKET. Start the private server before
# adding its default-path alias: tmux otherwise replaces a dangling symlink
# with a different socket, and the assertion watches the wrong server.
env HOME=/home/test829-native/home tmux -S /run/test827-tmux.sock new-session -d -s test829-socket-anchor 'sleep 300'
trap 'tmux -S /run/test827-tmux.sock kill-session -t =test829-socket-anchor 2>/dev/null || true' EXIT
ln -s /run/test827-tmux.sock /tmp/tmux-0/default
tmux -S /tmp/tmux-0/default has-session -t =test829-socket-anchor
ln -s /opt/node_modules/@sleep2agi/agent-node/dist/cli.js /usr/local/bin/agent-node
exec > >(tee /artifacts/report-test829-native.txt) 2>&1
echo "EXPLORATORY source overlay: ${OVERLAY_SOURCE_COMMIT:?}; base source: ${SOURCE_COMMIT:?}"
cd /opt/node_modules/@sleep2agi/agent-node
npm run build
chmod 755 dist/cli.js
cd /workspace/agent-network
bun build bin/cli.ts --outdir dist/bin --target node --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'
cp bin/anet.cjs dist/bin/anet.cjs
chmod 755 dist/bin/anet.cjs
timeout 200s bun /workspace/tests/test829-opencode-create/native-harness.ts
