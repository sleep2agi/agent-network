#!/usr/bin/env bash
# test638 的 syscall 侧（从 test638-server-aggregate-isolation 拆出来的那一半）。
#
# 为什么要拆：那份套件实测 10.0 分钟里，**L1（strace 下跑一遍完整聚合）占 5.7 分钟**，
# 而 L2（并发跑两遍）只要 3.8 分钟 —— 墙钟被 strace 那一步钉死。
# 拆出来之后两边并行：这一条约 6 分钟，另一条约 4.5 分钟，矩阵里最长的单元从 10 上升到约 6 分钟。
#
# 这个文件只保留**必须看 syscall 才能证明**的两条断言：
#   · 继承下来的 $SHARED_DB 一次都没被 openat（否则说明隔离失效）
#   · 没有任何 DB 被开在 per-file root 之外（$RUN1/ 之外的 commhub.db）
# 其余断言（三次聚合计数一致、钉死的通过数、L4/L5/L5b/L6 的变异见证红）留在原套件里，
# 一条都没有删 —— 包括 L6 需要的 upload_db/host_db，那两个值来自 OUT1 的 TEST_DB_MAP 行，
# 不依赖 strace。
set -euo pipefail

EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:-}"
if [[ -z "${TEST639_SOURCE_COMMIT:-}" || -z "$EXPECTED_SOURCE_COMMIT" || "$TEST639_SOURCE_COMMIT" != "$EXPECTED_SOURCE_COMMIT" ]]; then
  echo "FAIL: source provenance mismatch image=${TEST639_SOURCE_COMMIT:-unset} expected=${EXPECTED_SOURCE_COMMIT}"
  exit 1
fi

cd /work
SHARED_DB=/tmp/test638-shared-must-not-open.db
RUN1=/tmp/test638b-run1
TRACE1=/tmp/test638b-run1.openat
OUT1=/tmp/test638b-run1.out
STAGE=bootstrap

save_failure_artifacts() {
  local rc="$1"
  set +e
  if [ -n "${ARTIFACT_DIR:-}" ]; then
    mkdir -p "$ARTIFACT_DIR" 2>/dev/null || true
    echo "stage=$STAGE rc=$rc" > "$ARTIFACT_DIR/fail-context.txt" 2>/dev/null
    for f in "$OUT1" "$TRACE1"; do
      [ -f "$f" ] && cp -- "$f" "$ARTIFACT_DIR/$(basename "$f")" 2>/dev/null
    done
  fi
  for g in "$OUT1"; do
    [ -f "$g" ] && { echo "--- tail -40 of $g (stage=$STAGE) ---"; tail -40 "$g"; }
  done
  set -e
}
on_exit() { local rc=$?; save_failure_artifacts "$rc"; return $rc; }
trap on_exit EXIT

rm -rf -- "$RUN1"
rm -f -- "$OUT1" "$TRACE1" "$SHARED_DB" "$SHARED_DB-wal" "$SHARED_DB-shm"

STAGE=L1
echo "L1: normal order under strace"
set +e
NODE_ENV=test DATABASE_URL='postgres://must-not-be-inherited.invalid/prod' COMMHUB_DB="$SHARED_DB" \
  ANET_SERVER_TEST_ROOT="$RUN1" ANET_SERVER_TEST_KEEP_ROOT=1 \
  strace -f -e trace=openat -o "$TRACE1" bun run --cwd server test >"$OUT1" 2>&1
rc1=$?
set -e
if [[ $rc1 -ne 0 ]]; then
  echo "FAIL: traced aggregate exited rc=$rc1"
  grep '^TEST_FILE_RESULT' "$OUT1" \
    | awk -F'\t' '{bad=0; for(i=1;i<=NF;i++){if($i=="timeout=true")bad=1; if($i ~ /^exit=/ && $i!="exit=0")bad=1}; if(bad)print}' || true
  grep -B30 '^(fail)' "$OUT1" || true
  exit 1
fi

STAGE=L3a
echo "L3a: inherited shared DB never opened; no DB outside per-file root"
[[ $(grep -F -c "$SHARED_DB" "$TRACE1" || true) -eq 0 ]] || { echo "FAIL: inherited shared DB was opened"; exit 1; }
outside=$(grep -oE '/tmp/[^" ]*commhub\.db' "$TRACE1" | grep -v "^$RUN1/" || true)
[[ -z "$outside" ]] || { echo "FAIL: DB opened outside per-file root: $outside"; exit 1; }
[[ ! -e "$SHARED_DB" ]] || { echo "FAIL: shared DB exists"; exit 1; }

echo "source_commit=$TEST639_SOURCE_COMMIT"
echo "traced_db_maps=$(grep -c '^TEST_DB_MAP' "$OUT1" || true)"
echo "RESULT: PASS"
