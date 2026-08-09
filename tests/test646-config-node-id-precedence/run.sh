#!/usr/bin/env bash
set -euo pipefail

cd /workspace
echo "source_commit=$TEST646_SOURCE_COMMIT"

echo "L0: config/env identity resolver"
bun test agent-node/src/runtime/node-id-source.test.ts

echo "L1: production CLI integration"
bun build --target bun --packages external agent-node/src/cli.ts --outfile /tmp/test646-agent-node.js
test -s /tmp/test646-agent-node.js
grep -Fq 'resolveNodeIdSource({' agent-node/src/cli.ts
grep -Fq 'configNodeId: fileConfig.node_id' agent-node/src/cli.ts
grep -Fq 'envNodeId: process.env.COMMHUB_NODE_ID' agent-node/src/cli.ts

# The standard anet launcher already owns the child env boundary. #532 must
# not weaken or duplicate those two existing branches.
test "$(grep -c 'if (!profile.node_id) delete (env as Record<string, unknown>).COMMHUB_NODE_ID' agent-network/bin/cli.ts)" -eq 2
test "$(grep -c '...(profile.node_id ? { COMMHUB_NODE_ID: profile.node_id } : {})' agent-network/bin/cli.ts)" -eq 2

echo "L2: witnessed-red env-first mutation"
cp agent-node/src/runtime/node-id-source.ts /tmp/test646-node-id-source.ts
sed -i '/  if (configNodeId) {/i\  if (envNodeId) return { value: envNodeId, source: "env" };\n' \
  agent-node/src/runtime/node-id-source.ts
grep -Fq 'if (envNodeId) return { value: envNodeId, source: "env" };' \
  agent-node/src/runtime/node-id-source.ts

set +e
bun test agent-node/src/runtime/node-id-source.test.ts >/tmp/test646-mutation.log 2>&1
mutation_rc=$?
set -e
cp /tmp/test646-node-id-source.ts agent-node/src/runtime/node-id-source.ts

test "$mutation_rc" -ne 0
grep -Fq 'ENV_POLLUTION_RESOLVED_WRONG_ALIAS' /tmp/test646-mutation.log
echo "MUTATION_RED: env-first-precedence rc=$mutation_rc"

echo "RESULT: PASS"
