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

# 🔴 变异必须真的注入,否则 expect_red 拿的是一份没被改过的源码,恒绿。
#
# 原来的守卫是 `grep -Fq '<锚点>' <file>` —— 它只证明锚点还在,
# **不证明替换生效**。2026-08-27 #1252 就栽在这:那条 PR 把
#   const connectionName = adapter.connectionName || "feishu";
#   ... feishuOutboundDir(connectionName, ...)
# 内联成
#   ... feishuOutboundDir(adapter.connectionName || "feishu", ...)
# 语义完全没变,但 perl 模式字面要求 `connectionName,` 那一行,于是不匹配 =
# no-op。锚点当然还在,grep 照过,然后 expect_red 跑未变异的代码 → 恒绿 →
# 报成 "mutation stayed green",读起来像"这条规则没人守了",
# 而真相是"这个变异从来没被注入过"。这两种结论指向完全相反的修法。
#
# 改成比对文件内容:变异前后必须不同。
mutate(){
  local name="$1" file="$2"; shift 2
  local before after
  before="$(sha256sum "$file" | cut -d" " -f1)"
  "$@"
  after="$(sha256sum "$file" | cut -d" " -f1)"
  if [[ "$before" == "$after" ]]; then
    bad "mutation $name NO-OP —— 模式没匹配到任何东西,变异从未注入($file 未改变)"
    return 1
  fi
  return 0
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

mutate envelope-uses-sender-id agent-network/src/im/feishu/bridge.ts \
  perl -0pi -e 's/(const outboundDir = feishuOutboundDir\(\n\s*(?:adapter\.connectionName \|\| "feishu"|connectionName),\n\s*)event\.conversation\.conversationId,/${1}event.sender.id,/' \
  agent-network/src/im/feishu/bridge.ts \
  && expect_red envelope-uses-sender-id bun agent-network/tests/feishu-bridge-ipc.test.ts
cp /tmp/test336-bridge.orig agent-network/src/im/feishu/bridge.ts

# 模式同时容忍两种形状:main 上的局部变量 `connectionName,` 和
# #1252 内联后的 `adapter.connectionName || "feishu",`。语义一致,
# 变异要的是把 conversationId 换成 sender.id,和这个参数怎么写无关。
mutate reply-whitelist-uses-sender-id agent-network/src/im/feishu/bridge.ts \
  perl -0pi -e 's/(const expectedDir = feishuOutboundDir\(\n\s*(?:adapter\.connectionName \|\| "feishu"|connectionName),\n\s*)event\.conversation\.conversationId,/${1}event.sender.id,/' \
  agent-network/src/im/feishu/bridge.ts \
  && expect_red reply-whitelist-uses-sender-id bun agent-network/tests/feishu-bridge-ipc.test.ts
cp /tmp/test336-bridge.orig agent-network/src/im/feishu/bridge.ts

cp agent-node/src/runtime/feishu-outbound-dir.ts /tmp/test336-outbound.orig
mutate ambient-alias-overrides-binding agent-node/src/runtime/feishu-outbound-dir.ts \
  sed -i 's/const connection = connectionName || "feishu";/const connection = process.env.ANET_NODE_ALIAS || connectionName || "feishu";/' \
  agent-node/src/runtime/feishu-outbound-dir.ts \
  && expect_red ambient-alias-overrides-binding bun test agent-node/src/runtime/feishu-outbound-dir.test.ts
cp /tmp/test336-outbound.orig agent-node/src/runtime/feishu-outbound-dir.ts

mutate worker-binding-diverges agent-node/src/runtime/feishu-outbound-dir.ts \
  sed -i 's/binding.connectionName,/"wrong-node-alias",/' agent-node/src/runtime/feishu-outbound-dir.ts \
  && expect_red worker-binding-diverges bun test agent-node/src/runtime/feishu-outbound-dir.test.ts
cp /tmp/test336-outbound.orig agent-node/src/runtime/feishu-outbound-dir.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
