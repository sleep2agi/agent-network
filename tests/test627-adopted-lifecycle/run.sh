#!/usr/bin/env bash
set -euo pipefail
cd /app/agent-node
bun test src/runtime/adopt-process-tree.test.ts src/runtime/adopt-lifecycle.test.ts src/runtime/adopt-daemon.test.ts src/runtime/start-daemon.test.ts src/runtime/stop-daemon.test.ts
cp src/runtime/adopt-process-tree.ts /tmp/board627-green.ts
trap 'cp /tmp/board627-green.ts /app/agent-node/src/runtime/adopt-process-tree.ts' EXIT
bun -e 'const p="src/runtime/adopt-process-tree.ts"; const s=await Bun.file(p).text(); const n="if (!sameProcess(p, now)) throw Error(\"adopt_process_generation_changed\");"; if(s.split(n).length!==2)throw Error("mutation drift"); await Bun.write(p,s.replace(n,"/* mutation: no identity check before signal */"));'
rc=0
bun test src/runtime/adopt-process-tree.test.ts -t 'PID generation mismatch' >/tmp/board627-red.log 2>&1 || rc=$?
cat /tmp/board627-red.log
test "$rc" -ne 0
grep -q '1 fail' /tmp/board627-red.log
echo "WITNESSED_RED process generation guard removed rc=$rc"
cp /tmp/board627-green.ts src/runtime/adopt-process-tree.ts
bun test src/runtime/adopt-process-tree.test.ts
cd /app/agent-network
bun test src/node-locate.test.ts
bun /app/tests/test627-adopted-lifecycle/e2e.ts
TEST627_TMUX=1 bun /app/tests/test627-adopted-lifecycle/e2e.ts
cp /app/server/src/tools.ts /tmp/board627-tools-green.ts
trap 'cp /tmp/board627-green.ts /app/agent-node/src/runtime/adopt-process-tree.ts; cp /tmp/board627-tools-green.ts /app/server/src/tools.ts' EXIT
bun -e 'const p="/app/server/src/tools.ts"; const s=await Bun.file(p).text(); const n="if (!createdDaemon(nodeId) && activeBinding(nodeId)) {"; if(s.split(n).length!==2)throw Error("restart mutation drift"); await Bun.write(p,s.replace(n,"if (false) {"));'
rc=0
bun /app/tests/test627-adopted-lifecycle/e2e.ts >/tmp/board627-restart-red.log 2>&1 || rc=$?
test "$rc" -ne 0
grep -q 'adopted restart refused without exit-75 supervisor proof' /tmp/board627-restart-red.log
echo "WITNESSED_RED adopted restart refusal removed rc=$rc"
cp /tmp/board627-tools-green.ts /app/server/src/tools.ts
