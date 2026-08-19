#!/bin/sh

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：scripts/qa.sh 缺 ARG 时
# **不传且不报错**，断言写在这里才会让缺失显形。

# 🔴 本文件是 #!/bin/sh —— 没有 [[ ]] / =~（bash 专有）。
# 我第一版照抄了 tests/test746 的 bash 写法，结果 `[[: not found` 把套件直接打红。
# 这里用 POSIX 写法表达同一条断言：40 位、且只含小写十六进制。
_sc="${TEST583_SOURCE_COMMIT:-}"
if [ ${#_sc} -ne 40 ]; then _bad=1; else case "$_sc" in *[!0-9a-f]*) _bad=1 ;; *) _bad=0 ;; esac; fi
if [ "$_bad" -ne 0 ]; then
  echo 'FAIL: TEST583_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
fi
printf 'source_commit=%s\n' "$_sc"

set -eu

export COMMHUB_DB=/tmp/test583-chat-idempotency.db
rm -f "$COMMHUB_DB" "$COMMHUB_DB-wal" "$COMMHUB_DB-shm"
bun test src/task-idempotency.test.ts src/task-idempotency-mcp.test.ts
