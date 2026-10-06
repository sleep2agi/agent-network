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
# Removing redaction must fail on the public viewer response, not startup.
bun -e 'const p="src/node-lifecycle-read.ts"; const s=await Bun.file(p).text(); const n=s.replaceAll("publicLifecycleError(b.error)","b.error").replaceAll("publicLifecycleError(row.error)","row.error"); if(n===s)throw Error("mutation drift"); await Bun.write(p,n);'
rc=0
run_http >/tmp/test629-error-red.log 2>&1 || rc=$?
test "$rc" -ne 0
grep -q '(fail) public errors redact free text' /tmp/test629-error-red.log
echo "WITNESSED_RED public error redaction removed rc=$rc"
cp /tmp/lifecycle-read-green.ts src/node-lifecycle-read.ts
# Reverting to the historical naming-only join must lose the actual child.
bun -e 'const p="src/node-lifecycle-read.ts"; const s=await Bun.file(p).text(); const n=s.replace("COALESCE(c.child_node_id, CASE", "COALESCE(NULL, CASE"); if(n===s)throw Error("mutation drift"); await Bun.write(p,n);'
rc=0
run_http >/tmp/test629-child-red.log 2>&1 || rc=$?
test "$rc" -ne 0
grep -q '(fail) created projection prefers recorded child id' /tmp/test629-child-red.log
echo "WITNESSED_RED recorded child ignored rc=$rc"
cp /tmp/lifecycle-read-green.ts src/node-lifecycle-read.ts
run_http
echo "RESULT: PASS test629 user lifecycle read HTTP"
