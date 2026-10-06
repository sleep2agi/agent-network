#!/usr/bin/env bash
set -euo pipefail
cd /work
bun test ./src/runtime/adopt-local-identity.test.ts
cp src/runtime/adopt-local-identity.ts /tmp/adopt-local-green.ts
trap 'cp /tmp/adopt-local-green.ts src/runtime/adopt-local-identity.ts' EXIT
bun -e 'const p="src/runtime/adopt-local-identity.ts"; const s=await Bun.file(p).text(); const needle="if (!opts.adoptRoots.some(root => isAbsolute(root) && under(workdir, realpathSync(root))))"; if (s.split(needle).length!==2) throw Error("mutation target drift"); await Bun.write(p,s.replace(needle,"if (false)"));'
rc=0
bun test ./src/runtime/adopt-local-identity.test.ts -t 'allowlist escape and marker-carrying daemon refuse' >/tmp/adopt-red.log 2>&1 || rc=$?
cat /tmp/adopt-red.log
test "$rc" -ne 0
grep -q '1 fail' /tmp/adopt-red.log
grep -q 'toThrow' /tmp/adopt-red.log
echo "WITNESSED_RED allowlist bypass rejected by same assertion rc=$rc"
