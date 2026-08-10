#!/bin/sh
set -eu

ZH=docs-site/docs/api/mcp-tools.md
EN=docs-site/docs/en/api/mcp-tools.md
TOOLS=server/src/tools.ts
pass=0

require() {
  pattern=$1
  file=$2
  label=$3
  if ! grep -Fq "$pattern" "$file"; then
    echo "FAIL: $label" >&2
    exit 1
  fi
  pass=$((pass + 1))
}

reject() {
  pattern=$1
  file=$2
  label=$3
  if grep -Fqi "$pattern" "$file"; then
    echo "FAIL: $label" >&2
    exit 1
  fi
  pass=$((pass + 1))
}

echo "source_commit=$TEST520_DOCS_SOURCE_COMMIT"

# Production wire: get_inbox exposes logical identity, ack accepts both
# transport-row and logical-task capabilities, then updates the resolved row.
require "CASE WHEN type = 'task' THEN COALESCE(task_id, id) ELSE task_id END AS task_id" "$TOOLS" "get_inbox exposes task_id"
require "AND (id = ?1 OR (type = 'task' AND task_id = ?1))" "$TOOLS" "ack resolves transport or logical id"
require "UPDATE inbox SET acked = 1 WHERE id = ?1" "$TOOLS" "ack updates the resolved inbox row"
require "UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status = 'delivered'" "$TOOLS" "ack advances the resolved logical task"

# Chinese and English docs must teach the same dual-capability contract.
require '"task_id": "task-uuid-xxx"' "$ZH" "Chinese get_inbox example contains task_id"
require '"task_id": "task-uuid-xxx"' "$EN" "English get_inbox example contains task_id"
require '跨重试/转派保持不变的逻辑任务 ID' "$ZH" "Chinese stable task identity explained"
require 'stable logical task identity across retry and reassignment' "$EN" "English stable task identity explained"
require '旧消费者继续传 inbox `id` 也兼容' "$ZH" "Chinese legacy id compatibility explained"
require 'legacy callers that pass an inbox `id` remain compatible' "$EN" "English legacy id compatibility explained"
reject 'where `task_id = message_id`' "$EN" "English old direct-equality claim removed"
reject 'ack 成功还会把 `tasks` 表里 `task_id = message_id`' "$ZH" "Chinese old direct-equality claim removed"

npm run build --prefix docs-site >/tmp/test520-docs-build.log
test -s docs-site/docs/.vitepress/dist/api/mcp-tools.html
test -s docs-site/docs/.vitepress/dist/en/api/mcp-tools.html
pass=$((pass + 1))

echo "RESULT: PASS ($pass checks)"
