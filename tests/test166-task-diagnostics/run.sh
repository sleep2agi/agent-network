#!/bin/sh
set -eu

test "${TEST166_SOURCE_COMMIT:-unknown}" != unknown
cd /workspace/server

bun test src/task-diagnostic.test.ts src/task-diagnostic-http.test.ts

cp src/task-diagnostic.ts /tmp/task-diagnostic.orig
cp src/server.ts /tmp/server.orig

run_mutation() {
  mode="$1"
  target="$2"
  test_file="$3"
  expected="$4"
  original="$5"
  log="/tmp/test166-${mode}.log"

  node /workspace/tests/test166-task-diagnostics/mutate.mjs "$mode" "$target"
  cmp -s "$target" "$original" && {
    echo "$mode mutation was byte-identical" >&2
    exit 1
  }
  set +e
  bun test "$test_file" >"$log" 2>&1
  mutation_rc=$?
  set -e
  cp "$original" "$target"
  test "$mutation_rc" -ne 0
  grep -q "$expected" "$log"
  printf 'mutation=%s rc=%s witnessed-red\n' "$mode" "$mutation_rc"
}

run_mutation terminal-precedence src/task-diagnostic.ts src/task-diagnostic.test.ts \
  'terminal state wins over stale transport and runtime evidence' /tmp/task-diagnostic.orig
run_mutation runtime-consumed-precedence src/task-diagnostic.ts src/task-diagnostic.test.ts \
  'runtime evidence outranks current target connectivity' /tmp/task-diagnostic.orig
run_mutation no-sse-gate src/task-diagnostic.ts src/task-diagnostic.test.ts \
  'distinguishes missing, offline, and no-SSE targets' /tmp/task-diagnostic.orig
run_mutation cross-network-sse src/server.ts src/task-diagnostic-http.test.ts \
  "does not count another network's same-alias SSE connection" /tmp/server.orig

grep -q 'MCP-first' /workspace/docs-site/docs/en/api/rest.md
grep -q 'MCP 优先' /workspace/docs-site/docs/api/rest.md
grep -q 'does not prove whether MCP tools are mounted' /workspace/docs-site/docs/en/api/rest.md
grep -q '不能证明外部模型会话是否挂载了 MCP tools' /workspace/docs-site/docs/api/rest.md

printf 'source_commit=%s\n' "$TEST166_SOURCE_COMMIT"
printf 'RESULT: PASS\n'
