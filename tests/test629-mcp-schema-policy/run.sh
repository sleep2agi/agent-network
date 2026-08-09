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
grep -Fq "all 41 production MCP registrations are explicitly inventoried" /tmp/test629-inventory-red.log
echo "MUTATION_RED: unreviewed-tool-inventory rc=${inventory_rc}"

bun test629/probe.ts
echo "RESULT: PASS"
