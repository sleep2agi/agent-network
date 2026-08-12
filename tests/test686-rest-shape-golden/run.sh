#!/bin/sh
set -eu

test "${TEST686_SOURCE_COMMIT:-unknown}" != unknown
cd /workspace

echo "L0: independent golden remains green"
bun test server/src/rest-explicit-columns-http.test.ts

cp server/src/rest-projections.ts /tmp/rest-projections.orig
bun tests/test686-rest-shape-golden/mutate.mjs server/src/rest-projections.ts
cmp -s server/src/rest-projections.ts /tmp/rest-projections.orig && {
  echo "projection mutation was byte-identical" >&2
  exit 1
}

echo "L1: removing a previously public task key must turn red"
set +e
bun test server/src/rest-explicit-columns-http.test.ts >/tmp/test686-mutation.log 2>&1
mutation_rc=$?
set -e
cp /tmp/rest-projections.orig server/src/rest-projections.ts
test "$mutation_rc" -ne 0
grep -Fq 'task list and task detail expose the same explicit contract' /tmp/test686-mutation.log
grep -Fq 'created_at' /tmp/test686-mutation.log
printf 'mutation=drop-task-created-at rc=%s witnessed-red\n' "$mutation_rc"

echo "L2: restored production projection remains green"
bun test server/src/rest-explicit-columns-http.test.ts

printf 'source_commit=%s\n' "$TEST686_SOURCE_COMMIT"
printf 'RESULT: PASS\n'
