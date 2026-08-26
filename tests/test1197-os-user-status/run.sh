#!/usr/bin/env bash
set -euo pipefail

test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export COMMHUB_DB="$test_root/commhub.db"
export COMMHUB_DEV_OPEN=0
export COMMHUB_AUTH_TOKEN="test1197-master-token"

echo "L1 platform identity collection and input sanitization"
bun test agent-node/src/os-user.test.ts agent-network/src/os-user.test.ts

echo "L2 report_status schema, legacy compatibility, and hostile input rejection"
bun test server/src/os-user-status.test.ts

echo "L3 authenticated full REST projection and explicit light omission"
bun test server/src/rest-explicit-columns-http.test.ts

echo "L4 package compile gates"
bun build agent-node/src/cli.ts --target=node --outfile="$test_root/agent-node.js" \
  --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty
bun build agent-network/src/node-server.ts --target=node --outfile="$test_root/node-server.js"

echo "L5 witnessed-red: removing control-character rejection must fail"
cp agent-node/src/os-user.ts "$test_root/os-user.ts"
sed -i '/u\.test(normalized)) return null;/d' agent-node/src/os-user.ts
if bun test agent-node/src/os-user.test.ts >"$test_root/witnessed-red.log" 2>&1; then
  echo "witnessed-red mutation unexpectedly survived"
  cat "$test_root/witnessed-red.log"
  exit 1
fi
cp "$test_root/os-user.ts" agent-node/src/os-user.ts
bun test agent-node/src/os-user.test.ts >/dev/null
echo "witnessed-red PASS"

echo "test1197 PASS"
