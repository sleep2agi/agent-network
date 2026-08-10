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

COMMHUB_DB=/tmp/test671-rest.db bun test server/src/task-auth-origin-http.test.ts
ok "REST initial task delivery writes logical inbox task_id"

bun -e '
const files = ["server/src/tools.ts", "server/src/server.ts", "server/src/scheduled-tasks.ts"];
let taskInserts = 0;
for (const file of files) {
  const source = await Bun.file(file).text();
  for (const match of source.matchAll(/INSERT INTO inbox\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g)) {
    if (!match[2].includes("task")) continue;
    taskInserts += 1;
    const columns = match[1].split(",").map((value) => value.trim());
    if (!columns.includes("task_id")) {
      throw new Error(`task inbox INSERT without task_id linkage: ${file}`);
    }
  }
}
if (taskInserts !== 5) throw new Error(`expected 5 production task inbox INSERT paths, found ${taskInserts}`);
'
ok "all production task inbox INSERT paths carry logical task_id"

bun build server/src/index.ts --target bun --outdir /tmp/test671-server-build >/dev/null
ok "production Hub bundle builds"

grep -F 'runtime_submitted_at' docs/rfcs/RFC-035-task-runtime-evidence.md >/dev/null
grep -F 'task_runtime_evidence_backend_unsupported' docs/rfcs/RFC-035-task-runtime-evidence.md >/dev/null
grep -F 'monotonic for the lifetime of the logical task' docs/rfcs/RFC-035-task-runtime-evidence.md >/dev/null
grep -F '不要用 `sessions.task` 判断模型是否已接手' docs-site/docs/concepts/task-lifecycle.md >/dev/null
grep -F '逻辑任务全生命周期的单调证据' docs-site/docs/concepts/task-lifecycle.md >/dev/null
grep -F 'Do not use `sessions.task` as model-consumption evidence' docs-site/docs/en/concepts/task-lifecycle.md >/dev/null
grep -F 'monotonic for the logical task lifetime' docs-site/docs/en/concepts/task-lifecycle.md >/dev/null
ok "RFC and bilingual field-boundary documentation"

cp server/src/tools.ts /tmp/test671-tools.orig

sed -i 's/if (row.to_node_id) return row.to_node_id !== callerSession?.node_id;/if (row.to_node_id) return false;/' server/src/tools.ts
if cmp -s /tmp/test671-tools.orig server/src/tools.ts; then
  bad "remove-node-ownership mutation did not change source"
else
  grep -F 'if (row.to_node_id) return false;' server/src/tools.ts >/dev/null
  expect_red remove-node-ownership env COMMHUB_DB=/tmp/test671-mut-owner.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

sed -i 's/return resolveCanonicalAlias(enforceNetworkId, row.to_name).alias !== canonicalCaller;/return false;/' server/src/tools.ts
if cmp -s /tmp/test671-tools.orig server/src/tools.ts; then
  bad "remove-legacy-alias-ownership mutation did not change source"
else
  expect_red remove-legacy-alias-ownership env COMMHUB_DB=/tmp/test671-mut-alias.db \
    bun test server/src/task-consumption.test.ts
fi
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

sed -i "s/CASE WHEN type = 'task' THEN COALESCE(task_id, id) ELSE task_id END AS task_id/CASE WHEN type = 'task' THEN id ELSE task_id END AS task_id/" server/src/tools.ts
if cmp -s /tmp/test671-tools.orig server/src/tools.ts; then
  bad "unlink-redelivery-task-id mutation did not change source"
else
  grep -F "CASE WHEN type = 'task' THEN id ELSE task_id END AS task_id" server/src/tools.ts >/dev/null
  expect_red unlink-redelivery-task-id env COMMHUB_DB=/tmp/test671-mut-link.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

sed -i "s/AND (id = ?1 OR (type = 'task' AND task_id = ?1))/AND id = ?1/" server/src/tools.ts
if cmp -s /tmp/test671-tools.orig server/src/tools.ts; then
  bad "remove-logical-task-ack mutation did not change source"
else
  grep -F "AND id = ?1" server/src/tools.ts >/dev/null
  expect_red remove-logical-task-ack env COMMHUB_DB=/tmp/test671-mut-logical-ack.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

sed -i "s/status = 'delivered', result = NULL, completed_at = NULL, started_at = NULL, delivered_at/status = 'delivered', result = NULL, completed_at = NULL, started_at = NULL, runtime_submitted_at = NULL, consumed_at = NULL, delivered_at/" server/src/tools.ts
if cmp -s /tmp/test671-tools.orig server/src/tools.ts; then
  bad "clear-task-lifetime-evidence-on-retry mutation did not change source"
else
  grep -F "started_at = NULL, runtime_submitted_at = NULL, consumed_at = NULL, delivered_at" server/src/tools.ts >/dev/null
  expect_red clear-task-lifetime-evidence-on-retry env COMMHUB_DB=/tmp/test671-mut-lifetime.db \
    bun test server/src/task-consumption.test.ts
fi
cp /tmp/test671-tools.orig server/src/tools.ts

cp server/src/scheduled-tasks.ts /tmp/test671-scheduled.orig
if [[ "$(grep -F "VALUES (?1, ?1, ?2, ?3, 'task'" server/src/scheduled-tasks.ts | wc -l)" -ne 1 ]]; then
  bad "scheduler task-id mutation anchor count changed"
else
  sed -i "s/VALUES (?1, ?1, ?2, ?3, 'task'/VALUES (?1, NULL, ?2, ?3, 'task'/" server/src/scheduled-tasks.ts
  if cmp -s /tmp/test671-scheduled.orig server/src/scheduled-tasks.ts; then
    bad "unlink-scheduler-task-id mutation did not change source"
  else
    expect_red unlink-scheduler-task-id env COMMHUB_DB=/tmp/test671-mut-scheduler-link.db \
      bun test server/src/task-consumption.test.ts
  fi
fi
cp /tmp/test671-scheduled.orig server/src/scheduled-tasks.ts

cp server/src/server.ts /tmp/test671-server.orig
if [[ "$(grep -F "VALUES (?1, ?1, ?2, ?3, 'task'" server/src/server.ts | wc -l)" -ne 1 ]]; then
  bad "REST task-id mutation anchor count changed"
else
  sed -i "s/VALUES (?1, ?1, ?2, ?3, 'task'/VALUES (?1, NULL, ?2, ?3, 'task'/" server/src/server.ts
  if cmp -s /tmp/test671-server.orig server/src/server.ts; then
    bad "unlink-rest-task-id mutation did not change source"
  else
    expect_red unlink-rest-task-id env COMMHUB_DB=/tmp/test671-mut-rest-link.db \
      bun test server/src/task-auth-origin-http.test.ts
  fi
fi
cp /tmp/test671-server.orig server/src/server.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
