#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then
    bad "mutation $name stayed green"
  else
    ok "mutation $name witnessed red"
  fi
}

printf 'source_commit=%s\n' "${TEST671_SOURCE_COMMIT:-unknown}"
if [[ ! "${TEST671_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  bad "source commit is not an exact SHA"
  printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
  exit 1
fi

cd "$ROOT"
COMMHUB_DB=/tmp/test671-hub.db bun test server/src/task-consumption.test.ts
ok "two-level task runtime evidence contract"

bun build server/src/index.ts --target bun --outdir /tmp/test671-server-build >/dev/null
ok "production Hub bundle builds"

grep -F 'runtime_submitted_at' docs/rfcs/RFC-035-task-runtime-evidence.md >/dev/null
grep -F 'task_runtime_evidence_backend_unsupported' docs/rfcs/RFC-035-task-runtime-evidence.md >/dev/null
grep -F '不要用 `sessions.task` 判断模型是否已接手' docs-site/docs/concepts/task-lifecycle.md >/dev/null
grep -F 'Do not use `sessions.task` as model-consumption evidence' docs-site/docs/en/concepts/task-lifecycle.md >/dev/null
ok "RFC and bilingual field-boundary documentation"

cp server/src/tools.ts /tmp/test671-tools.orig

sed -i 's/(taskId) => owned.get(taskId) !== callerSession.node_id/(taskId) => false/' server/src/tools.ts
grep -F '(taskId) => false' server/src/tools.ts >/dev/null
expect_red remove-node-ownership env COMMHUB_DB=/tmp/test671-mut-owner.db \
  bun test server/src/task-consumption.test.ts
cp /tmp/test671-tools.orig server/src/tools.ts

sed -i "s/UPDATE tasks SET runtime_submitted_at = COALESCE(runtime_submitted_at, datetime('now'))/UPDATE tasks SET runtime_submitted_at = COALESCE(runtime_submitted_at, datetime('now')), consumed_at = COALESCE(consumed_at, datetime('now'))/" server/src/tools.ts
grep -F "consumed_at = COALESCE(consumed_at, datetime('now'))" server/src/tools.ts >/dev/null
expect_red collapse-submitted-into-consumed env COMMHUB_DB=/tmp/test671-mut-collapse.db \
  bun test server/src/task-consumption.test.ts
cp /tmp/test671-tools.orig server/src/tools.ts

sed -i '/runtime_submitted_at = COALESCE(runtime_submitted_at, datetime('\''now'\'')),/d' server/src/tools.ts
expect_red consumed-no-longer-implies-submitted env COMMHUB_DB=/tmp/test671-mut-implies.db \
  bun test server/src/task-consumption.test.ts
cp /tmp/test671-tools.orig server/src/tools.ts

if [[ "$(grep -o 'runtime_submitted_at = NULL' server/src/tools.ts | wc -l)" -ne 2 ]]; then
  bad "runtime-submitted reset anchor count changed"
else
  sed -i 's/runtime_submitted_at = NULL, //g' server/src/tools.ts
  expect_red remove-submission-attempt-reset env COMMHUB_DB=/tmp/test671-mut-submit-reset.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

if [[ "$(grep -o 'consumed_at = NULL' server/src/tools.ts | wc -l)" -ne 2 ]]; then
  bad "consumed reset anchor count changed"
else
  sed -i 's/consumed_at = NULL, //g' server/src/tools.ts
  expect_red remove-consumed-attempt-reset env COMMHUB_DB=/tmp/test671-mut-consumed-reset.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
