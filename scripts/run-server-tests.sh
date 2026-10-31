#!/usr/bin/env bash
# 逐文件跑 server 测试 —— 一个文件一个 bun 进程、一个全新 DB。
#
# 2026-10-31 —— 两件事同时促成的：
#   ① 外部复核（原话）：「我跑 bun test 全量：880 pass / 812 fail —— 那是**夹具假象**。
#      本仓 L0 按文件逐个跑（每文件一个新 DB）；单进程会让一个测试关掉共享 db，连锁 812 条。
#      按正确方式重跑改动面 5 个文件：93 pass / 0 fail。」
#      ⇒ 「我跑过了」也需要前提：**用哪个仪器跑的**。
#   ② 本仓同款纪律（记忆里一直有）：`COMMHUB_DB=/tmp/xxx.db`，且 L0 必须按文件逐个跑 ——
#      多文件同进程会 800+ 连锁假失败。但它一直只是「记得」，没有一条命令替你执行。
#
# 用法：
#   scripts/run-server-tests.sh                  # 跑 server/src 下全部 *.test.ts
#   scripts/run-server-tests.sh etag-of redact   # 只跑文件名匹配这些片段的
#
# 输出：每个文件一行（PASS/FAIL + 通过数），最后一行汇总。
# 退出码：0 全过 ｜ 1 有文件失败 ｜ 2 没有匹配到文件（没有读数）。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 2026-10-31 —— `--pkg <name>`：同一个隔离纪律（每文件一个进程、一个全新 DB、守恒式）
# 也需要用在别的包上。agent-node 今天就有本地红，而没有逐文件读数时，
# 「3 条失败」既可能是 3 个缺陷，也可能是一次共享状态污染。
# 只认 packages 下真实存在的目录，拼错就报错 —— 不猜。
PKG="server"
PATTERNS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG="${2:-}"; shift 2 ;;
    *) PATTERNS+=("$1"); shift ;;
  esac
done
SERVER="$ROOT/$PKG"

if [ ! -d "$SERVER/src" ]; then
  echo "✗ 找不到 $SERVER/src（--pkg=$PKG）⇒ 没有读数，不是「全过」" >&2
  exit 2
fi

mapfile -t FILES < <(
  cd "$SERVER" && ls src/*.test.ts src/**/*.test.ts 2>/dev/null | sort -u | while read -r f; do
    if [ ${#PATTERNS[@]} -eq 0 ]; then echo "$f"; continue; fi
    for p in "${PATTERNS[@]}"; do case "$f" in *"$p"*) echo "$f"; break ;; esac; done
  done
)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "没有匹配到测试文件（没有读数，不是「全过」）" >&2
  exit 2
fi

pass=0; fail=0; failed_list=""
for f in "${FILES[@]}"; do
  db="$(mktemp -u "/tmp/anet-pertest-XXXXXX.db")"
  out=$(cd "$SERVER" && COMMHUB_DB="$db" timeout 600 bun test "$f" 2>&1)
  rc=$?
  rm -f "$db"
  n=$(printf '%s' "$out" | grep -cE '^ *[0-9]+ pass$' || true)
  line=$(printf '%s' "$out" | grep -E '^ *[0-9]+ (pass|fail)$' | tr '\n' ' ')
  if [ $rc -eq 0 ]; then
    pass=$((pass + 1))
    printf 'PASS %-56s %s\n' "$f" "$line"
  else
    fail=$((fail + 1))
    failed_list="$failed_list $f"
    printf 'FAIL %-56s %s\n' "$f" "$line"
    # 2026-10-31 —— **失败按根因归并**（外部复核：「812 不是 812 个缺陷，
    # 它是一次没有归并的输出；按条排队修它，永远修不完」）。
    # 这里只对**失败的文件**做归并输出，且不吞掉原输出（前 5 条仍在下面）。
    printf '%s\n' "$out" | python3 "$ROOT/scripts/summarize-test-failures.py" 2>/dev/null \
      | sed 's/^/      /' | head -6
    printf '%s\n' "$out" | grep -E '\(fail\)' | head -5 | sed 's/^/      /'
  fi
  : "${n:=0}"
done

echo
# 2026-10-31 —— 守恒式，不是「两个数相等」（外部复核 (b)：
#   「那条等式在两个分支**真假相反**，不是不变量。改成守恒式
#    `EXECUTED_L1 + SKIP_L1 == grep -c …`，还能抓『写在嵌套 if 里、既没执行也没登记』的行。」）
# 这里对应的是：**列出来的文件数 == PASS + FAIL**。
# 少一个文件不会报错，只会让汇总看起来更小 —— 而「更小」读起来像「更少失败」。
TOTAL=${#FILES[@]}
if [ $((pass + fail)) -ne "$TOTAL" ]; then
  echo "✗ 守恒式不成立：列出 $TOTAL 个文件，但只统计到 PASS=$pass FAIL=$fail" >&2
  echo "  ⇒ 有文件既没记 PASS 也没记 FAIL（跑到一半退出 / 被 timeout 杀掉）——这是**没有读数**，不是通过" >&2
  exit 2
fi

echo "逐文件结果：PASS=$pass FAIL=$fail ｜ 列出 $TOTAL ｜ 守恒 $((pass + fail))==$TOTAL（每个文件独立 DB 与进程）"
if [ $fail -ne 0 ]; then
  echo "  ⇒ 失败文件：$failed_list" >&2
  exit 1
fi
