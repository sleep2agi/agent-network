#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${ARTIFACT_DIR:=/tmp/art}"
exec > >(tee "$ARTIFACT_DIR/report-test829.txt") 2>&1
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
export COMMHUB_DB=/tmp/test829-hub.db
node --version
bun --version
test "$(opencode --version)" = 'opencode v2.0.22'
cd /workspace
bun test tests/test829-opencode-create/contract.test.ts
cd server
bun test src/create-node-tool-schema.test.ts src/create-node-validate.test.ts
bun test src/create-node-workdir.test.ts
cd /opt/node_modules/@sleep2agi/agent-node
bun test src/runtime/create-node-daemon.test.ts src/runtime/create-node-daemon-private-wiring.test.ts
bun test src/runtime/node-name-652.test.ts
echo 'PASS test829 contract/persistence slice; real runtime startup and client UI NOT covered'
