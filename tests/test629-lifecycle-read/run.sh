#!/usr/bin/env bash
set -euo pipefail
cd /app/server
run_http() { env HOME="$(mktemp -d)" bun test src/node-lifecycle-read-http.test.ts; }
run_http
cp src/node-lifecycle-read.ts /tmp/lifecycle-read-green.ts
trap 'cp /tmp/lifecycle-read-green.ts /app/server/src/node-lifecycle-read.ts' EXIT
# Removing the shared read-scope call must break both network and node-grant
# isolation over real HTTP; parsing/startup failure does not count as evidence.
bun -e 'const p="src/node-lifecycle-read.ts"; const s=await Bun.file(p).text(); const n="addAgentNetworkScope(sql, params, scope, { network: \"n.network_id\", nodeId: \"n.node_id\", alias: \"n.alias\" })"; if(s.split(n).length!==2)throw Error("mutation drift"); await Bun.write(p,s.replace(n,"sql"));'
rc=0
run_http >/tmp/test629-red.log 2>&1 || rc=$?
test "$rc" -ne 0
grep -q '(fail) cross-network request and node guesses' /tmp/test629-red.log
grep -q '(fail) same-network restricted viewer' /tmp/test629-red.log
echo "WITNESSED_RED lifecycle read scope removed rc=$rc"
cp /tmp/lifecycle-read-green.ts src/node-lifecycle-read.ts
run_http
echo "RESULT: PASS test629 user lifecycle read HTTP"
