#!/usr/bin/env bash
set -euo pipefail
cd /work
bun test ./src/runtime/adopt-local-identity.test.ts
bun test ./src/runtime/adopt-daemon.test.ts
bun test ./cli-src/daemon-adopt.test.ts
cp src/runtime/adopt-local-identity.ts /tmp/adopt-local-green.ts
cp src/runtime/adopt-daemon.ts /tmp/adopt-daemon-green.ts
trap 'cp /tmp/adopt-local-green.ts src/runtime/adopt-local-identity.ts; cp /tmp/adopt-daemon-green.ts src/runtime/adopt-daemon.ts' EXIT
bun -e 'const p="src/runtime/adopt-local-identity.ts"; const s=await Bun.file(p).text(); const needle="if (!opts.adoptRoots.some(root => isAbsolute(root) && under(workdir, realpathSync(root))))"; if (s.split(needle).length!==2) throw Error("mutation target drift"); await Bun.write(p,s.replace(needle,"if (false)"));'
rc=0
bun test ./src/runtime/adopt-local-identity.test.ts -t 'allowlist escape and marker-carrying daemon refuse' >/tmp/adopt-red.log 2>&1 || rc=$?
cat /tmp/adopt-red.log
test "$rc" -ne 0
grep -q '1 fail' /tmp/adopt-red.log
grep -q 'toThrow' /tmp/adopt-red.log
echo "WITNESSED_RED allowlist bypass rejected by same assertion rc=$rc"
cp /tmp/adopt-local-green.ts src/runtime/adopt-local-identity.ts
# Remove only the catch rollback; retain the thrown error and return-value path.
bun -e 'const p="src/runtime/adopt-daemon.ts"; const s=await Bun.file(p).text(); const needle="if (error instanceof CommHubError && error.appLevel) forgetAdoptedChild(deps.workDir, alias, requestId);"; if(s.split(needle).length!==2) throw Error("ack rollback mutation target drift"); await Bun.write(p,s.replace(needle,"/* mutation: missing app-level rollback */"));'
rc=0
bun test ./src/runtime/adopt-daemon.test.ts -t 'revocation before registration then real app-level ack rejection rolls back' >/tmp/adopt-ack-red.log 2>&1 || rc=$?
cat /tmp/adopt-ack-red.log
test "$rc" -ne 0
grep -q '1 fail' /tmp/adopt-ack-red.log
grep -q 'toBeNull' /tmp/adopt-ack-red.log
echo "WITNESSED_RED missing catch rollback leaves stale registry rc=$rc"
cp /tmp/adopt-daemon-green.ts src/runtime/adopt-daemon.ts
bun test ./src/runtime/adopt-daemon.test.ts
