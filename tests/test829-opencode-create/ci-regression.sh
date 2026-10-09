#!/usr/bin/env bash
set -euo pipefail
mkdir -p /tmp/test829-ci-art
exec > >(tee /tmp/test829-ci-art/report.txt) 2>&1
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
test "$(id -u)" != 0
if command -v opencode; then echo 'FAIL: unexpected vendor binary'; exit 1; fi
echo "source=$SOURCE_COMMIT uid=$(id -u); no vendor OpenCode on PATH"
export HOME=/tmp/test829-ci-home
mkdir -m 700 "$HOME"
cd /opt/node_modules/@sleep2agi/agent-node
bun test src/runtime/opencode-create-profile.test.ts src/runtime/node-name-652.test.ts
bun test src/runtime/opencode-copresence/launcher-health.test.ts src/runtime/opencode-copresence/v2-session.test.ts
cd /workspace
bun test agent-network/src/opencode-create-security-parity.test.ts
bun test agent-network/src/opencode-start-mode.test.ts agent-network/src/opencode-copresence-cli.test.ts
export COMMHUB_DB=/tmp/test829-ci-audience.db
bun test server/src/tool-audience-http.test.ts
export COMMHUB_DB=/tmp/test829-ci-schema.db
bun test server/src/create-node-tool-schema.test.ts server/src/create-node-validate.test.ts
echo 'PASS: targeted CI regressions; not real OpenCode startup or full unit domains'
