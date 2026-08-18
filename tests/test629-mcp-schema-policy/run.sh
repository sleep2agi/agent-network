#!/usr/bin/env bash
set -euo pipefail

cd /workspace/server
echo "# test629 — MCP unknown-field policy audit"
echo "source_commit=${TEST629_SOURCE_COMMIT}"

cp src/tools.ts /tmp/test629-tools.ts
printf '\nserver.tool(\n  "mutation_unreviewed_tool",\n' >> src/tools.ts
set +e
bun test629/probe.ts >/tmp/test629-inventory-red.log 2>&1
inventory_rc=$?
set -e
cp /tmp/test629-tools.ts src/tools.ts
if [[ "$inventory_rc" -eq 0 ]]; then
  echo "MUTATION_FALSE_GREEN: unreviewed tool escaped the explicit inventory" >&2
  exit 1
fi
grep -Fq "all 46 production MCP registrations are explicitly inventoried" /tmp/test629-inventory-red.log
echo "MUTATION_RED: unreviewed-tool-inventory rc=${inventory_rc}"

# 第二条变异：registerTool 风格。
# 门原来的正则只认 `server.tool(`，所以 update_provider / ack_probe_request 这两个
# 用 server.registerTool( 注册的生产工具**结构上永远看不见** —— 判据没问题，瞎在取集。
# 上面那条变异只能证明 server.tool( 那条路还活着，证明不了这条。
cp src/tools.ts /tmp/test629-tools.ts
printf '\nserver.registerTool(\n  "mutation_registertool_style",\n' >> src/tools.ts
set +e
bun test629/probe.ts >/tmp/test629-registertool-red.log 2>&1
registertool_rc=$?
set -e
cp /tmp/test629-tools.ts src/tools.ts
if [[ "$registertool_rc" -eq 0 ]]; then
  echo "MUTATION_FALSE_GREEN: registerTool-style registration is invisible to the inventory" >&2
  exit 1
fi
echo "MUTATION_RED: registertool-style-inventory rc=${registertool_rc}"

bun test629/probe.ts
echo "RESULT: PASS"
