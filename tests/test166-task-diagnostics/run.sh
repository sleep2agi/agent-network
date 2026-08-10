#!/bin/sh
set -eu

test "${TEST166_SOURCE_COMMIT:-unknown}" != unknown
cd /workspace/server

bun test src/task-diagnostic.test.ts src/task-diagnostic-http.test.ts

cp src/task-diagnostic.ts /tmp/task-diagnostic.orig
node /workspace/tests/test166-task-diagnostics/mutate.mjs src/task-diagnostic.ts
cmp -s src/task-diagnostic.ts /tmp/task-diagnostic.orig && {
  echo "terminal precedence mutation was byte-identical" >&2
  exit 1
}
set +e
bun test src/task-diagnostic.test.ts >/tmp/test166-mutation.log 2>&1
mutation_rc=$?
set -e
cp /tmp/task-diagnostic.orig src/task-diagnostic.ts
test "$mutation_rc" -ne 0
grep -q 'terminal state wins over stale transport and runtime evidence' /tmp/test166-mutation.log
printf 'mutation=remove-terminal-precedence rc=%s witnessed-red\n' "$mutation_rc"

printf 'source_commit=%s\n' "$TEST166_SOURCE_COMMIT"
printf 'RESULT: PASS\n'
