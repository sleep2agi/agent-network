#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
PASS=0
FAIL=0
ART=/artifacts
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

printf 'source_commit=%s\n' "${TEST336_SOURCE_COMMIT:-unknown}"
cd "$ROOT"

bun agent-network/tests/feishu-bridge-ipc.test.ts
ok "real createIPCEventHandler envelope + reply dispatch"
bun agent-network/tests/feishu-bridge-ackplaceholder.test.ts
ok "existing Feishu bridge acknowledgement regression"
bun test agent-node/src/runtime/feishu-outbound-dir.test.ts
ok "legacy binding contract"
(
  cd agent-node
  bun run build
)
ok "agent-node production bundle"

cp agent-network/src/im/feishu/bridge.ts /tmp/test336-bridge.orig

perl -0pi -e 's/(const outboundDir = feishuOutboundDir\(\n\s*adapter\.connectionName \|\| "feishu",\n\s*)event\.conversation\.conversationId,/${1}event.sender.id,/' \
  agent-network/src/im/feishu/bridge.ts
grep -Fq 'const outboundDir = feishuOutboundDir(' agent-network/src/im/feishu/bridge.ts
expect_red envelope-uses-sender-id bun agent-network/tests/feishu-bridge-ipc.test.ts
cp /tmp/test336-bridge.orig agent-network/src/im/feishu/bridge.ts

perl -0pi -e 's/(const expectedDir = feishuOutboundDir\(\n\s*connectionName,\n\s*)event\.conversation\.conversationId,/${1}event.sender.id,/' \
  agent-network/src/im/feishu/bridge.ts
grep -Fq 'const expectedDir = feishuOutboundDir(' agent-network/src/im/feishu/bridge.ts
expect_red reply-whitelist-uses-sender-id bun agent-network/tests/feishu-bridge-ipc.test.ts
cp /tmp/test336-bridge.orig agent-network/src/im/feishu/bridge.ts

cp agent-node/src/runtime/feishu-outbound-dir.ts /tmp/test336-outbound.orig
sed -i 's/const connection = connectionName || "feishu";/const connection = process.env.ANET_NODE_ALIAS || connectionName || "feishu";/' \
  agent-node/src/runtime/feishu-outbound-dir.ts
grep -Fq 'process.env.ANET_NODE_ALIAS || connectionName' agent-node/src/runtime/feishu-outbound-dir.ts
expect_red ambient-alias-overrides-binding bun test agent-node/src/runtime/feishu-outbound-dir.test.ts
cp /tmp/test336-outbound.orig agent-node/src/runtime/feishu-outbound-dir.ts

sed -i 's/binding.connectionName,/"wrong-node-alias",/' agent-node/src/runtime/feishu-outbound-dir.ts
grep -Fq '"wrong-node-alias",' agent-node/src/runtime/feishu-outbound-dir.ts
expect_red worker-binding-diverges bun test agent-node/src/runtime/feishu-outbound-dir.test.ts
cp /tmp/test336-outbound.orig agent-node/src/runtime/feishu-outbound-dir.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
