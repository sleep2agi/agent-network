#!/usr/bin/env bash
set -Eeuo pipefail
bun test src/runtime/opencode-acp/copresence-auth.test.ts \
  src/runtime/opencode-acp/child-env.test.ts src/runtime/opencode-v1-spawn-snapshot.test.ts
# TEST-ONLY: require the user-visible restart assertion to fail if production
# co-presence forgets to enable persistence. This mutation stays in the container.
bun -e 'const p="src/runtime/opencode-copresence/runtime.ts"; const f=Bun.file(p); const s=await f.text(); const a="persistAuth: backend.generation === \"v1\","; if(s.split(a).length!==2) throw Error("wiring mutation anchor is not unique"); await Bun.write(p,s.replace(a,"persistAuth: false,"));'
if bun test src/runtime/opencode-v1-spawn-snapshot.test.ts \
  --test-name-pattern 'production co-presence entry saves' > /tmp/auth1120-witness.log 2>&1; then
  echo 'production wiring witness unexpectedly passed' >&2
  exit 1
fi
bun -e 'const s=await Bun.file("/tmp/auth1120-witness.log").text(); if(!s.includes("Expected: true")||!s.includes("(fail)")) throw Error("witness did not reach the login-persistence assertion"); console.log("production wiring witness: ASSERTION RED");'
