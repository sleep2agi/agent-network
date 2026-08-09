#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test527-ext-validator-dedup.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cd /workspace
echo "# test527 — shared stored extension-token validator"
echo "source_commit=${TEST527_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_tests() {
  bun test \
    server/src/ext-token-shared.test.ts \
    server/src/ext-validation-regression.test.ts \
    server/src/uploads.test.ts
}

echo "L0 structural scope"
test "$(grep -Fc 'const EXT_TOKEN_REGEX =' server/src/uploads.ts)" -eq 1
test "$(grep -Fc 'isValidExtToken(' server/src/uploads.ts)" -eq 4
grep -Fq 'base.match(/\.([A-Za-z0-9]{1,16})$/)' server/src/uploads.ts

echo "L1 three-boundary behavior + existing regressions"
run_tests

echo "L2 production server bundle"
(cd server && bun build src/index.ts --target bun --outfile /tmp/commhub-server-test527.js)
test -s /tmp/commhub-server-test527.js

echo "L3 witnessed-red: widen the single shared grammar"
cp server/src/uploads.ts /tmp/test527-uploads.ts
bun -e '
  const path = "server/src/uploads.ts";
  const source = await Bun.file(path).text();
  const before = "const EXT_TOKEN_REGEX = /^\\.[A-Za-z0-9]{1,16}$/;";
  if (!source.includes(before)) throw new Error("mutation anchor missing");
  await Bun.write(path, source.replace(before, "const EXT_TOKEN_REGEX = /./;"));
'
grep -Fq 'const EXT_TOKEN_REGEX = /./;' server/src/uploads.ts

for pattern in \
  'new-upload path rejects every malformed token' \
  'existing-blob path rejects every malformed token' \
  'stored-index gate rejects every malformed token'
do
  slug=$(printf '%s' "$pattern" | tr ' ' '-')
  set +e
  bun test server/src/ext-token-shared.test.ts -t "$pattern" >"/tmp/test527-$slug.log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $pattern"
    exit 1
  fi
  grep -Fq "$pattern" "/tmp/test527-$slug.log"
  echo "MUTATION_RED: $pattern rc=$rc"
done

cp /tmp/test527-uploads.ts server/src/uploads.ts

echo "L4 restored green"
run_tests

echo "RESULT: PASS"
