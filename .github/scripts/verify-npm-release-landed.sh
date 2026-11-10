#!/usr/bin/env bash
# 落地核实:**被请求的那个版本,到底有没有真的出现在 npm 上**。
#
# 🔴 为什么要单独一个判定(run 42731348173,agent-network 2.3.0-preview.225):
#   那次 run 的三个读数同时成立:
#     · publish 第 9 步 `npm publish --tag preview`      → **success**
#     · publish 第 10 步「发后核实(看 registry 不看退出码)」→ in_progress,挂了 22 分钟以上
#     · verdict (aggregate)                              → **success**
#   而同一时刻 `GET https://registry.npmjs.org/@sleep2agi%2Fagent-network/2.3.0-preview.225`
#   是 **404**,`dist-tags.preview` 还停在 `2.3.0-preview.224`。
#   ⇒ 读这次 run 的绿勾会得出「已发布」,而实际什么都没落地。
#   verdict 是 report-only(只看四道门、失败也 exit 0),它是**不会**替 publish 说话的;
#   「发后核实」那一步本身又是个正在跑的步骤 —— 一个 in_progress 的步骤和一次成功发布,
#   在检查列表里都不是红色的。
#
# 本脚本只回答一个问题:期望版本现在能不能在 registry 上取到。
#
# 判定三分(措辞必须能区分 —— 让人一眼看出是「发布命令失败」还是「发布了但没变可见」):
#   - 可见                                  → rc 0(tag 落后只 warning,不判红)
#   - publish job 失败 **且** 不可见         → rc 1,措辞「publish job failed and the version is not on npm」
#   - publish job 成功 **但** 预算内不可见   → rc 1,措辞「已接受但从未变可见(staged/blocked/processing)」
#   - publish job 被跳过(门红了/没勾 publish)→ rc 0,打印「无事可做」(不是「已发布」)
#
# 输入(环境变量):
#   PKG               包名(必填)
#   EXPECTED          期望版本(必填)
#   PUBLISH_RESULT    publish job 的 result:success / failure / cancelled / skipped(必填)
#   LANDED_TIMEOUT_MIN  轮询上限,分钟,默认 15
#   LANDED_TIMEOUT_S    轮询上限,秒(给了就覆盖 MIN;测试用)
#   LANDED_INTERVAL_S   两次检查间隔,秒,默认 30
#   NPM_REGISTRY_URL    默认 https://registry.npmjs.org
#
# 退出码:0 = 可见(或无事可做)｜ 1 = 不可见(publish 失败 / 接受后没变可见)｜ 2 = 用法错误
#
# 🔴 读的是 registry 本身(curl),不是 `npm view` —— 后者读 CDN 缓存,
#    2026-08-27 agent-network@2.3.0-preview.48 就因此误判过一次。
#
# 🔴 判「可见」用**版本清单的 version 字段**,不是只看 HTTP 200:
#    一个 200 的 HTML 拦截页/代理错误页也能是 200,而那证明不了版本存在。
#    EXPECTED 在上面已经强制非空,所以这里不可能退化成「空 == 空」的假绿。
set -euo pipefail

