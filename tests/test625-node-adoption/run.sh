#!/usr/bin/env bash
set -euo pipefail
cd /work/server
bun test src/node-daemon-bindings.test.ts src/node-lifecycle-controllable.test.ts src/start-node.test.ts
# Revert just the #625 authority gate inside this disposable container.
# The same behavioral assertion must become red, not an import/build error.
cp src/tools.ts /tmp/adoption-tools.green
trap 'cp /tmp/adoption-tools.green src/tools.ts' EXIT
bun -e 'const p="src/tools.ts"; const s=await Bun.file(p).text(); const from="if (!authoritativeDaemonId) {"; if(s.split(from).length!==2) throw Error("mutation target drift"); await Bun.write(p,s.replace(from,"if (!authoritativeDaemonId && !args.child_node_id.startsWith(\"node_\")) {"));'
rc=0
bun test src/node-daemon-bindings.test.ts -t 'unbound node_' >/tmp/adoption-red.log 2>&1 || rc=$?
cat /tmp/adoption-red.log
test "$rc" -ne 0
grep -q '1 fail' /tmp/adoption-red.log
grep -q 'toMatchObject' /tmp/adoption-red.log
echo "WITNESSED_RED: authority gate reverted, same unbound node_ assertion fails rc=$rc"
