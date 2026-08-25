#!/bin/sh
set -eu

cd /workspace
bun test agent-node/src/inbox-reconcile.test.ts agent-node/src/inbox-dispatch.test.ts
cd agent-node
bun run build
