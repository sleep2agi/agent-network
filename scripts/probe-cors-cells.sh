#!/usr/bin/env bash
# CORS 回显的五格探针 —— 基准格不成立时，其余四格一律作废。
#
# 2026-10-31 —— 外部复核 ③（原话）：
#   「基准格失败不会让表变空，会让表看起来填满了。
#     基准格 Origin: https://host ⇒ 必须 401（唯一能证明『闸放开、鉴权拦下』的码）；
#     若基准格就 403 ⇒ 被测格的 403 与被测格无关 ⇒ 三格全部作废。」
#   「基准格与被测格同值时，被测格无信息——而它长得和一次成功的测量完全一样。」
#
# 本脚本把这条纪律写进退出码：
#   基准格（清单里的第一条，必须原样回显）为空 ⇒ **VOID**，exit 2，不判其余格
#   基准格成立 ⇒ 其余格各自判定，任何一条不符合预期 ⇒ exit 1
#
# 用法：
#   HUB_URL=http://127.0.0.1:9200 scripts/probe-cors-cells.sh http://localhost:3000
#   （第一个参数 = 清单里确定允许的 origin；其余格由脚本生成）
#
# 退出码：0 全格符合预期 ｜ 1 有格不符 ｜ 2 VOID（基准格不成立 / 连不上 hub）

set -uo pipefail

BASE_ORIGIN="${1:-}"
HUB_URL="${HUB_URL:-http://127.0.0.1:9200}"
[ -n "$BASE_ORIGIN" ] || { echo "用法: $0 <确定允许的 origin>   （或设置 HUB_URL）" >&2; exit 2; }

# 由基准 origin 生成「同一 origin 的不同拼写」——这些才是判定规范化是否生效的格
UPPER=$(printf '%s' "$BASE_ORIGIN" | tr '[:lower:]' '[:upper:]')
SLASH="$BASE_ORIGIN/"
FOREIGN="https://not-in-allowlist.invalid"

probe() {
  local label="$1" origin="$2"
  local hdr code
  hdr=$(mktemp) || return 2
  code=$(curl -s -o /dev/null -D "$hdr" -w '%{http_code}' --max-time 5 -H "Origin: $origin" "$HUB_URL/health" 2>/dev/null)
  local acao
  acao=$(grep -i '^access-control-allow-origin' "$hdr" 2>/dev/null | tr -d '\r' | cut -d' ' -f2-)
  rm -f "$hdr"
  printf '%s\t%s\t%s\n' "$label" "${code:-000}" "${acao:--}"
}

echo "hub=$HUB_URL  基准 origin=$BASE_ORIGIN"
RESULT=$(probe "基准（原样）" "$BASE_ORIGIN")
echo "  $RESULT"
# ── 基准格：不回显 ⇒ 后面的格全部没有意义（它们的空/满都不是关于被测性质的读数）
BASE_ACAO=$(printf '%s' "$RESULT" | cut -f3)
if [ "$BASE_ACAO" = "-" ] || [ -z "$BASE_ACAO" ]; then
  echo "VOID：基准格没有回显 Access-Control-Allow-Origin" >&2
  echo "  ⇒ 其余格作废（它们看起来会是「全部被拒」，而那不是被测机制的读数）" >&2
  exit 2
fi

fails=0
FAILED_LABELS=""
check() {
  local label="$1" origin="$2" want="$3"
  local r acao
  r=$(probe "$label" "$origin")
  acao=$(printf '%s' "$r" | cut -f3)
  local ok=0
  if [ "$want" = "echo" ] && [ "$acao" != "-" ] && [ -n "$acao" ]; then ok=1; fi
  if [ "$want" = "none" ] && { [ "$acao" = "-" ] || [ -z "$acao" ]; }; then ok=1; fi
  printf '  %-28s acao=%-32s want=%-5s %s\n' "$label" "${acao:--}" "$want" $([ $ok -eq 1 ] && echo ✓ || echo ✗)
  [ $ok -eq 1 ] || { fails=$((fails + 1)); FAILED_LABELS="${FAILED_LABELS}${FAILED_LABELS:+、}${label}"; }
}

check "大写形式（规范化）" "$UPPER" echo
check "尾斜杠（规范化）"   "$SLASH" echo
check "清单外（反例）"     "$FOREIGN" none

echo "判定：基准格成立 ⇒ 其余格有效"
[ $fails -eq 0 ] && { echo "✓ 全部符合预期"; exit 0; }

# 2026-10-31 —— 外部复核 ④：「预测落空时先说清**哪些格一起反常**，再说为什么——
# 单看一格的反常，三种成因不可分。」下面按「哪些格一起坏」分支，而不是逐格解释。
echo "✗ $fails 格不符预期（一起反常的格：$FAILED_LABELS）" >&2
NORM_BAD=0; NEG_BAD=0
case "$FAILED_LABELS" in
  *大写*|*尾斜杠*) NORM_BAD=1 ;;
esac
case "$FAILED_LABELS" in *清单外*) NEG_BAD=1 ;; esac
if [ $NORM_BAD -eq 1 ] && [ $NEG_BAD -eq 0 ]; then
  echo "  ⇒ **只有规范化那两格坏、反例是对的** ＝ 线上跑的是字符串比较那一版（不是解析后比较）" >&2
elif [ $NORM_BAD -eq 0 ] && [ $NEG_BAD -eq 1 ]; then
  echo "  ⇒ **只有反例坏** ＝ 闸放得比清单宽（清单外也被回显）；先查清单内容与是否有人加了通配" >&2
else
  echo "  ⇒ **规范化与反例一起坏** ＝ 单看这几格分不出三种成因，按这个顺序排：" >&2
  echo "     ① 源码不是线上那份（整张表不成立 —— 所有格一起反常时优先怀疑这个）" >&2
  echo "     ② 前层改写了 Origin（本份配置 grep 0 命中，但线上是另一个 ref，未验）" >&2
  echo "     ③ 读错了代码位置（侧别不对称：一侧反常另一侧正常）" >&2
fi
exit 1
