#!/usr/bin/env bash
# Exploratory only: run inside test827 native image AFTER integrated source copy.
# Does not claim an immutable-source image or formal release gate.
set -euo pipefail
[[ "${OVERLAY_SOURCE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]]
test "$OVERLAY_SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
unset TMUX TMUX_PANE
mkdir -p /artifacts /tmp/tmux-0
chmod 700 /tmp/tmux-0
ln -s /run/test827-tmux.sock /tmp/tmux-0/default
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