# 用法错误一律 rc 2 —— 不能和 rc 1(「结论是不可见」)混成一个数:
# 一个缺参数的调用和一个真的没落地的发布,在 CI 上都会红,但修法完全不同。
usage_error() { echo "::error::$1" >&2; exit 2; }
[ -n "${PKG:-}" ] || usage_error 'PKG 必填'
[ -n "${EXPECTED:-}" ] || usage_error 'EXPECTED 必填'
[ -n "${PUBLISH_RESULT:-}" ] || usage_error 'PUBLISH_RESULT 必填(publish job 的 result:success/failure/cancelled/skipped)'
# 本仓发布的包全是 @sleep2agi/… 作用域包。短名(`agent-network`)拼出的 URL 恒 404,
# 会让一次已落地的发布等满预算后被判「没落地」(run 42743119409)—— 那是调用方传错,不是结论。
case "$PKG" in
  @*/*) ;;
  *) usage_error "PKG='$PKG' 不是作用域包名(@scope/name)—— 传的多半是目录短名,registry 上查不到" ;;
esac

registry="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
interval="${LANDED_INTERVAL_S:-30}"
timeout_min="${LANDED_TIMEOUT_MIN:-15}"
timeout_s="${LANDED_TIMEOUT_S:-$((timeout_min * 60))}"

case "$PUBLISH_RESULT" in
  success|failure|cancelled|skipped) ;;
  *) usage_error "PUBLISH_RESULT='$PUBLISH_RESULT' 不是 success/failure/cancelled/skipped 之一 —— 判据来源坏了,拒绝给结论" ;;
esac

# publish 被跳过 = 这次 run 本来就不该发东西(门红了,或 dispatch 没勾 publish)。
# 此时「版本不在 npm 上」是**正确状态**,判绿;但文案必须说清是「无事可做」。
if [ "$PUBLISH_RESULT" = skipped ]; then
  echo "跳过:publish job 的结果是 skipped —— 这次 run 没有安排发布(门红 / 未勾 publish),没有需要核实的版本。"
  echo "注意:这里的 rc 0 是「无事可做」,不是「已发布」。"
  exit 0
fi

# 包名里的 `/` 必须转义成 %2F,@ 可以留着。按 registry 文档路径拼 URL,
# 而不是把 `@scope/name` 直接塞进路径 —— 后者依赖服务端的宽容,不是契约。
enc=${PKG//\//%2F}
ver_url="$registry/$enc/$EXPECTED"
pack_url="$registry/$enc"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# http_get <url> <outfile> → 打印 HTTP 状态码;传输层失败打印 000(当成「还没看到」继续轮询)
http_get() {
  local code
  code=$(curl -sS -o "$2" -w '%{http_code}' --max-time 20 -H 'Cache-Control: no-cache' "$1" 2>/dev/null) || code=000
  printf '%s' "$code"
}

# 版本清单 → 它的 version 字段(解析不了打印空)
parse_version() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let v="";
    try { v=JSON.parse(s).version||""; } catch {}
    console.log(v);
  });'
}

# 整包清单 → dist-tags.preview(解析不了打印空)
parse_preview_tag() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let t="";
    try { t=((JSON.parse(s)["dist-tags"])||{}).preview||""; } catch {}
    console.log(t);
  });'
}

echo "核实 $PKG@$EXPECTED 是否真的在 npm 上可见(publish job result=$PUBLISH_RESULT);最长等 ${timeout_s}s,每 ${interval}s 查一次"
echo "读的是 registry 本身:$ver_url"

start=$SECONDS
attempt=0
visible=0
seen_version=""
code=""
while :; do
  attempt=$((attempt + 1))
  code=$(http_get "$ver_url" "$tmp/version.json")
  if [ "$code" = 200 ]; then
    seen_version=$(parse_version < "$tmp/version.json")
    if [ "$seen_version" = "$EXPECTED" ]; then visible=1; fi
  fi
  elapsed=$((SECONDS - start))
  echo "attempt $attempt (+${elapsed}s): GET → HTTP $code,version=${seen_version:-<读不到>}"
  [ "$visible" = 1 ] && break
  [ "$elapsed" -ge "$timeout_s" ] && break
  sleep "$interval"
done

# ── 判 1:可见 → 通过。tag 是**次要件**(tag 会滞后,可见性才是这次要断言的事实) ──
if [ "$visible" = 1 ]; then
  elapsed=$((SECONDS - start))
  echo "✅ 已落地:$PKG@$EXPECTED 在 registry 上可见(第 $attempt 次,用时 ${elapsed}s)"
  tag=""
  if [ "$(http_get "$pack_url" "$tmp/packument.json")" = 200 ]; then
    tag=$(parse_preview_tag < "$tmp/packument.json")
  fi
  if [ "$tag" = "$EXPECTED" ]; then
    echo "dist-tags.preview = $tag(与期望一致)"
  else
    echo "::warning::dist-tags.preview 目前是 ${tag:-<读不到>},不是 $EXPECTED —— tag 会滞后于可见性,不判红。稍后核对:npm view $PKG dist-tags.preview"
  fi
  exit 0
fi

# ── 判 2:publish job 没成功,而版本也确实不在 → 这是「发布失败」 ──
if [ "$PUBLISH_RESULT" != success ]; then
  echo "::error::publish job failed and the version is not on npm —— publish job result=$PUBLISH_RESULT,等了 ${timeout_s}s 后 registry 上仍取不到 $PKG@$EXPECTED(期望 HTTP 200 + version=$EXPECTED,最后一次 HTTP $code)"
  echo "这条结论是:publish 这一步没成功,所以 npm 上没有这个版本。"
  echo "先看 publish job 的日志(认证 / 门 / 版本号已存在),修好后**换一个版本号**再发。"
  exit 1
fi

# ── 判 3:publish job 成功,版本却始终不可见 → 「接受 ≠ 可见」,不能说成命令失败 ──
echo "::error::npm 已接受这次发布,但版本在 ${timeout_s}s 内始终没有变成可见(npm accepted the publish but the version never became visible):staged / blocked / processing"
echo "publish 步骤返回的是 success,所以这句不是「发布命令失败」—— 它说的是「npm 收下了,但没让它变可见」。"
echo "provenance 发布历史上最长约 6 小时后才可见;也可能是 staged(等 2FA/审批)或被打回。"
echo "稍后用下面的命令核对(应打印 $EXPECTED):"
echo "    npm view $PKG@$EXPECTED version"
echo "    npm view $PKG dist-tags.preview"
echo "🔴 不要重发同一个版本号 —— npm 会回 E409 previously staged,还会白白烧掉这个号。"
exit 1
