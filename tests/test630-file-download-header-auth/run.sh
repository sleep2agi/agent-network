#!/usr/bin/env bash
set -euo pipefail

cd /workspace/server
echo "# test630 — file download header-only authentication"
echo "source_commit=${TEST630_SOURCE_COMMIT}"

echo "L0 production file authorization suite"
bun test src/file-download-authz.test.ts

echo "L1 witnessed-red: remove the file endpoint's query-token opt-out"
cp src/server.ts /tmp/test630-server.ts
sed -i '0,/const authErr = requireAuth(req, { allowQueryToken: false });/{s/const authErr = requireAuth(req, { allowQueryToken: false });/const authErr = requireAuth(req);/}' src/server.ts
sed -i '0,/resolvePrincipal(req, { allowQueryToken: false })/{s/resolvePrincipal(req, { allowQueryToken: false })/resolvePrincipal(req)/}' src/server.ts
grep -Fq 'const authErr = requireAuth(req);' src/server.ts
set +e
bun test src/file-download-authz.test.ts >/tmp/test630-red.log 2>&1
mutation_rc=$?
set -e
if [[ "$mutation_rc" -eq 0 ]]; then
  echo "MUTATION_FALSE_GREEN: file query-token authentication was accepted" >&2
  exit 1
fi
grep -Fq 'valid query token is refused on file GET' /tmp/test630-red.log
grep -Fq 'valid query token is refused on file HEAD' /tmp/test630-red.log
echo "MUTATION_RED: file-query-token-opt-out rc=${mutation_rc}"

echo "L2 restored green"
cp /tmp/test630-server.ts src/server.ts
bun test src/file-download-authz.test.ts

echo "RESULT: PASS"
