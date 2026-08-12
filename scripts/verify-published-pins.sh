#!/usr/bin/env bash
# 核对「已发布产物里的 pin」是否等于「当前源码里的 pin」。
#
# 为什么需要它:2026-08-13 一天之内,「main 已修 ≠ 用户装到的包已修」这个区分
# 咬了三次 —— 两次是写文档/报 issue 时把 main 的状态当成现状,一次是一个 pin
# 修复合进了 main、但已发布的 preview 包里仍是旧值,而 issue 已按「fixed」收口。
# 靠人记住不够,做成可复跑的检查。
#
# 用法:  scripts/verify-published-pins.sh [dist-tag]     # 默认 preview
# 退出码:0=一致  1=有不一致  2=无法取得产物  3=零覆盖(没找到任何可核对的 pin)
set -uo pipefail

TAG="${1:-preview}"
PKG="@sleep2agi/agent-network"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 🔴 只采信**阳性命中**。已发布的 dist/cli.js 是 minified 的,字符串不可靠;
#    但 dist/**/*.d.ts 保留完整字面量 —— 实测就是在那里找到旧 pin 的。
#    所以下面只在 .d.ts 与 package.json 里比对,并在找不到任何可核对项时
#    以 exit 3 结束,而不是打印一行「一致」。
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "== 取已发布产物: ${PKG}@${TAG} =="
( cd "$WORK" && npm pack "${PKG}@${TAG}" >/dev/null 2>&1 ) || { echo "::error::npm pack 失败,无法取得 ${PKG}@${TAG}"; exit 2; }
( cd "$WORK" && tar xzf ./*.tgz ) || { echo "::error::解包失败"; exit 2; }
PUB="$WORK/package"
PUB_VER="$(node -p "require('$PUB/package.json').version" 2>/dev/null || echo '?')"
echo "   已发布版本: $PUB_VER"

# 源码侧的 pin —— 从源文件抽,不手写清单
declare -A SRC=()
while IFS='=' read -r k v; do [ -n "${k:-}" ] && SRC["$k"]="$v"; done < <(
  { grep -hoE 'const PINNED_[A-Z_]+ *= *"[^"]+"' "$ROOT/agent-network/bin/cli.ts" 2>/dev/null
    grep -hoE 'const OPENCODE_[A-Z_]*VERSION *= *"[^"]+"' "$ROOT/agent-network/src/opencode-agent-node-pair.ts" 2>/dev/null
  } | sed -E 's/const ([A-Z_]+) *= *"([^"]+)"/\1=\2/'
)

checked=0; bad=0
# 🔴 先判零覆盖,再进循环。否则空数组会在 set -u 下抛 unbound variable ——
#    退出码碰巧也是非零,但那是 bash 的错误、不是本脚本的判断,
#    「结果对、机制错」的检查下次改动就会失效。
if [ "${#SRC[@]}" -eq 0 ]; then
  echo "== 核对了 0 个 pin(源码侧共 0 个)=="
  echo "::error::零覆盖 —— 源码里一个 pin 都没抽到(文件路径变了?)。拒绝通过。"
  exit 3
fi
for k in "${!SRC[@]}"; do
  want="${SRC[$k]}"
  # 在 .d.ts / package.json 里找该常量对应的字面量
  if grep -rqF -- "$want" "$PUB"/dist 2>/dev/null || grep -qF -- "$want" "$PUB/package.json" 2>/dev/null; then
    checked=$((checked+1)); echo "   ✅ $k = $want  (已发布产物里能找到)"
  else
    # 🔴 阴性不可靠,不能直接判不一致。只有当**这个常量本身**出现在产物里、
    #    而它旁边的版本值与源码不同时,才算证据确凿。
    #    (先前一版拿「产物里任意版本字面量」做对比,把 PINNED_SERVER_VERSION
    #     误判成不一致 —— 那两个值其实是 opencode 配对的,跟它无关。)
    hit="$(grep -rhoE "${k}[^0-9]{0,40}[0-9]+\.[0-9]+\.[0-9]+[0-9a-zA-Z.-]*" "$PUB"/dist 2>/dev/null | head -1)"
    if [ -z "$hit" ]; then
      # 该常量在产物里以别名/内联形式存在时,退而用「它所 pin 的包名@版本」找
      case "$k" in
        OPENCODE_AGENT_NODE_VERSION) hit="$(grep -rhoE 'agent-node@[0-9][0-9a-zA-Z.-]*' "$PUB"/dist 2>/dev/null | head -1)";;
        PINNED_SERVER_VERSION)       hit="$(grep -rhoE 'commhub-server@[0-9][0-9a-zA-Z.-]*' "$PUB"/dist 2>/dev/null | head -1)";;
      esac
    fi
    if [ -n "$hit" ]; then
      checked=$((checked+1)); bad=$((bad+1))
      echo "   ❌ $k 期望 $want,产物里是: $hit"
    else
      echo "   ⚠️  $k 无法判定 —— 产物里找不到这个常量(minified 后不保留),阴性结论不采信"
    fi
  fi
done

echo "== 核对了 $checked 个 pin(源码侧共 ${#SRC[@]} 个)=="
if [ "$checked" -eq 0 ]; then
  echo "::error::零覆盖 —— 一个 pin 都没核对到。零覆盖的检查与坏掉的检查无法区分,拒绝通过。"
  exit 3
fi
[ "$bad" -eq 0 ] || { echo "::error::$bad 个 pin 与已发布产物不一致 —— main 修了但用户装到的包没修"; exit 1; }
echo "✅ 已发布产物与源码 pin 一致($checked/${#SRC[@]})"
